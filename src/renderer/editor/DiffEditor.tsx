import { useEffect, useRef } from 'react';
import { monaco, ensureThemes, currentTheme } from './monaco';

let diffSeq = 0;

/** Read-only side-by-side source comparison. */
export function DiffEditor({ original, modified, language, label }: { original: string; modified: string; language: string; label: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<ReturnType<typeof monaco.editor.createDiffEditor> | null>(null);

  useEffect(() => {
    ensureThemes();
    const editor = monaco.editor.createDiffEditor(hostRef.current!, {
      theme: currentTheme(),
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      ariaLabel: label,
      originalEditable: false,
    });
    editorRef.current = editor;
    return () => {
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const id = ++diffSeq;
    const previous = editor.getModel();
    editor.setModel({
      original: monaco.editor.createModel(original, language, monaco.Uri.parse(`diff://original/${id}`)),
      modified: monaco.editor.createModel(modified, language, monaco.Uri.parse(`diff://modified/${id}`)),
    });
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [original, modified, language]);

  return <div ref={hostRef} className="code-editor diff-editor" />;
}
