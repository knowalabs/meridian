import { CLI_DEFAULT_MODEL } from '../../providers/router.js';
import type { FileChange, HarnessEventBody } from '../events.js';
import {
  arr,
  num,
  obj,
  parseLine,
  projectPath,
  stderrTail,
  str,
  type Driver,
  type DriverTurn,
  type LineParser,
} from './types.js';

const SANDBOX = { plan: 'read-only', edit: 'workspace-write', auto: 'workspace-write' } as const;

/** Codex wraps every command in a login shell; the title shows what was actually asked for. */
function unwrapShell(command: string): string {
  const inner = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return inner ? inner[2]! : command;
}

function commandOf(item: Record<string, unknown>): string {
  const cmd = item.command;
  if (Array.isArray(cmd)) return unwrapShell(cmd.map(String).join(' '));
  return unwrapShell(str(cmd) ?? 'command');
}

function changeOf(kind: string | undefined): FileChange {
  return kind === 'add' || kind === 'delete' || kind === 'update' ? kind : 'unknown';
}

/**
 * Codex over `codex exec --json`. Codex has no per-command allow-list in exec
 * mode, so `edit` relies on its workspace-write sandbox (no network) instead
 * of the kit's rules; a sandbox block surfaces as a failed command, never as a
 * denial event. `--skip-git-repo-check` is passed only in read-only plan mode:
 * an agent that edits outside version control leaves nothing to review.
 */
export const codexCliDriver: Driver = {
  providerId: 'codex-cli',
  minVersion: '0.100.0',
  testedVersion: '0.142.4',
  promptOnStdin: true,

  args(turn: DriverTurn): string[] {
    const { mode } = turn.policy;
    const network =
      mode === 'auto' ? ['-c', 'sandbox_workspace_write.network_access=true'] : ([] as string[]);
    const model = turn.model !== CLI_DEFAULT_MODEL ? ['-m', turn.model] : [];
    if (turn.resume) {
      // `exec resume` takes no -s, -C or --color; the sandbox goes through config.
      return [
        'exec',
        'resume',
        '--json',
        '-c',
        `sandbox_mode="${SANDBOX[mode]}"`,
        ...network,
        ...model,
        ...(mode === 'plan' ? ['--skip-git-repo-check'] : []),
        turn.resume,
        '-',
      ];
    }
    return [
      'exec',
      '--json',
      '--color',
      'never',
      '-s',
      SANDBOX[mode],
      ...network,
      ...model,
      ...(mode === 'plan' ? ['--skip-git-repo-check'] : []),
      '-',
    ];
  },

  createParser(turn: DriverTurn): LineParser {
    let threadId: string | null = turn.resume ?? null;
    let completed = false;
    let failure: string | null = null;
    let lastError: string | null = null;
    const started = new Set<string>();

    return {
      push(line) {
        const msg = parseLine(line);
        if (!msg) return [];
        const out: HarnessEventBody[] = [];
        const type = str(msg.type);
        if (type === 'thread.started') {
          threadId = str(msg.thread_id) ?? threadId;
        } else if (type === 'turn.completed') {
          completed = true;
          const usage = obj(msg.usage);
          out.push({
            type: 'usage',
            turn: turn.turn,
            ...(num(usage.input_tokens) !== undefined
              ? { inputTokens: num(usage.input_tokens)! }
              : {}),
            ...(num(usage.output_tokens) !== undefined
              ? { outputTokens: num(usage.output_tokens)! }
              : {}),
            ...(num(usage.cached_input_tokens) !== undefined
              ? { cachedInputTokens: num(usage.cached_input_tokens)! }
              : {}),
          });
        } else if (type === 'turn.failed') {
          failure = str(obj(msg.error).message) ?? 'codex reported a failed turn';
        } else if (type === 'error') {
          // "Reconnecting... 2/5" is Codex retrying on its own; only the last word counts.
          lastError = str(msg.message) ?? lastError;
        } else if (type === 'item.started' || type === 'item.completed') {
          const item = obj(msg.item);
          const id = str(item.id) ?? `item-${started.size}`;
          const itemType = str(item.type);
          const start = (
            body: Omit<Extract<HarnessEventBody, { type: 'tool.started' }>, 'type' | 'toolId'>,
          ): void => {
            if (started.has(id)) return;
            started.add(id);
            out.push({ type: 'tool.started', toolId: id, ...body });
          };
          if (itemType === 'command_execution') {
            const command = commandOf(item);
            start({ name: 'shell', kind: 'shell', title: command, input: { command } });
            if (type === 'item.completed') {
              const exitCode = num(item.exit_code);
              out.push({
                type: 'tool.completed',
                toolId: id,
                ok: exitCode === 0 && str(item.status) !== 'failed',
                ...(exitCode !== undefined ? { exitCode } : {}),
                output: str(item.aggregated_output) ?? '',
              });
            }
          } else if (itemType === 'mcp_tool_call') {
            const title = `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`;
            start({ name: title, kind: 'mcp', title, input: item.arguments });
            if (type === 'item.completed') {
              out.push({
                type: 'tool.completed',
                toolId: id,
                ok: !item.error && str(item.status) !== 'failed',
              });
            }
          } else if (itemType === 'web_search') {
            const query = str(item.query) ?? '';
            start({ name: 'web_search', kind: 'web', title: `Search ${query}`.trim() });
            if (type === 'item.completed')
              out.push({ type: 'tool.completed', toolId: id, ok: true });
          } else if (itemType === 'file_change' && type === 'item.completed') {
            const changes = arr(item.changes).map(obj);
            const paths = changes.map((c) => projectPath(turn.cwd, str(c.path) ?? ''));
            start({ name: 'apply_patch', kind: 'edit', title: `Edit ${paths.join(', ')}` });
            const ok = str(item.status) !== 'failed';
            out.push({ type: 'tool.completed', toolId: id, ok });
            if (ok) {
              changes.forEach((c, i) =>
                out.push({
                  type: 'file.changed',
                  path: paths[i]!,
                  change: changeOf(str(c.kind)),
                  source: 'driver',
                }),
              );
            }
          } else if (itemType === 'agent_message' && type === 'item.completed') {
            const text = str(item.text);
            if (text) out.push({ type: 'text', text, streamed: false });
          }
        }
        return out;
      },

      finish(res) {
        const ok = res.ok && completed && !failure;
        return {
          ok,
          driverSessionId: threadId,
          stopReason: ok ? 'completed' : 'failed',
          ...(ok
            ? {}
            : {
                error:
                  failure ??
                  lastError ??
                  stderrTail(res, 'codex exited without finishing the turn'),
              }),
        };
      },
    };
  },
};
