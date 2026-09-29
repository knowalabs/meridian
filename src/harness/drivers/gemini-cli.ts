import { CLI_DEFAULT_MODEL } from '../../providers/router.js';
import type { FileChange, HarnessEventBody, ToolKind } from '../events.js';
import {
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

const EDIT_TOOLS: Record<string, FileChange> = {
  write_file: 'unknown',
  replace: 'update',
  edit: 'update',
};

function kindOf(name: string): ToolKind {
  if (name in EDIT_TOOLS) return 'edit';
  if (name === 'run_shell_command') return 'shell';
  if (/^read_(many_)?files?$/.test(name)) return 'read';
  if (/^(glob|search_file_content|list_directory|grep)$/.test(name)) return 'search';
  if (/^(web_fetch|google_web_search)$/.test(name)) return 'web';
  return 'other';
}

const fileOf = (params: Record<string, unknown>): string | undefined =>
  str(params.file_path) ?? str(params.absolute_path) ?? str(params.path);

/**
 * Gemini CLI over `gemini --output-format stream-json`. The prompt travels in
 * `-p` because stream-json with a stdin-only prompt is not a documented
 * combination. Headless `--approval-mode plan` is never used: when a headless
 * plan session exits plan mode it continues in YOLO, which would turn a
 * read-only request into an unrestricted one. `default` is read-only in
 * practice, since nobody can answer its prompts and they become denials.
 */
export const geminiCliDriver: Driver = {
  providerId: 'gemini-cli',
  // Written against gemini-cli's documented stream-json schema; no install has been recorded yet.
  minVersion: null,
  testedVersion: null,
  promptOnStdin: false,

  args(turn: DriverTurn): string[] {
    const args = ['--output-format', 'stream-json'];
    if (turn.model !== CLI_DEFAULT_MODEL) args.push('-m', turn.model);
    const { mode, allowCommands } = turn.policy;
    if (mode === 'auto') args.push('--approval-mode', 'yolo');
    else if (mode === 'edit') {
      args.push('--approval-mode', 'auto_edit');
      // Gemini matches shell rules by command prefix, so exact and prefix rules read the same.
      for (const prefix of new Set(allowCommands.map((c) => c.prefix))) {
        args.push('--allowed-tools', `run_shell_command(${prefix})`);
      }
    } else args.push('--approval-mode', 'default');
    if (turn.resume) args.push('--resume', turn.resume);
    args.push('-p', turn.prompt);
    return args;
  },

  warning(turn) {
    return turn.policy.mode === 'auto'
      ? 'gemini-cli in auto mode runs every tool without a sandbox or approval (--approval-mode yolo).'
      : null;
  },

  createParser(turn: DriverTurn): LineParser {
    let sessionId: string | null = turn.resume ?? null;
    let result: Record<string, unknown> | null = null;
    let lastError: string | null = null;
    let buffered = '';
    const pending = new Map<string, { name: string; params: Record<string, unknown> }>();

    // Deltas already reached the screen; the whole message is recorded once it ends.
    const flush = (out: HarnessEventBody[]): void => {
      if (buffered) out.push({ type: 'text', text: buffered, streamed: true });
      buffered = '';
    };

    return {
      push(line) {
        const msg = parseLine(line);
        if (!msg) return [];
        const out: HarnessEventBody[] = [];
        const type = str(msg.type);
        if (type === 'init') {
          sessionId = str(msg.session_id) ?? sessionId;
        } else if (type === 'message' && msg.role === 'assistant') {
          const text = str(msg.content) ?? '';
          if (msg.delta === true) {
            buffered += text;
            if (text) out.push({ type: 'text.delta', text });
          } else if (text) {
            flush(out);
            out.push({ type: 'text', text, streamed: false });
          }
        } else if (type === 'tool_use') {
          flush(out);
          const id = str(msg.tool_id) ?? `tool-${pending.size}`;
          const name = str(msg.tool_name) ?? 'tool';
          const params = obj(msg.parameters);
          pending.set(id, { name, params });
          const file = fileOf(params);
          const title =
            name === 'run_shell_command'
              ? (str(params.command) ?? name)
              : file
                ? `${name} ${projectPath(turn.cwd, file)}`
                : name;
          out.push({
            type: 'tool.started',
            toolId: id,
            name,
            kind: kindOf(name),
            title,
            input: params,
          });
        } else if (type === 'tool_result') {
          const id = str(msg.tool_id) ?? '';
          const ok = str(msg.status) === 'success';
          const error = obj(msg.error);
          const errorText = [str(error.type), str(error.message)].filter(Boolean).join(': ');
          out.push({
            type: 'tool.completed',
            toolId: id,
            ok,
            output: str(msg.output) ?? errorText,
          });
          const tool = pending.get(id);
          const file = tool && fileOf(tool.params);
          if (ok && tool && file && tool.name in EDIT_TOOLS) {
            out.push({
              type: 'file.changed',
              path: projectPath(turn.cwd, file),
              change: EDIT_TOOLS[tool.name]!,
              source: 'driver',
            });
          }
          if (!ok && /denied|permission|not allowed|approval/i.test(errorText)) {
            out.push({
              type: 'permission.denied',
              tool: tool?.name ?? 'tool',
              ...(tool ? { input: tool.params } : {}),
              reason: errorText,
            });
          }
        } else if (type === 'error') {
          if (str(msg.severity) !== 'warning') lastError = str(msg.message) ?? lastError;
        } else if (type === 'result') {
          flush(out);
          result = msg;
          const stats = obj(msg.stats);
          out.push({
            type: 'usage',
            turn: turn.turn,
            ...(num(stats.input_tokens) !== undefined
              ? { inputTokens: num(stats.input_tokens)! }
              : {}),
            ...(num(stats.output_tokens) !== undefined
              ? { outputTokens: num(stats.output_tokens)! }
              : {}),
            ...(num(stats.cached) !== undefined ? { cachedInputTokens: num(stats.cached)! } : {}),
          });
        }
        return out;
      },

      finish(res) {
        const succeeded = result !== null && str(result.status) === 'success';
        const ok = res.ok && succeeded;
        return {
          ok,
          driverSessionId: sessionId,
          stopReason: result ? (str(result.status) ?? 'unknown') : 'no-result',
          ...(ok
            ? {}
            : {
                error:
                  str(obj(result?.error).message) ??
                  lastError ??
                  stderrTail(res, 'gemini exited without reporting a result'),
              }),
        };
      },
    };
  },
};
