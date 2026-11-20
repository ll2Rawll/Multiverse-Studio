import { fileExtension } from '../../shared/paths';

const TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'map', 'webmanifest',
  'svg', 'xml', 'txt', 'md', 'markdown', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'htaccess',
  'gitignore', 'editorconfig', 'vtt', 'srt', 'scss', 'less', 'php', 'py', 'rb', 'sh', 'bat', 'ps1',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'woff', 'woff2', 'ttf', 'otf',
  'eot', 'mp3', 'mp4', 'webm', 'ogg', 'wav', 'flac', 'm4a', 'mov', 'pdf', 'zip', 'gz', 'wasm',
]);

/** Decide whether a file should be merged and edited as text. */
export function isTextFile(path: string, data?: Uint8Array): boolean {
  const ext = fileExtension(path);
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (TEXT_EXTENSIONS.has(ext)) return data ? looksLikeText(data) : true;
  return data ? looksLikeText(data) : false;
}

export function looksLikeText(data: Uint8Array): boolean {
  const limit = Math.min(data.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (data[i] === 0) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, Math.min(data.length, 65536)));
    return true;
  } catch {
    // A multi-byte sequence may have been cut at the boundary; fall back to a full check for small files.
    if (data.length <= 65536) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(data);
      return true;
    } catch {
      return false;
    }
  }
}

export function languageForPath(path: string): string {
  switch (fileExtension(path)) {
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
    case 'map':
    case 'webmanifest':
      return 'json';
    case 'svg':
    case 'xml':
      return 'xml';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

/** Split text into lines, keeping each line's terminator so joining restores the exact text. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === 13 /* \r */ && text.charCodeAt(i + 1) !== 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function countLines(text: string): number {
  return splitLines(text).length;
}
