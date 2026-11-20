/**
 * Parsing diagnostics, shown separately from save errors and preview runtime errors.
 * HTML and CSS use the same locators as section combining; JavaScript uses acorn.
 */
import { parse as acornParse } from 'acorn';
import { attr, offsetToLine, parseHtml } from './html';
import { parseCss } from './css';
import { fileExtension } from '../../shared/paths';
import type { Diagnostic } from '../../shared/types';

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function javascriptDiagnostics(text: string, lineOffset = 0, preferModule = false): Diagnostic[] {
  const attempt = (sourceType: 'script' | 'module'): Diagnostic | null => {
    try {
      acornParse(text, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: sourceType === 'script' });
      return null;
    } catch (error) {
      const e = error as { message?: string; loc?: { line: number; column: number } };
      return {
        severity: 'error',
        source: 'javascript',
        message: (e.message ?? 'Syntax error').replace(/\s*\(\d+:\d+\)$/, ''),
        line: (e.loc?.line ?? 1) + lineOffset,
        column: (e.loc?.column ?? 0) + 1,
      };
    }
  };
  const looksModule = preferModule || /^\s*(import|export)\s/m.test(text);
  const first = attempt(looksModule ? 'module' : 'script');
  if (!first) return [];
  const second = attempt(looksModule ? 'script' : 'module');
  return second ? [first] : [];
}

export function cssDiagnostics(text: string, lineOffset = 0, columnOffset = 0): Diagnostic[] {
  const sheet = parseCss(text);
  const starts = lineStarts(text);
  return sheet.problems.slice(0, 50).map((p) => {
    const pos = offsetToLine(starts, p.offset);
    return { severity: 'error' as const, source: 'css' as const, message: p.message, line: pos.line + lineOffset, column: pos.line === 1 ? pos.column + columnOffset : pos.column };
  });
}

export function htmlDiagnostics(text: string): Diagnostic[] {
  const doc = parseHtml(text);
  const out: Diagnostic[] = doc.problems.slice(0, 50).map((p) => {
    const pos = offsetToLine(doc.lineStarts, p.offset);
    return { severity: p.severity, source: 'html' as const, message: p.message, line: pos.line, column: pos.column };
  });
  for (const el of doc.elements) {
    if (el.tag === 'style') {
      const pos = offsetToLine(doc.lineStarts, el.openEnd);
      out.push(...cssDiagnostics(text.slice(el.openEnd, el.closeStart), pos.line - 1, pos.column - 1));
    } else if (el.tag === 'script' && !attr(el, 'src')) {
      const type = (attr(el, 'type') ?? '').toLowerCase();
      if (type && !/javascript|module|ecmascript/.test(type)) continue;
      const pos = offsetToLine(doc.lineStarts, el.openEnd);
      out.push(...javascriptDiagnostics(text.slice(el.openEnd, el.closeStart), pos.line - 1, type === 'module'));
    }
  }
  return out;
}

export function diagnosticsFor(path: string, text: string): Diagnostic[] {
  const ext = fileExtension(path);
  if (ext === 'html' || ext === 'htm') return htmlDiagnostics(text);
  if (ext === 'css') return cssDiagnostics(text);
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return javascriptDiagnostics(text, 0, ext === 'mjs');
  if (ext === 'json' || ext === 'webmanifest') {
    try {
      JSON.parse(text);
      return [];
    } catch (error) {
      return [{ severity: 'error', source: 'javascript', message: `Invalid JSON: ${(error as Error).message}`, line: 1, column: 1 }];
    }
  }
  return [];
}
