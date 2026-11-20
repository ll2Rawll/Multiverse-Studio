/**
 * Preview generation: maps an opaque preview token to project content and answers
 * requests for files inside it. Used by the Electron `mvpreview:` protocol and by the
 * browser harness's HTTP server, so both share the same path rules and headers.
 *
 * - Tokens are random and map to a project + content ref; nothing else is reachable.
 * - Paths are decoded and normalized with the shared rules; traversal is rejected.
 * - HTML responses get a restrictive Content-Security-Policy that limits every fetch
 *   to the preview's own origin (no remote network, no frames, no form posts).
 * - Responses allow any origin to read them because sandboxed previews have an opaque
 *   origin (fonts and module scripts are CORS requests).
 */
import { randomBytes } from 'node:crypto';
import { projectPathFromUrlPath, UnsafePathError, fileExtension } from '../shared/paths';
import type { ContentRef } from '../shared/types';
import { BRIDGE_SCRIPT } from './bridge';

export interface PreviewTarget {
  projectId: string;
  ref: ContentRef;
}

export interface PreviewResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PreviewContentSource {
  /** Current tree for a target (resolved at request time so live previews stay current). */
  tree(target: PreviewTarget): Promise<ReadonlyMap<string, string>>;
  blob(projectId: string, hash: string): Promise<Buffer>;
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};

export function mimeFor(path: string): string {
  return MIME[fileExtension(path)] ?? 'application/octet-stream';
}

export function newPreviewToken(): string {
  return `t${randomBytes(10).toString('hex')}`;
}

export function isPreviewToken(value: string): boolean {
  return /^t[0-9a-f]{20}$/.test(value);
}

export function previewCsp(origin: string): string {
  return [
    "default-src 'none'",
    `script-src ${origin} 'unsafe-inline'`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob:`,
    `font-src ${origin} data:`,
    `media-src ${origin} data: blob:`,
    `connect-src ${origin}`,
    `manifest-src ${origin}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Preview-only adjustments to served HTML (the stored source is never changed):
 * - inject the bridge script;
 * - request local scripts in CORS mode so runtime errors keep their message and line
 *   (sandboxed previews have an opaque origin, which otherwise reduces every error to
 *   "Script error.").
 */
export function injectBridge(html: string): string {
  html = html.replace(/<script\b([^>]*?)\bsrc\s*=/gi, (match: string, attrs: string) => (/\bcrossorigin\b/i.test(attrs) ? match : `<script crossorigin="anonymous"${attrs} src=`));
  const tag = `<script>${BRIDGE_SCRIPT}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + tag + html.slice(htmlTag.index + htmlTag[0].length);
  return tag + html;
}

export class PreviewRegistry {
  private readonly targets = new Map<string, PreviewTarget>();

  open(target: PreviewTarget): string {
    for (const [token, existing] of this.targets) {
      if (existing.projectId === target.projectId && JSON.stringify(existing.ref) === JSON.stringify(target.ref)) return token;
    }
    const token = newPreviewToken();
    this.targets.set(token, target);
    return token;
  }

  get(token: string): PreviewTarget | undefined {
    return this.targets.get(token);
  }

  release(token: string): void {
    this.targets.delete(token);
  }

  releaseProject(projectId: string): void {
    for (const [token, target] of this.targets) if (target.projectId === projectId) this.targets.delete(token);
  }
}

function textResponse(status: number, message: string, origin: string): PreviewResponse {
  const body = `<!doctype html><meta charset="utf-8"><title>${status}</title><body style="font:14px system-ui,sans-serif;color:#555;padding:24px">${message.replace(/[<>&]/g, '')}</body>`;
  return {
    status,
    headers: baseHeaders('text/html; charset=utf-8', origin),
    body: Buffer.from(body, 'utf8'),
  };
}

function baseHeaders(contentType: string, origin: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': previewCsp(origin),
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
}

export async function handlePreviewRequest(
  registry: PreviewRegistry,
  source: PreviewContentSource,
  token: string,
  pathname: string,
  origin: string,
): Promise<PreviewResponse> {
  if (!isPreviewToken(token)) return textResponse(404, 'Unknown preview.', origin);
  const target = registry.get(token);
  if (!target) return textResponse(404, 'This preview has been closed.', origin);
  let path: string;
  try {
    path = projectPathFromUrlPath(pathname);
  } catch (error) {
    if (error instanceof UnsafePathError) return textResponse(403, 'That path is not allowed in previews.', origin);
    throw error;
  }
  let tree: ReadonlyMap<string, string>;
  try {
    tree = await source.tree(target);
  } catch (error) {
    return textResponse(410, (error as Error).message || 'This version is no longer available.', origin);
  }
  let resolved = path;
  if (!tree.has(resolved)) {
    const candidates = [`${path}.html`, `${path}/index.html`];
    const found = candidates.find((c) => tree.has(c));
    if (!found) return textResponse(404, `${path} is not part of this version.`, origin);
    resolved = found;
  }
  const hash = tree.get(resolved)!;
  let body = await source.blob(target.projectId, hash);
  const contentType = mimeFor(resolved);
  if (contentType.startsWith('text/html')) {
    body = Buffer.from(injectBridge(body.toString('utf8')), 'utf8');
  }
  return { status: 200, headers: baseHeaders(contentType, origin), body };
}
