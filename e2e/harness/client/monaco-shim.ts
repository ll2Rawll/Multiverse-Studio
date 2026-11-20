/**
 * A tiny stand-in for the parts of the Monaco API the app uses, so the UI can run in the
 * offline browser harness. The real app bundles monaco-editor; this is test-only.
 */
type Listener = () => void;

class Uri {
  constructor(private readonly value: string) {}
  static parse(value: string): Uri {
    return new Uri(value);
  }
  toString(): string {
    return this.value;
  }
}

class Model {
  private value: string;
  private listeners = new Set<Listener>();
  disposed = false;
  constructor(value: string, public language: string, public uri: Uri) {
    this.value = value;
  }
  getValue(): string {
    return this.value;
  }
  setValue(value: string): void {
    this.value = value;
    this.listeners.forEach((l) => l());
  }
  _setFromEditor(value: string): void {
    this.value = value;
    this.listeners.forEach((l) => l());
  }
  onDidChangeContent(l: Listener): { dispose(): void } {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  }
  dispose(): void {
    this.disposed = true;
    models.delete(this.uri.toString());
  }
  isDisposed(): boolean {
    return this.disposed;
  }
}

const models = new Map<string, Model>();

function createEditor(host: HTMLElement, options: { readOnly?: boolean; ariaLabel?: string }) {
  const textarea = document.createElement('textarea');
  textarea.className = 'monaco-shim';
  textarea.spellcheck = false;
  textarea.setAttribute('aria-label', options.ariaLabel ?? 'Code editor');
  textarea.setAttribute('data-testid', 'code-editor');
  textarea.readOnly = Boolean(options.readOnly);
  textarea.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;resize:none;padding:12px 16px;font:13px/20px var(--font-mono);background:var(--mat-solid);color:var(--text-1);tab-size:2;outline:none;white-space:pre;';
  host.appendChild(textarea);
  let model: Model | null = null;
  let modelSub: { dispose(): void } | null = null;
  const changeListeners = new Set<Listener>();
  const commands: { key: number; run: () => void }[] = [];
  textarea.addEventListener('input', () => {
    model?._setFromEditor(textarea.value);
  });
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      commands.forEach((c) => c.run());
    }
  });
  return {
    getModel: () => model,
    setModel(next: Model | null) {
      modelSub?.dispose();
      model = next;
      textarea.value = next?.getValue() ?? '';
      modelSub =
        next?.onDidChangeContent(() => {
          if (textarea.value !== next.getValue()) textarea.value = next.getValue();
          changeListeners.forEach((l) => l());
        }) ?? null;
    },
    getValue: () => model?.getValue() ?? '',
    onDidChangeModelContent(l: Listener) {
      changeListeners.add(l);
      return { dispose: () => changeListeners.delete(l) };
    },
    saveViewState: () => ({ selectionStart: textarea.selectionStart, scrollTop: textarea.scrollTop }),
    restoreViewState(state: { selectionStart: number; scrollTop: number } | null) {
      if (!state) return;
      textarea.selectionStart = textarea.selectionEnd = state.selectionStart;
      textarea.scrollTop = state.scrollTop;
    },
    updateOptions(o: { readOnly?: boolean }) {
      if (o.readOnly !== undefined) textarea.readOnly = o.readOnly;
    },
    addCommand(key: number, run: () => void) {
      commands.push({ key, run });
    },
    revealLineInCenter(line: number) {
      textarea.scrollTop = Math.max(0, (line - 10) * 20);
    },
    setPosition(p: { lineNumber: number; column: number }) {
      const lines = textarea.value.split('\n');
      let offset = 0;
      for (let i = 0; i < p.lineNumber - 1 && i < lines.length; i++) offset += lines[i]!.length + 1;
      textarea.selectionStart = textarea.selectionEnd = offset + p.column - 1;
    },
    focus: () => textarea.focus(),
    layout: () => undefined,
    getDomNode: () => textarea,
    getLayoutInfo: () => ({ contentLeft: 16, contentWidth: Math.max(0, textarea.clientWidth - 32) }),
    getTopForLineNumber: (line: number) => 12 + (line - 1) * 20,
    getScrollTop: () => textarea.scrollTop,
    revealLineInCenterIfOutsideViewport(line: number) {
      const top = 12 + (line - 1) * 20;
      if (top < textarea.scrollTop || top > textarea.scrollTop + textarea.clientHeight - 20) textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2);
    },
    onDidScrollChange(l: Listener) {
      textarea.addEventListener('scroll', l);
      return { dispose: () => textarea.removeEventListener('scroll', l) };
    },
    dispose() {
      modelSub?.dispose();
      textarea.remove();
    },
  };
}

function createDiffEditor(host: HTMLElement) {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-testid', 'diff-editor');
  wrap.style.cssText = 'position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:1px;overflow:auto;font:12px/18px var(--font-mono);';
  const left = document.createElement('pre');
  const right = document.createElement('pre');
  for (const pre of [left, right]) {
    pre.style.cssText = 'margin:0;padding:12px;white-space:pre-wrap;color:var(--text-1);background:var(--mat-solid);';
    wrap.appendChild(pre);
  }
  host.appendChild(wrap);
  let current: { original: Model; modified: Model } | null = null;
  return {
    setModel(m: { original: Model; modified: Model }) {
      current = m;
      left.textContent = m.original.getValue();
      right.textContent = m.modified.getValue();
    },
    getModel: () => current,
    dispose: () => wrap.remove(),
  };
}

export const editor = {
  create: createEditor,
  createDiffEditor,
  createModel(value: string, language: string, uri: Uri) {
    const model = new Model(value, language, uri);
    models.set(uri.toString(), model);
    return model;
  },
  getModel: (uri: Uri) => models.get(uri.toString()) ?? null,
  defineTheme: () => undefined,
  setTheme: () => undefined,
  setModelMarkers: () => undefined,
};

export { Uri };
export const KeyMod = { CtrlCmd: 2048 };
export const KeyCode = { KeyS: 49 };
export const MarkerSeverity = { Error: 8, Warning: 4 };
