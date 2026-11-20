/**
 * Token saver: keeps what a task sends to the model small without changing what it means.
 *
 * - Tool results: logs and test output lose colour codes, progress redraws, repeated lines, passing
 *   tests and deep stack frames; what is left keeps every error, failure and warning line with a
 *   little context, plus the start and the end. JSON loses its indentation. The full text is kept
 *   on disk and the model can read it again (read_full_output).
 * - History: in long tasks, older tool results are shortened in batches, not on every request, so
 *   the provider's prompt cache (which needs an unchanged start) keeps working between batches.
 * - Code, paths, numbers and error text that are kept are kept exactly. Nothing rewrites the user's words.
 */

/** Rough size estimate used for savings and breakdowns; reported as an estimate. */
export const CHARS_PER_TOKEN = 4;
export const estimateTokens = (chars: number): number => Math.max(0, Math.round(chars / CHARS_PER_TOKEN));

/** Tools whose results are exactly what the model asked to read; never shortened when they are fresh. */
export const EXACT_TOOLS = new Set(['read_file', 'read_full_output', 'search_project', 'edit_file', 'write_file', 'list_files']);

export const OUTPUT_BUDGET = 4_000;
const LEGACY_TAIL = 8_000;
const IMPORTANT = /(error|fail(ed|ure|ing)?\b|exception|warn(ing)?\b|✖|✗|×|\bnot ok\b|expected|actual|assert|panic|cannot|can't|unable|denied|refused|timed? ?out|exit(ed)? (code|with)|ENOENT|EACCES|undefined is not|is not a function|SyntaxError|TypeError|ReferenceError)/i;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g;

function cleanLines(text: string): string[] {
  return text
    .replace(ANSI, '')
    .split('\n')
    .map((l) => {
      const i = l.lastIndexOf('\r');
      return (i >= 0 ? l.slice(i + 1) : l).replace(/\s+$/, '');
    });
}

/** node:test (TAP and spec), Jest/Vitest: passing tests are counted, failures are kept with their details. */
function dropPassingTests(lines: string[]): string[] {
  const out: string[] = [];
  let passed = 0;
  let markerAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*# Subtest: /.test(l)) continue;
    const tapPass = /^(\s*)ok \d+ - /.exec(l);
    const specPass = /^\s*(✔|✓|√)\s/.test(l) && !/\b(fail|error)\b/i.test(l);
    if (tapPass || specPass) {
      passed++;
      if (markerAt < 0) {
        markerAt = out.length;
        out.push('');
      }
      if (tapPass) {
        // Skip the YAML block that follows a TAP line (duration and type only for passing tests).
        const indent = tapPass[1]!.length;
        if (lines[i + 1]?.trim() === '---' && lines[i + 1]!.search(/\S/) > indent) {
          let j = i + 2;
          while (j < lines.length && lines[j]!.trim() !== '...') j++;
          i = j;
        }
      }
      continue;
    }
    if (/^\s+(duration_ms|type): /.test(l)) continue;
    out.push(l);
  }
  if (markerAt >= 0) out[markerAt] = `(${passed} passing test${passed === 1 ? '' : 's'} not shown)`;
  return out;
}

/** Stack traces: the first frames outside Node's internals, then a count. */
/** A stack frame: `    at fn (file:12:3)`, or as node:test prints them in TAP, `    fn (file:12:3)`. */
const FRAME = /^\s+(at\s|(async\s)?[\w$.<>[\] ]+ \((file:|node:|\/|[A-Za-z]:\\).*:\d+:\d+\)$)/;

function foldStacks(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!FRAME.test(lines[i]!)) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && FRAME.test(lines[j]!)) j++;
    const frames = lines.slice(i, j);
    const own = frames.filter((f) => !/\(node:|node:internal|node_modules[\\/]/.test(f));
    const kept = (own.length ? own : frames).slice(0, 3);
    out.push(...kept);
    if (frames.length > kept.length) out.push(`${/^\s*/.exec(frames[0]!)![0]}… ${frames.length - kept.length} more stack line${frames.length - kept.length === 1 ? '' : 's'}`);
    i = j;
  }
  return out;
}

