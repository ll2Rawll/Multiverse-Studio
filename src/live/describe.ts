/**
 * Turns commands, operations and tool calls into live-activity targets and short descriptions.
 * Pure functions: given what the command was asked to do and the files before and after, they
 * name the principal object that changed and how many changed, without inventing anything.
 */
import type { LivePhase, LiveTarget } from '../shared/live';

const pageName = (p: unknown): string => (typeof p !== 'string' ? 'a page' : /(^|\/)index\.html?$/i.test(p) ? 'the homepage' : p);
const seqOf = (path: string): string | null => /^sequences\/([^/]+)\.mvseq\.json$/.exec(path)?.[1] ?? null;

/** Changed line ranges between two texts (1-based, in the new text). */
export function changedRanges(before: string | null, after: string | null): { start: number; end: number }[] {
  if (after === null) return [];
  const a = (before ?? '').split('\n');
  const b = after.split('\n');
  if (before === null) return [{ start: 1, end: Math.max(1, b.length) }];
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= top && eb >= top && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  if (top > eb) return top <= b.length ? [{ start: Math.min(top + 1, b.length), end: Math.min(top + 1, b.length) }] : [];
  return [{ start: top + 1, end: eb + 1 }];
}

interface ClipLike {
  id: string;
}
function sequenceChanges(before: string | null, after: string | null): { changed: string[]; tracks: string[] } {
  const parse = (t: string | null): { tracks?: { id: string; clips?: ClipLike[] }[] } | null => {
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  if (!b) return { changed: [], tracks: [] };
  const old = new Map<string, string>();
  for (const t of a?.tracks ?? []) for (const c of t.clips ?? []) old.set(c.id, JSON.stringify(c));
  const changed: string[] = [];
  const tracks = new Set<string>();
  for (const t of b.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (old.get(c.id) !== JSON.stringify(c)) {
        changed.push(c.id);
        tracks.add(t.id);
      }
    }
  }
  return { changed, tracks: [...tracks] };
}

const VIDEO_VERBS: Record<string, [string, string]> = {
  'video.trimClip': ['Trimming a clip', 'Trimming {n} clips'],
  'video.splitClip': ['Splitting a clip', 'Splitting {n} clips'],
  'video.moveClip': ['Moving a clip', 'Moving {n} clips'],
  'video.addText': ['Adding a title', 'Adding {n} titles'],
  'video.setText': ['Editing a title', 'Editing {n} titles'],
  'video.setClip': ['Adjusting a clip', 'Adjusting {n} clips'],
  'video.removeClip': ['Removing a clip', 'Removing {n} clips'],
  'video.addClip': ['Adding a clip', 'Adding {n} clips'],
  'video.batch': ['Editing a clip', 'Adjusting {n} clips'],
};

const DESIGN_VERBS: Record<string, string> = {
  'design.setText': 'Updating text on {page}',
  'design.setAttribute': 'Updating a link or image on {page}',
  'design.setTitle': 'Renaming {page}',
  'design.setStyle': 'Adjusting style on {page}',
  'design.insertSection': 'Adding a section to {page}',
  'design.moveSection': 'Moving a section on {page}',
  'design.removeSection': 'Removing a section from {page}',
  'design.duplicateSection': 'Duplicating a section on {page}',
  'design.setTheme': 'Updating the theme',
  'design.createPage': 'Creating {page}',
  'design.insertComponent': 'Adding a component to {page}',
  'design.saveComponent': 'Saving a component',
  'design.syncComponent': 'Updating a component across pages',
  'design.applyBrand': 'Applying the brand',
  'design.setFontFaces': 'Updating fonts',
};

