import { CLI_DEFAULT_MODEL } from '../../providers/router.js';
import type { FileChange, HarnessEventBody, ToolKind } from '../events.js';
import {
  arr,
  num,
  obj,
  outputText,
  parseLine,
  projectPath,
  stderrTail,
  str,
  versionAtLeast,
  type Driver,
  type DriverTurn,
  type LineParser,
} from './types.js';

/** `--permission-prompts none` arrived here; older releases already deny unanswerable prompts under -p. */
const PERMISSION_PROMPTS_SINCE = '2.1.259';

const EDIT_TOOLS: Record<string, FileChange> = {
  Write: 'unknown',
  Edit: 'update',
  MultiEdit: 'update',
  NotebookEdit: 'update',
};

function kindOf(name: string): ToolKind {
  if (name in EDIT_TOOLS) return 'edit';
  if (/^(Bash|BashOutput|PowerShell|KillShell)$/.test(name)) return 'shell';
  if (name === 'Read') return 'read';
  if (/^(Glob|Grep|LS)$/.test(name)) return 'search';
  if (/^Web(Fetch|Search)$/.test(name)) return 'web';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function titleOf(name: string, input: Record<string, unknown>, cwd: string): string {
  const file = str(input.file_path) ?? str(input.notebook_path);
  if (name === 'Bash' || name === 'PowerShell') return str(input.command) ?? name;
  if (file) return `${name} ${projectPath(cwd, file)}`;
  const detail = str(input.pattern) ?? str(input.url) ?? str(input.query) ?? str(input.description);
  return detail ? `${name} ${detail}` : name;
}

/**
 * Claude Code over `claude -p --output-format stream-json`. Kit rules in
 * `.claude/settings.json` load natively; the flags below only narrow them to
 * the session's mode. No mode ever passes bypassPermissions.
 */
export const claudeCodeDriver: Driver = {
  providerId: 'claude-code',
  minVersion: '2.1.0',
  testedVersion: '2.1.280',
  promptOnStdin: true,

  args(turn: DriverTurn): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (turn.model !== CLI_DEFAULT_MODEL) args.push('--model', turn.model);
    const { mode, allowCommands } = turn.policy;
    if (mode === 'plan') args.push('--permission-mode', 'plan');
    else if (mode === 'auto') args.push('--permission-mode', 'auto');
    else args.push('--permission-mode', 'acceptEdits');
    if (versionAtLeast(turn.cliVersion, PERMISSION_PROMPTS_SINCE)) {
      args.push('--permission-prompts', 'none');
    }
    if (turn.resume) args.push('--resume', turn.resume);
    else if (turn.newSessionId) args.push('--session-id', turn.newSessionId);
    // Variadic, so it goes last: nothing after it may be read as another rule.
    if (mode === 'edit' && allowCommands.length) {
      args.push(
        '--allowedTools',
        ...allowCommands.map((c) => (c.exact ? `Bash(${c.prefix})` : `Bash(${c.prefix}:*)`)),
      );
    }
    return args;
  },

  createParser(turn: DriverTurn): LineParser {
    let sessionId: string | null = turn.resume ?? turn.newSessionId ?? null;
    let result: Record<string, unknown> | null = null;
    let streamedText = false;
    const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
    const denied = new Set<string>();

    return {
      push(line) {
        const msg = parseLine(line);
        if (!msg) return [];
        const out: HarnessEventBody[] = [];
        const type = str(msg.type);
        const sid = str(msg.session_id);
        if (sid) sessionId = sid;
        // A subagent's own chatter is its business; its effects still reach
        // the working tree, where the snapshot sees them.
        const topLevel = msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined;

        if (type === 'stream_event' && topLevel) {
          const delta = obj(obj(msg.event).delta);
          if (str(delta.type) === 'text_delta' && str(delta.text)) {
            streamedText = true;
            out.push({ type: 'text.delta', text: str(delta.text)! });
          }
        } else if (type === 'assistant' && topLevel) {
          for (const block of arr(obj(msg.message).content).map(obj)) {
            if (block.type === 'text' && str(block.text)) {
              out.push({ type: 'text', text: str(block.text)!, streamed: streamedText });
              streamedText = false;
            } else if (block.type === 'tool_use') {
              const id = str(block.id) ?? `tool-${pending.size}`;
              const name = str(block.name) ?? 'tool';
              const input = obj(block.input);
              pending.set(id, { name, input });
              out.push({
                type: 'tool.started',
                toolId: id,
                name,
                kind: kindOf(name),
                title: titleOf(name, input, turn.cwd),
                input,
              });
            }
          }
        } else if (type === 'user' && topLevel) {
          for (const block of arr(obj(msg.message).content).map(obj)) {
            if (block.type !== 'tool_result') continue;
            const id = str(block.tool_use_id) ?? '';
            const ok = block.is_error !== true;
            out.push({ type: 'tool.completed', toolId: id, ok, output: outputText(block.content) });
            const tool = pending.get(id);
            const file = tool && (str(tool.input.file_path) ?? str(tool.input.notebook_path));
            if (ok && tool && file && tool.name in EDIT_TOOLS) {
              out.push({
                type: 'file.changed',
                path: projectPath(turn.cwd, file),
                change: EDIT_TOOLS[tool.name]!,
                source: 'driver',
              });
            }
          }
        } else if (type === 'system' && msg.subtype === 'permission_denied') {
          const id = str(msg.tool_use_id);
          if (id) denied.add(id);
          const reason = str(msg.decision_reason);
          out.push({
            type: 'permission.denied',
            tool: str(msg.tool_name) ?? 'tool',
            ...(id && pending.get(id) ? { input: pending.get(id)!.input } : {}),
            ...(reason ? { reason } : {}),
          });
        } else if (type === 'result') {
          result = msg;
          // Older releases report denials only here, in the final summary.
          for (const denial of arr(msg.permission_denials).map(obj)) {
            const id = str(denial.tool_use_id);
            if (id && denied.has(id)) continue;
            out.push({
              type: 'permission.denied',
              tool: str(denial.tool_name) ?? 'tool',
              input: denial.tool_input,
            });
          }
          const usage = obj(msg.usage);
          const total = num(msg.total_cost_usd);
          const input =
            (num(usage.input_tokens) ?? 0) +
            (num(usage.cache_creation_input_tokens) ?? 0) +
            (num(usage.cache_read_input_tokens) ?? 0);
          out.push({
            type: 'usage',
            turn: turn.turn,
            inputTokens: input,
            ...(num(usage.output_tokens) !== undefined
              ? { outputTokens: num(usage.output_tokens)! }
              : {}),
            ...(num(usage.cache_read_input_tokens) !== undefined
              ? { cachedInputTokens: num(usage.cache_read_input_tokens)! }
              : {}),
            // total_cost_usd is a running total across --resume, not this turn's cost.
            ...(total !== undefined ? { costUsd: Math.max(0, total - turn.priorCostUsd) } : {}),
          });
        }
        return out;
      },

      finish(res) {
        if (!result) {
          return {
            ok: false,
            driverSessionId: sessionId,
            error: stderrTail(res, 'claude exited without reporting a result'),
          };
        }
        const failed = result.is_error === true || str(result.subtype) !== 'success';
        const total = num(result.total_cost_usd);
        return {
          ok: res.ok && !failed,
          driverSessionId: sessionId,
          stopReason: str(result.subtype) ?? str(result.stop_reason) ?? 'unknown',
          ...(total !== undefined ? { cumulativeCostUsd: total } : {}),
          ...(failed
            ? {
                error:
                  str(result.result) ?? `claude ended with ${str(result.subtype) ?? 'an error'}`,
              }
            : {}),
        };
      },
    };
  },
};
