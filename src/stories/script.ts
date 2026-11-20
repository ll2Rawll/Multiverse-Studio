/**
 * The fixed in-page script that runs one story step. Step data is passed as JSON, never as code.
 * Locators are resolved like a person would: test id, stable id, role and accessible name, label,
 * placeholder, visible text, CSS. In recording mode a pointer moves to each target and typing is
 * visible; in both modes every action and assertion reports whether it really happened.
 */
/** Locator resolution shared by story runs and the preview bridge (for live activity geometry). */
export const LOCATOR_JS = `
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => !!el && (el.getClientRects().length > 0) && getComputedStyle(el).visibility !== 'hidden';
  const textOf = (el) => norm(el.innerText || el.textContent || '');
  const labelText = (el) => {
    if (el.getAttribute('aria-label')) return norm(el.getAttribute('aria-label'));
    const by = el.getAttribute('aria-labelledby');
    if (by) return norm(by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' '));
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return textOf(l); }
    const wrap = el.closest('label'); if (wrap) return textOf(wrap);
    return '';
  };
  const nameOf = (el) => {
    const l = labelText(el); if (l) return l;
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return norm(el.value);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return norm(el.getAttribute('placeholder') || el.getAttribute('title') || '');
    if (el.tagName === 'IMG') return norm(el.getAttribute('alt'));
    return textOf(el) || norm(el.getAttribute('title'));
  };
  const ROLES = {
    button: 'button, [role=button], input[type=button], input[type=submit], input[type=reset], summary',
    link: 'a[href], [role=link]',
    checkbox: 'input[type=checkbox], [role=checkbox]',
    radio: 'input[type=radio], [role=radio]',
    textbox: 'input:not([type]), input[type=text], input[type=email], input[type=search], input[type=password], input[type=tel], input[type=url], input[type=number], textarea, [role=textbox], [contenteditable=true]',
    combobox: 'select, [role=combobox]',
    heading: 'h1, h2, h3, h4, h5, h6, [role=heading]',
    listitem: 'li, [role=listitem]',
    tab: '[role=tab]',
    img: 'img, [role=img]',
  };
  const all = (loc) => {
    if (!loc) return [document.body];
    let list = [];
    if (loc.by === 'testid') list = Array.from(document.querySelectorAll('[data-testid="' + CSS.escape(loc.value) + '"]'));
    else if (loc.by === 'mv-id') { list = Array.from(document.querySelectorAll('[data-mv-id="' + CSS.escape(loc.value) + '"]')); if (!list.length) { const e = document.getElementById(loc.value); if (e) list = [e]; } }
    else if (loc.by === 'css') { try { list = Array.from(document.querySelectorAll(loc.value)); } catch (e) { list = []; } }
    else if (loc.by === 'placeholder') list = Array.from(document.querySelectorAll('[placeholder]')).filter((e) => norm(e.getAttribute('placeholder')) === norm(loc.value));
    else if (loc.by === 'label') {
      const want = norm(loc.name);
      list = Array.from(document.querySelectorAll('input, textarea, select, [role=textbox], [role=checkbox], [contenteditable=true]')).filter((e) => labelText(e) === want);
      if (!list.length) list = Array.from(document.querySelectorAll('input, textarea, select')).filter((e) => labelText(e).includes(want));
    } else if (loc.by === 'role') {
      const sel = ROLES[loc.role] || '[role="' + loc.role + '"]';
      const cands = Array.from(document.querySelectorAll(sel));
      const want = norm(loc.name);
      list = cands.filter((e) => nameOf(e) === want);
      if (!list.length && want) list = cands.filter((e) => nameOf(e).includes(want));
    } else if (loc.by === 'text') {
      const want = norm(loc.text);
      const cands = Array.from(document.body.querySelectorAll('*')).filter((e) => !/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(e.tagName));
      const exact = cands.filter((e) => textOf(e) === want);
      list = exact.length ? exact : cands.filter((e) => textOf(e).includes(want));
      list = list.filter((e) => !list.some((o) => o !== e && e.contains(o)));
    }
    return list.filter(visible);
  };
`;