/** A file command: its principal target, scope and description. */
export function describeCommand(name: string, args: Record<string, unknown>, files: { path: string; before: string | null; after: string | null }[], label: string): { target: LiveTarget | null; scope: number; description: string; resourceId: string | null } {
  const changed = files.filter((f) => f.before !== f.after);
  const first = changed[0] ?? files[0] ?? null;
  if (name.startsWith('video.')) {
    const seqFile = changed.find((f) => seqOf(f.path)) ?? null;
    const sequenceId = seqFile ? seqOf(seqFile.path)! : typeof args.sequence === 'string' ? args.sequence : null;
    const { changed: clips, tracks } = seqFile ? sequenceChanges(seqFile.before, seqFile.after) : { changed: [], tracks: [] };
    const explicit = typeof args.clipId === 'string' && clips.includes(args.clipId) ? args.clipId : null;
    const clipId = explicit ?? clips[0] ?? (typeof args.clipId === 'string' ? args.clipId : null);
    const [one, many] = VIDEO_VERBS[name] ?? ['Editing the timeline', 'Editing {n} clips'];
    const n = Math.max(1, clips.length);
    const target: LiveTarget | null = sequenceId && clipId ? { kind: 'clip', sequenceId, clipId } : sequenceId && typeof args.trackId === 'string' ? { kind: 'track', sequenceId, trackId: args.trackId } : sequenceId && tracks[0] ? { kind: 'track', sequenceId, trackId: tracks[0] } : null;
    return { target, scope: n, description: n > 1 ? many.replace('{n}', String(n)) : one, resourceId: sequenceId };
  }
  if (name.startsWith('design.')) {
    const page = typeof args.page === 'string' ? args.page : (first?.path ?? null);
    const t = (args.target ?? null) as { id?: string; path?: string } | null;
    const property = name === 'design.setStyle' && args.props && typeof args.props === 'object' ? (Object.keys(args.props as object)[0] ?? null) : name === 'design.setAttribute' && typeof args.name === 'string' ? args.name : null;
    const target: LiveTarget | null = page && t ? { kind: 'element', page, id: t.id ?? null, path: t.path ?? null, property } : null;
    return { target, scope: 1, description: (DESIGN_VERBS[name] ?? 'Editing {page}').replace('{page}', pageName(page)), resourceId: page };
  }
  if (name.startsWith('objects.')) {
    const objectId = typeof args.object === 'string' ? args.object : null;
    const n = changed.length;
    return { target: objectId ? { kind: 'object', objectId } : null, scope: n, description: `${label}${n > 1 ? ` (${n} files)` : ''}`, resourceId: objectId };
  }
  // Code and everything else that edits files: the changed lines of the principal file.
  if (!first) {
    const p = typeof args.path === 'string' ? args.path : null;
    const description = p && name === 'code.writeFile' ? `Writing ${p}` : p && name === 'code.editFile' ? `Editing ${p}` : name === 'code.applyPatch' ? 'Patching files' : label;
    return { target: null, scope: 0, description, resourceId: p };
  }
  const target: LiveTarget = { kind: 'code', path: first.path, ranges: changedRanges(first.before, first.after), created: first.before === null && first.after !== null };
  const n = changed.length;
  const description = name === 'code.writeFile' ? `${first.before === null ? 'Creating' : 'Writing'} ${first.path}` : name === 'code.editFile' ? `Editing ${first.path}` : name === 'code.applyPatch' ? (n > 1 ? `Patching ${n} files` : `Patching ${first.path}`) : label;
  return { target, scope: n, description, resourceId: first.path };
}

/** An agent tool call: phase and description (targets come from the tool's own result). */
export function describeTool(name: string, args: Record<string, unknown>): { phase: LivePhase; description: string } {
  const p = typeof args.path === 'string' ? args.path : null;
  switch (name) {
    case 'read_file':
      return { phase: 'reading', description: `Reading ${p ?? 'a file'}` };
    case 'list_files':
      return { phase: 'reading', description: 'Looking through the project’s files' };
    case 'search_project':
      return { phase: 'reading', description: `Searching the project${typeof args.query === 'string' ? ` for “${args.query.slice(0, 40)}”` : ''}` };
    case 'get_studio_state':
    case 'list_studio_commands':
    case 'read_full_output':
      return { phase: 'reading', description: 'Reading the studio state' };
    case 'edit_file':
      return { phase: 'editing', description: `Editing ${p ?? 'a file'}` };
    case 'write_file':
      return { phase: 'editing', description: `Writing ${p ?? 'a file'}` };
    case 'run_command':
      return { phase: 'executing', description: `Running ${[args.program, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' ').slice(0, 60)}` };
    case 'run_tests':
      return { phase: 'testing', description: 'Running the tests' };
    case 'start_dev_server':
      return { phase: 'executing', description: 'Starting the app' };
    case 'run_browser_check':
      return { phase: 'testing', description: `Checking ${typeof args.page === 'string' ? args.page : 'the page'} in a background browser` };
    case 'look_at_page':
    case 'capture_screenshot':
      return { phase: 'testing', description: `Looking at ${typeof args.page === 'string' && args.page !== '/' ? args.page : 'the page'}` };
    case 'run_studio_command':
      return { phase: 'editing', description: `Running ${typeof args.name === 'string' ? args.name : 'a studio command'}` };
    default:
      return { phase: 'executing', description: name.replace(/_/g, ' ') };
  }
}

/** Phase of a project operation. */
export function operationPhase(name: string): LivePhase {
  if (name === 'story.run' || name === 'code.runTests') return 'testing';
  if (name === 'story.record') return 'recording';
  if (/compare|status/i.test(name)) return 'reading';
  return 'editing';
}