/** Identical consecutive lines once with a count; runs of blank lines as one; npm deprecation notices counted. */
function foldRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let deprecated = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^npm (warn|WARN) deprecated /.test(l)) {
      if (deprecated++ < 2) out.push(l);
      continue;
    }
    if (l === '' && out[out.length - 1] === '') continue;
    let n = 1;
    while (l !== '' && lines[i + n] === l) n++;
    out.push(n > 1 ? `${l} (×${n})` : l);
    i += n - 1;
  }
  if (deprecated > 2) out.push(`(${deprecated - 2} more npm deprecation warnings)`);
  return out;
}

/** Start, end, and every important line with one line of context, within the budget. */
function window(lines: string[], budget: number): string {
  const keep = new Set<number>();
  const head = Math.min(12, lines.length);
  for (let i = 0; i < head; i++) keep.add(i);
  const important: number[] = [];
  lines.forEach((l, i) => IMPORTANT.test(l) && important.push(i));
  const tailFrom = Math.max(0, lines.length - 30);
  for (let i = tailFrom; i < lines.length; i++) keep.add(i);
  for (const i of important) for (const k of [i - 1, i, i + 1]) if (k >= 0 && k < lines.length) keep.add(k);
  const render = (set: Set<number>): string => {
    const idx = [...set].sort((a, b) => a - b);
    const parts: string[] = [];
    let prev = -1;
    for (const i of idx) {
      if (i > prev + 1) parts.push(`… (${i - prev - 1} line${i - prev - 1 === 1 ? '' : 's'} not shown)`);
      parts.push(lines[i]!);
      prev = i;
    }
    if (prev < lines.length - 1) parts.push(`… (${lines.length - 1 - prev} lines not shown)`);
    return parts.join('\n');
  };
  let text = render(keep);
  if (text.length <= budget) return text;
  // Still too long: keep the important lines (first ones first), a shorter head and tail.
  const tight = new Set<number>();
  for (let i = 0; i < Math.min(5, lines.length); i++) tight.add(i);
  for (let i = Math.max(0, lines.length - 12); i < lines.length; i++) tight.add(i);
  for (const i of important) {
    tight.add(i);
    if (render(tight).length > budget) {
      tight.delete(i);
      break;
    }
  }
  text = render(tight);
  return text.length <= budget * 1.5 ? text : `${text.slice(0, budget)}\n… (cut to ${budget} characters)`;
}

/** Shorten command, test and log output. Returns the text unchanged when there is nothing to gain. */
export function compactLog(text: string, budget = OUTPUT_BUDGET): string {
  const lines = foldRepeats(foldStacks(dropPassingTests(cleanLines(text))));
  const joined = lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return joined.length <= budget ? joined : window(lines, budget);
}

function compactJson(text: string): string | null {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return null;
  }
}

/** A tool result as it is sent to the model. */
export function compactToolOutput(name: string, output: string, enabled: boolean): string {
  if (EXACT_TOOLS.has(name)) return output;
  if (!enabled) return output.length > LEGACY_TAIL ? `…(earlier output omitted)\n${output.slice(-LEGACY_TAIL)}` : output;
  if (output.length < 600) return output;
  const json = compactJson(output);
  if (json !== null) return json.length < output.length ? json : output;
  const shorter = compactLog(output);
  return shorter.length < output.length * 0.95 ? shorter : output;
}

/** Note appended to a shortened result so the model can ask for the rest. */
export function fullOutputNote(ref: string, fullChars: number, sentChars: number): string {
  return `\n[Shortened from ${fullChars.toLocaleString('en-US')} to ${sentChars.toLocaleString('en-US')} characters to save tokens. read_full_output with ref "${ref}" returns the full text.]`;
}

/** An older tool result in a long task, as sent after its batch was shortened. */
export function historyStub(name: string, ref: string, output: string): string {
  const first = output.split('\n').find((l) => l.trim())?.trim().slice(0, 160) ?? '';
  return `[Earlier ${name} result (${output.length.toLocaleString('en-US')} characters), shortened to save tokens. Starts: ${first}${first.length >= 160 ? '…' : ''}. read_full_output with ref "${ref}" returns it; for current state, run the tool again.]`;
}

