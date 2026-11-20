/**
 * Project-relative path rules shared by the engine, previews, import and export.
 *
 * Every path stored in a project is a normalized POSIX-style relative path such as
 * `css/site.css`. Anything that could escape the project root, address a device, or
 * produce an invalid Windows file name is rejected.
 */

export class UnsafePathError extends Error {
  readonly code = 'unsafe-path';
  constructor(
    message: string,
    readonly input: string,
  ) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;
export const MAX_PATH_LENGTH = 400;

/** Validate a single path segment. Returns an error message or null. */
export function segmentProblem(segment: string): string | null {
  if (segment.length === 0) return 'empty path segment';
  if (segment === '.' || segment === '..') return 'relative traversal segment';
  if (FORBIDDEN_CHARS.test(segment)) return 'forbidden character in name';
  if (WINDOWS_RESERVED.test(segment)) return 'reserved Windows device name';
  if (/[. ]$/.test(segment)) return 'name ends with a dot or space';
  if (segment.length > 255) return 'name is too long';
  return null;
}

/**
 * Normalize a project-relative path. Accepts forward or back slashes.
 * Throws UnsafePathError for traversal, absolute paths, drive letters, UNC paths,
 * reserved device names and other unsafe input.
 */
export function normalizeProjectPath(input: unknown): string {
  if (typeof input !== 'string') throw new UnsafePathError('Path must be text', String(input));
  if (input.length === 0) throw new UnsafePathError('Path is empty', input);
  if (input.length > MAX_PATH_LENGTH) throw new UnsafePathError('Path is too long', input);
  const unified = input.replace(/\\/g, '/');
  if (unified.startsWith('/')) throw new UnsafePathError('Absolute paths are not allowed', input);
  if (/^[a-zA-Z]:/.test(unified)) throw new UnsafePathError('Drive paths are not allowed', input);
  const segments = unified.split('/');
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) throw new UnsafePathError(`Unsafe path (${problem})`, input);
  }
  return segments.join('/');
}

export function isSafeProjectPath(input: unknown): boolean {
  try {
    normalizeProjectPath(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a URL pathname (from a preview request) into a project path.
 * Rejects encoded traversal such as `%2e%2e/` and encoded separators.
 */
export function projectPathFromUrlPath(pathname: string): string {
  const raw = pathname.replace(/^\/+/, '');
  const rawSegments = raw.length === 0 ? ['index.html'] : raw.split('/');
  const decoded: string[] = [];
  for (const segment of rawSegments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw new UnsafePathError('Malformed URL encoding', pathname);
    }
    if (value.includes('/') || value.includes('\\')) {
      throw new UnsafePathError('Encoded path separators are not allowed', pathname);
    }
    decoded.push(value);
  }
  if (decoded.length > 0 && decoded[decoded.length - 1] === '') decoded[decoded.length - 1] = 'index.html';
  return normalizeProjectPath(decoded.join('/'));
}

/** Resolve a reference found inside a project file (e.g. `../img/a.png`) relative to that file. */
export function resolveRelativeReference(fromFile: string, reference: string): string | null {
  const clean = reference.split('#')[0]!.split('?')[0]!;
  if (clean.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  const baseSegments = decoded.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
  const out = [...baseSegments];
  for (const segment of decoded.replace(/^\/+/, '').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null; // escapes the project root
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) return null;
  const joined = out.join('/');
  return isSafeProjectPath(joined) ? joined : null;
}

export function fileExtension(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function dirName(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

export function comparePaths(a: string, b: string): number {
  // Folders first within the same directory is handled by the UI; here: stable, case-insensitive order.
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
