import * as monaco from 'monaco-editor';
import './monacoEnv';

let themesReady = false;

/** Opaque, calm editor themes that match the app’s dystopia, graphite and pearl appearances. */
export function ensureThemes(): void {
  if (themesReady) return;
  themesReady = true;
  monaco.editor.defineTheme('mv-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '7d8499', fontStyle: 'italic' },
      { token: 'tag', foreground: '9aa3ff' },
      { token: 'attribute.name', foreground: '8fd3c8' },
      { token: 'attribute.value', foreground: 'e9c38b' },
      { token: 'string', foreground: 'e9c38b' },
      { token: 'keyword', foreground: 'c7a0ff' },
      { token: 'number', foreground: 'f2a07b' },
    ],
    colors: {
      'editor.background': '#141824',
      'editor.foreground': '#dfe3ee',
      'editorLineNumber.foreground': '#4b5267',
      'editorLineNumber.activeForeground': '#a8afc6',
      'editor.lineHighlightBackground': '#1b2030',
      'editor.selectionBackground': '#3a4380',
      'editorCursor.foreground': '#9aa3ff',
      'editorIndentGuide.background1': '#232838',
      'editorGutter.background': '#141824',
      'diffEditor.insertedTextBackground': '#3fbf8a26',
      'diffEditor.removedTextBackground': '#f0708033',
    },
  });
  // Dystopia: night violet ground; sodium strings, ultraviolet structure, carmine numbers.
  monaco.editor.defineTheme('mv-dystopia', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '86769a', fontStyle: 'italic' },
      { token: 'tag', foreground: 'b6a2ff' },
      { token: 'delimiter', foreground: '8f7fa8' },
      { token: 'attribute.name', foreground: 'e6d3f5' },
      { token: 'attribute.value', foreground: 'ffad73' },
      { token: 'string', foreground: 'ffad73' },
      { token: 'keyword', foreground: 'b6a2ff' },
      { token: 'number', foreground: 'ff7d93' },
    ],
    colors: {
      'editor.background': '#150e21',
      'editor.foreground': '#ece3f3',
      'editorLineNumber.foreground': '#4d3f63',
      'editorLineNumber.activeForeground': '#ffad73',
      'editor.lineHighlightBackground': '#1d1430',
      'editor.selectionBackground': '#4a2f6e',
      'editor.inactiveSelectionBackground': '#33224d',
      'editorCursor.foreground': '#ff8a3d',
      'editorIndentGuide.background1': '#271c3a',
      'editorGutter.background': '#150e21',
      'editorWidget.background': '#1d1430',
      'diffEditor.insertedTextBackground': '#4fe0a626',
      'diffEditor.removedTextBackground': '#ff4f6d33',
    },
  });
  monaco.editor.defineTheme('mv-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a90a3', fontStyle: 'italic' },
      { token: 'tag', foreground: '4a52c9' },
      { token: 'attribute.name', foreground: '237a6e' },
      { token: 'attribute.value', foreground: '9a5b12' },
      { token: 'string', foreground: '9a5b12' },
      { token: 'keyword', foreground: '7a3fc9' },
    ],
    colors: {
      'editor.background': '#fbfbfd',
      'editor.foreground': '#232737',
      'editorLineNumber.foreground': '#b4b9c8',
      'editor.lineHighlightBackground': '#f1f2f7',
      'editor.selectionBackground': '#cdd2ff',
      'editorCursor.foreground': '#4a52c9',
    },
  });
}

export function currentTheme(): 'mv-dystopia' | 'mv-dark' | 'mv-light' {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' ? 'mv-light' : theme === 'dystopia' ? 'mv-dystopia' : 'mv-dark';
}

export { monaco };