/** Results this long or shorter stay as they are in history. */
export const STUB_MIN = 600;
/** When the tool results sent in full since the last batch pass this size, the next batch is shortened. */
export const HISTORY_BUDGET = 40_000;
/** The latest rounds of actions always stay in full. */
export const KEEP_ROUNDS = 2;

/**
 * Where the shortened part of the history should end (a message index), or the current value when
 * nothing needs to change. Moves only forward, so the start of the conversation stays identical.
 */
export function nextHistoryBoundary(messages: { role: string; output?: string | null; hasToolCalls?: boolean }[], current: number): number {
  let recent = 0;
  for (let i = current; i < messages.length; i++) if (messages[i]!.role === 'tool' && (messages[i]!.output?.length ?? 0) > STUB_MIN) recent += messages[i]!.output!.length;
  if (recent <= HISTORY_BUDGET) return current;
  const rounds: number[] = [];
  messages.forEach((m, i) => m.role === 'assistant' && m.hasToolCalls && rounds.push(i));
  const cut = rounds[rounds.length - KEEP_ROUNDS];
  return cut !== undefined && cut > current ? cut : current;
}

export const READ_FULL_OUTPUT_SPEC = {
  name: 'read_full_output',
  description: 'Read the full text of a tool result that was shortened, by the ref it gave. Optional line range, or `find` to get only lines containing a text (with 2 lines around each).',
  parameters: {
    type: 'object' as const,
    properties: {
      ref: { type: 'string' as const, description: 'The ref from the shortened result' },
      start_line: { type: 'integer' as const },
      end_line: { type: 'integer' as const },
      find: { type: 'string' as const, description: 'Only lines containing this text' },
    },
    required: ['ref'],
  },
};

/** Lines of a stored output, numbered, within limits. */
export function sliceFullOutput(text: string, args: { start_line?: number; end_line?: number; find?: string }): string {
  const lines = text.split('\n');
  const MAX_LINES = 300;
  const MAX_CHARS = 20_000;
  let picked: number[];
  if (args.find) {
    const needle = args.find.toLowerCase();
    const set = new Set<number>();
    lines.forEach((l, i) => {
      if (l.toLowerCase().includes(needle)) for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < lines.length) set.add(k);
    });
    picked = [...set].sort((a, b) => a - b);
    if (!picked.length) return `No line contains “${args.find}” (${lines.length} lines in total).`;
  } else {
    const start = Math.max(1, args.start_line ?? 1);
    const end = Math.min(lines.length, args.end_line ?? start + MAX_LINES - 1);
    picked = [];
    for (let i = start - 1; i < end; i++) picked.push(i);
  }
  const out: string[] = [];
  let chars = 0;
  let prev = -2;
  for (const i of picked.slice(0, MAX_LINES)) {
    if (prev >= 0 && i > prev + 1) out.push('…');
    const line = `${String(i + 1).padStart(5)}| ${lines[i]}`;
    chars += line.length + 1;
    if (chars > MAX_CHARS) {
      out.push(`… (stopped at ${MAX_CHARS} characters; ask for a smaller range)`);
      break;
    }
    out.push(line);
    prev = i;
  }
  return `${lines.length} lines in total\n${out.join('\n')}`;
}

/** Reply style rules added to the system prompt. Plain, grammatical English: brevity, not a persona. */
export function replyRules(style: 'standard' | 'brief' | 'minimal'): string {
  if (style === 'standard') return '';
  const brief = [
    'Replies: lead with the answer or result. No preamble, no restating the request, no filler, no closing offers or recap of steps already shown.',
    'Between tool calls, write nothing or one short sentence. Short sentences; lists only for real lists.',
    'Keep code, commands, paths, ids, numbers, units and error messages exact.',
    'Write fuller sentences for risks, irreversible actions, failures, or when the user seems unsure.',
  ];
  if (style === 'minimal') brief.push('Final answers: at most five lines unless the user asks for detail.');
  return brief.join('\n');
}

/** Output limit for a request: tool-using modes keep room for file contents in tool arguments. */
export function maxOutputFor(style: 'standard' | 'brief' | 'minimal', editing: boolean): number {
  if (editing) return 8192;
  return style === 'minimal' ? 2048 : style === 'brief' ? 4096 : 8192;
}
