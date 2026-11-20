import { useEffect, useRef } from 'react';
import { monaco, ensureThemes, currentTheme } from './monaco';
import type { Diagnostic } from '../../shared/types';
import { editors, geometryChanged, type EditorEntry } from '../live/registry';

type Model = ReturnType<typeof monaco.editor.createModel>;
type ViewState = ReturnType<ReturnType<typeof monaco.editor.create>['saveViewState']>;

/** Editor view state (cursor, scroll, folding) per file of each version, kept across workspace switches. */
const viewStates = new Map<string, ViewState>();

export function modelFor(uri: string, text: string, language: string): Model {
  const parsed = monaco.Uri.parse(uri);
  const existing = monaco.editor.getModel(parsed);
  if (existing) {
    if (existing.getValue() !== text) existing.setValue(text);
    return existing;
  }
  return monaco.editor.createModel(text, language, parsed);
}

export interface CodeEditorHandle {
  reveal(line: number, column: number): void;
  focus(): void;
}

/**
 * Monaco editor bound to one file. Undo history and cursor position survive switching
 * files, versions and workspaces because models and view states are cached by URI.
 */
export function CodeEditor({
  uri,
  text,
  language,
  readOnly,
  onChange,
  onSave,
  diagnostics,
  reveal,
  label,
}: {
  uri: string;
  text: string;
  language: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  diagnostics: Diagnostic[];
  reveal: { line: number; column: number; at: number } | null;
  label: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<ReturnType<typeof monaco.editor.create> | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  const applying = useRef(false);

  useEffect(() => {
    ensureThemes();
    const editor = monaco.editor.create(hostRef.current!, {
      theme: currentTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 20,
      tabSize: 2,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: 'line',
      padding: { top: 12, bottom: 12 },
      wordWrap: 'off',
      ariaLabel: label,
      readOnly,
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave());
    const sub = editor.onDidChangeModelContent(() => {
      if (applying.current) return;
      handlers.current.onChange(editor.getValue());
    });
    // Live AI activity: where a file's changed lines are on screen (for the target highlight).
    const entry: EditorEntry = {
      uri: () => editor.getModel()?.uri.toString() ?? null,
      lineRect: (start, end) => {
        const dom = editor.getDomNode();
        if (!dom) return null;
        const box = dom.getBoundingClientRect();
        const layout = editor.getLayoutInfo();
        const top = editor.getTopForLineNumber(start) - editor.getScrollTop();
        const bottom = editor.getTopForLineNumber(end + 1) - editor.getScrollTop();
        const y1 = Math.max(box.top + top, box.top);
        const y2 = Math.min(box.top + Math.max(bottom, top + 20), box.bottom);
        if (y2 - y1 < 4) return null;
        return { x: box.left + layout.contentLeft - 4, y: y1, w: Math.max(40, layout.contentWidth - 8), h: y2 - y1, r: 4 };
      },
      reveal: (line) => editor.revealLineInCenterIfOutsideViewport(line),
    };
    editors.add(entry);
    const scrollSub = editor.onDidScrollChange(() => geometryChanged());
    const themeObserver = new MutationObserver(() => monaco.editor.setTheme(currentTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      const model = editor.getModel();
      if (model) viewStates.set(model.uri.toString(), editor.saveViewState());
      themeObserver.disconnect();
      editors.delete(entry);
      scrollSub.dispose();
      sub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Switch models when the file changes, keeping each file's own undo stack and position.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const previous = editor.getModel();
    if (previous && previous.uri.toString() !== uri) viewStates.set(previous.uri.toString(), editor.saveViewState());
    applying.current = true;
    const model = modelFor(uri, text, language);
    if (editor.getModel() !== model) {
      editor.setModel(model);
      const state = viewStates.get(uri);
      if (state) editor.restoreViewState(state);
    }
    applying.current = false;
  }, [uri]);

  // External content changes (another save, a shared change) update the model in place.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || model.uri.toString() !== uri) return;
    if (model.getValue() !== text) {
      applying.current = true;
      const state = editor.saveViewState();
      model.setValue(text);
      if (state) editor.restoreViewState(state);
      applying.current = false;
    }
  }, [text, uri]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'multiverse',
      diagnostics.map((d) => ({
        severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.line,
        endColumn: d.column + 1,
        source: d.source,
      })),
    );
  }, [diagnostics, uri]);

  useEffect(() => {
    if (!reveal || !editorRef.current) return;
    editorRef.current.revealLineInCenter(reveal.line);
    editorRef.current.setPosition({ lineNumber: reveal.line, column: reveal.column });
    editorRef.current.focus();
  }, [reveal?.at]);

  return <div ref={hostRef} className="code-editor" />;
}
