/**
 * `code.applyPatch`: apply a unified diff to a universe's files as one undoable command.
 * Hunks must match their context exactly (a small line offset is tolerated); a hunk that does not
 * apply changes nothing and says which file and hunk failed.
 */
import { z } from 'zod';
import { CommandError, type CommandDefinition, type CommandRegistry, type FileChanges, type FileTexts } from './commands';
import { normalizeProjectPath } from '../shared/paths';

interface Hunk {
  oldStart: number;
  lines: string[];
}
interface FilePatch {
  from: string | null;
  to: string | null;
  hunks: Hunk[];
}

const strip = (p: string): string | null => {
  const t = p.trim().split('\t')[0]!;
  if (t === '/dev/null') return null;
  return normalizeProjectPath(t.replace(/^[ab]\//, ''));
};

export function parsePatch(patch: string): FilePatch[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      current = { from: strip(l.slice(4)), to: strip(lines[i + 1]!.slice(4)), hunks: [] };
      files.push(current);
      hunk = null;
      i += 1;
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      if (!current) throw new CommandError('The patch has a hunk before any file header (--- / +++).');
      hunk = { oldStart: Number(h[1]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk && (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-') || l === '')) {
      // A bare empty line inside a hunk is an empty context line (some tools drop the space).
      if (l === '' && i === lines.length - 1) continue;
      hunk.lines.push(l === '' ? ' ' : l);
    } else if (l.startsWith('\\')) {
      continue; // "\ No newline at end of file"
    }
  }
  if (!files.length) throw new CommandError('No file changes found. Send a unified diff with --- a/path and +++ b/path headers.');
  return files;
}

function applyHunks(text: string, hunks: Hunk[], file: string): string {
  const src = text.split('\n');
  let offset = 0;
  for (const [n, h] of hunks.entries()) {
    const before = h.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1));
    const after = h.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1));
    const want = h.oldStart - 1 + offset;
    let at = -1;
    for (const d of [0, 1, -1, 2, -2, 3, -3, 5, -5, 10, -10]) {
      const s = Math.max(0, want + d);
      if (before.every((b, k) => src[s + k] === b)) {
        at = s;
        break;
      }
    }
    if (before.length === 0) at = Math.min(Math.max(0, want), src.length);
    if (at < 0) throw new CommandError(`Hunk ${n + 1} does not apply to ${file}: its context lines were not found near line ${h.oldStart}. Read the file again and make the patch against its current text.`);
    src.splice(at, before.length, ...after);
    offset += after.length - before.length;
  }
  return src.join('\n');
}

const schema = z.object({ patch: z.string().min(10).max(2_000_000) });

export const applyPatchCommand: CommandDefinition<{ patch: string }> = {
  name: 'code.applyPatch',
  schema,
  scope: () => 'code:patch',
  label: (a) => {
    const n = (() => {
      try {
        return parsePatch(a.patch).length;
      } catch {
        return 0;
      }
    })();
    return `Apply a patch to ${n} file${n === 1 ? '' : 's'}`;
  },
  files: (a) => {
    try {
      return [...new Set(parsePatch(a.patch).flatMap((f) => [f.from, f.to].filter((p): p is string => p !== null)))];
    } catch {
      return [];
    }
  },
  apply: (files: FileTexts, a): FileChanges => {
    const out: FileChanges = new Map();
    for (const f of parsePatch(a.patch)) {
      if (f.to === null) {
        if (f.from === null || files.get(f.from) == null) throw new CommandError(`${f.from ?? 'The file'} does not exist, so it cannot be deleted.`);
        out.set(f.from, null);
        continue;
      }
      const base = f.from === null ? '' : (out.has(f.from) ? (out.get(f.from) as string | null) : files.get(f.from)) ?? null;
      if (f.from !== null && base === null) throw new CommandError(`${f.from} does not exist in this version.`);
      if (f.from === null && files.get(f.to) != null) throw new CommandError(`${f.to} already exists; the patch creates it.`);
      const next = applyHunks(base ?? '', f.hunks, f.to);
      if (f.from !== null && f.from !== f.to) out.set(f.from, null);
      out.set(f.to, next);
    }
    return out;
  },
};

const pathSchema = z.string().min(1).max(400);

/** `code.writeFile`: create or replace one text file as an undoable command. */
export const writeFileCommand: CommandDefinition<{ path: string; text: string }> = {
  name: 'code.writeFile',
  schema: z.object({ path: pathSchema, text: z.string().max(2_000_000) }),
  scope: () => 'code:write',
  label: (a) => `Write ${normalizeProjectPath(a.path)}`,
  files: (a) => [normalizeProjectPath(a.path)],
  apply: (files: FileTexts, a): FileChanges => {
    const p = normalizeProjectPath(a.path);
    return files.get(p) === a.text ? new Map() : new Map([[p, a.text]]);
  },
};

/** `code.editFile`: exact find-and-replace edits in one file; each `find` must match once unless `all`. */
export const editFileCommand: CommandDefinition<{ path: string; edits: { find: string; replace: string; all?: boolean }[] }> = {
  name: 'code.editFile',
  schema: z.object({ path: pathSchema, edits: z.array(z.object({ find: z.string().min(1).max(200_000), replace: z.string().max(200_000), all: z.boolean().optional() })).min(1).max(50) }),
  scope: () => 'code:edit',
  label: (a) => `Edit ${normalizeProjectPath(a.path)}`,
  files: (a) => [normalizeProjectPath(a.path)],
  apply: (files: FileTexts, a): FileChanges => {
    const p = normalizeProjectPath(a.path);
    let text = files.get(p);
    if (text == null) throw new CommandError(`${p} does not exist. Create it with code.writeFile.`);
    for (const [i, e] of a.edits.entries()) {
      const count = text.split(e.find).length - 1;
      if (count === 0) throw new CommandError(`Edit ${i + 1}: the find text is not in ${p}. Read the file again and copy the exact text.`);
      if (count > 1 && !e.all) throw new CommandError(`Edit ${i + 1}: the find text appears ${count} times in ${p}. Add surrounding text so it is unique, or set all.`);
      text = e.all ? text.split(e.find).join(e.replace) : text.replace(e.find, () => e.replace);
    }
    return new Map([[p, text]]);
  },
};

export function registerCodeCommands(registry: CommandRegistry): void {
  registry.register(applyPatchCommand as CommandDefinition<unknown>);
  registry.register(writeFileCommand as CommandDefinition<unknown>);
  registry.register(editFileCommand as CommandDefinition<unknown>);
}