export const STORY_STEP_SCRIPT = `(async (step, opts) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  ${LOCATOR_JS}
  const describe = (loc) => !loc ? 'the page' : loc.by === 'role' ? loc.role + ' "' + loc.name + '"' : loc.by === 'label' ? 'field "' + loc.name + '"' : loc.by === 'text' ? '"' + loc.text + '"' : (loc.value || '');
  const find = async (loc, ms) => {
    const end = Date.now() + ms;
    for (;;) { const l = all(loc); if (l.length || Date.now() >= end) return l[0] || null; await sleep(80); }
  };
  const record = opts && opts.mode === 'record';
  let pointer = document.getElementById('__mv_pointer');
  const point = async (el) => {
    if (!record) return;
    if (!pointer) {
      pointer = document.createElement('div'); pointer.id = '__mv_pointer';
      if (opts && opts.aiPointer) {
        // “Include AI activity”: the studio's AI pointer, labelled, instead of the neutral demo pointer.
        pointer.setAttribute('style', 'position:fixed!important;z-index:2147483647!important;left:50%;top:50%;width:0;height:0;pointer-events:none!important;transition:left .3s cubic-bezier(.22,.8,.24,1),top .3s cubic-bezier(.22,.8,.24,1),transform .15s ease;');
        pointer.innerHTML = '<svg width="20" height="24" viewBox="0 0 20 24" style="position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 2px 3px rgba(10,12,30,.35))"><path d="M3 2 L3 19 L7.6 15 L10.6 21.6 L13.4 20.4 L10.5 13.9 L16.6 13.6 Z" fill="#9aa1ff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg><span style="position:absolute;left:15px;top:17px;font:600 10px/1 system-ui,sans-serif;color:#1d2140;background:#dfe2ff;border:1px solid rgba(29,33,64,.18);padding:3px 5px;border-radius:999px">AI</span>';
      } else
      pointer.setAttribute('style', 'position:fixed!important;z-index:2147483647!important;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(20,20,30,.55);border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none!important;transition:left .45s ease,top .45s ease,transform .15s ease;');
      document.documentElement.appendChild(pointer);
    }
    const r = el.getBoundingClientRect();
    pointer.style.left = (r.left + r.width / 2) + 'px'; pointer.style.top = (r.top + r.height / 2) + 'px';
    await sleep(500);
  };
  const press = async () => { if (!pointer) return; pointer.style.transform = 'scale(.75)'; await sleep(140); pointer.style.transform = ''; };
  try {
    if (step.kind === 'verify') {
      const e = step.expect || {};
      const end = Date.now() + 4000;
      let last = '';
      for (;;) {
        const list = all(step.target);
        const el = list[0] || null;
        let ok = true;
        if (e.absent) { ok = list.length === 0; last = ok ? 'is gone' : describe(step.target) + ' is still there'; }
        else if (!el) { ok = false; last = 'nothing matches ' + describe(step.target); }
        else {
          if (ok && e.count !== undefined) { ok = list.length === e.count; last = 'found ' + list.length + ', expected ' + e.count; }
          if (ok && e.text !== undefined) { ok = textOf(el).includes(norm(e.text)) || (step.target && list.some((x) => textOf(x).includes(norm(e.text)))); last = ok ? 'shows "' + e.text + '"' : describe(step.target) + ' does not show "' + e.text + '"'; }
          if (ok && e.checked !== undefined) { const c = el.checked === true || el.getAttribute('aria-checked') === 'true'; ok = c === e.checked; last = ok ? (c ? 'is checked' : 'is not checked') : (c ? 'is checked, expected not checked' : 'is not checked, expected checked'); }
          if (ok && e.value !== undefined) { ok = String(el.value) === e.value; last = ok ? 'has value "' + e.value + '"' : 'value is "' + String(el.value) + '", expected "' + e.value + '"'; }
          if (ok && !last) last = describe(step.target) + ' is visible';
        }
        if (ok) return { ok: true, detail: last };
        if (Date.now() >= end) return { ok: false, detail: last };
        await sleep(100);
      }
    }
    const el = await find(step.target, step.kind === 'wait' ? 8000 : 5000);
    if (!el) return { ok: false, detail: 'nothing matches ' + describe(step.target) };
    if (step.kind === 'wait') return { ok: true, detail: describe(step.target) + ' appeared' };
    el.scrollIntoView({ block: 'center', behavior: record ? 'smooth' : 'auto' });
    if (record) await sleep(250);
    if (step.kind === 'click') {
      await point(el); await press();
      el.click();
      await sleep(record ? 250 : 60);
      return { ok: true, detail: 'clicked ' + describe(step.target) };
    }
    if (step.kind === 'fill') {
      await point(el);
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const text = String(step.text || '');
      if (record && !(el instanceof HTMLSelectElement)) {
        for (let i = 1; i <= text.length; i++) { setter.call(el, text.slice(0, i)); el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(Math.max(10, Math.min(400, (opts && opts.typingMsPerChar) || 45))); }
      } else { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: String(el.value) === text, detail: String(el.value) === text ? 'typed "' + text.slice(0, 60) + '"' : 'the field did not take the text' };
    }
    if (step.kind === 'press') {
      const key = step.key || 'Enter';
      el.focus();
      const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      const proceed = el.dispatchEvent(down);
      if (proceed && key === 'Enter' && el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
      el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      await sleep(record ? 250 : 60);
      return { ok: true, detail: 'pressed ' + key };
    }
    return { ok: false, detail: 'unknown step ' + step.kind };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  }
})`;
