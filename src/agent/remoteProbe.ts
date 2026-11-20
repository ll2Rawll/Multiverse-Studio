/** Worker-side proxy for the browser probe that lives in Electron's main process. */
import type { BrowserProbe, BrowserProbeRequest, BrowserProbeResult, RecordRequest, StoryProbeRequest, StoryProbeResult } from './browser';

interface PortLike {
  postMessage(message: unknown): void;
}

export class RemoteBrowserProbe implements BrowserProbe {
  readonly label = 'hidden browser window';
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private readonly stepListeners = new Map<number, (index: number, result: import('../shared/stories').StoryStepResult) => void>();

  constructor(private readonly port: PortLike) {}

  handle(message: unknown): boolean {
    const m = message as { type?: string; id?: number; ok?: boolean; value?: unknown; error?: string; index?: number; result?: import('../shared/stories').StoryStepResult };
    if (m?.type === 'story-step' && typeof m.id === 'number') {
      if (typeof m.index === 'number' && m.result) this.stepListeners.get(m.id)?.(m.index, m.result);
      return true;
    }
    if (!m || (m.type !== 'probe-result' && m.type !== 'record-result' && m.type !== 'story-result') || typeof m.id !== 'number') return false;
    const entry = this.pending.get(m.id);
    if (entry) {
      this.pending.delete(m.id);
      this.stepListeners.delete(m.id);
      if (m.ok && m.value) entry.resolve(m.value as never);
      else entry.reject(new Error(m.error ?? (m.type === 'record-result' ? 'The recording failed.' : 'The browser check failed.')));
    }
    return true;
  }

  /** Recording runs in the desktop app's hidden, isolated browser window. */
  record(request: RecordRequest): Promise<{ file: string }> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.port.postMessage({ type: 'record', id, request });
    });
  }

  /** Stories run in the desktop app's hidden, isolated browser window. */
  story(request: StoryProbeRequest, onStep?: (index: number, result: import('../shared/stories').StoryStepResult) => void): Promise<StoryProbeResult> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      if (onStep) this.stepListeners.set(id, onStep);
      this.port.postMessage({ type: 'story', id, request });
    });
  }

  check(request: BrowserProbeRequest): Promise<BrowserProbeResult> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.port.postMessage({ type: 'probe', id, request });
    });
  }
}

/** The fixed in-page script for interaction steps. Step data is passed as JSON, never as code. */
export const STEP_SCRIPT = `(async (step) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = async (sel, wait) => {
    const end = Date.now() + (wait ? 5000 : 0);
    for (;;) {
      const el = sel ? document.querySelector(sel) : document.activeElement;
      if (el || Date.now() >= end) return el;
      await sleep(100);
    }
  };
  try {
    if (step.action === 'expect-text') {
      const end = Date.now() + 5000;
      for (;;) {
        const scope = step.selector ? document.querySelector(step.selector) : document.body;
        const text = scope ? scope.innerText || scope.textContent || '' : '';
        if (text.includes(step.text || '')) return { ok: true, detail: 'found "' + (step.text || '').slice(0, 80) + '"' };
        if (Date.now() >= end) return { ok: false, detail: 'text "' + (step.text || '').slice(0, 80) + '" not found' + (step.selector ? ' in ' + step.selector : '') };
        await sleep(100);
      }
    }
    const el = await find(step.selector, true);
    if (!el) return { ok: false, detail: 'no element matches ' + step.selector };
    if (step.action === 'wait-for') return { ok: true, detail: step.selector + ' is present' };
    if (step.action === 'click') { el.scrollIntoView({ block: 'center' }); el.click(); await sleep(150); return { ok: true, detail: 'clicked ' + step.selector }; }
    if (step.action === 'fill') {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, step.text || '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: 'filled ' + step.selector };
    }
    if (step.action === 'press') {
      const key = step.key || 'Enter';
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      if (key === 'Enter' && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      await sleep(150);
      return { ok: true, detail: 'pressed ' + key };
    }
    return { ok: false, detail: 'unknown action' };
  } catch (e) {
    return { ok: false, detail: String(e && e.message || e) };
  }
})`;

/**
 * In-page script for one recording step. Step data is passed as JSON, never as code. Typing sets
 * the value one character at a time with input events so it is visible in the recording.
 */
export const RECORD_STEP_SCRIPT = `(async (step) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = async (sel) => {
    const end = Date.now() + 5000;
    for (;;) {
      const el = document.querySelector(sel);
      if (el || Date.now() >= end) return el;
      await sleep(100);
    }
  };
  try {
    if (step.kind === 'wait') { await sleep(Math.min(step.ms, 60000)); return { ok: true }; }
    if (step.kind === 'scroll') {
      const from = window.scrollY, to = step.y, ms = Math.max(1, Math.min(step.ms, 30000)), t0 = performance.now();
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        window.scrollTo(0, from + (to - from) * e);
        if (k >= 1) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { ok: true };
    }
    const el = await find(step.selector);
    if (!el) return { ok: false, detail: 'no element matches ' + step.selector };
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(400);
    if (step.kind === 'hover') {
      for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) el.dispatchEvent(new MouseEvent(t, { bubbles: t.endsWith('over') }));
      await sleep(600);
      return { ok: true };
    }
    if (step.kind === 'click') { el.click(); await sleep(500); return { ok: true }; }
    if (step.kind === 'type') {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      let value = '';
      for (const ch of String(step.text || '').slice(0, 500)) {
        value += ch;
        if (setter && setter.set) setter.set.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(70);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    return { ok: false, detail: 'unknown step' };
  } catch (e) {
    return { ok: false, detail: String(e && e.message || e) };
  }
})`;
