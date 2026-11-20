/**
 * A small script injected into previewed HTML documents (never into the user's
 * source files). It runs inside the sandboxed, opaque-origin preview frame and only
 * talks to the parent with postMessage: runtime errors, scroll position for
 * synchronized scrolling, blocked external links, section picking, and Design mode
 * (select an element, edit its text in place). The parent treats every message as
 * untrusted input; edits are applied to the source by the app, never by this script.
 *
 * Live AI activity asks for the position of one named element at a time (`measure`); the answer
 * is only a rectangle in the frame's own coordinates.
 */
import { LOCATOR_JS } from '../stories/script';

export const BRIDGE_SCRIPT = `(function(){
  if (window.__mvBridge) return; window.__mvBridge = true;
  var P = window.parent; if (!P || P === window) return;
  function send(m){ try { m.__mv = 1; P.postMessage(m, '*'); } catch (e) {} }
  window.addEventListener('error', function(e){
    if (e && e.target && e.target !== window && e.target.tagName) {
      var t = e.target; var ref = t.currentSrc || t.src || t.href || '';
      send({ type: 'error', kind: 'resource', message: 'Could not load ' + String(ref).split('/').slice(3).join('/'), source: '', line: 0, column: 0 });
      return;
    }
    send({ type: 'error', kind: 'script', message: String((e && e.message) || 'Script error'), source: String((e && e.filename) || '').split('/').slice(3).join('/'), line: (e && e.lineno) || 0, column: (e && e.colno) || 0 });
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason; send({ type: 'error', kind: 'script', message: 'Unhandled promise rejection: ' + String((r && r.message) || r), source: '', line: 0, column: 0 });
  });
  var suppressUntil = 0, scheduled = false;
  function scroller(){ return document.scrollingElement || document.documentElement; }
  function report(){ scheduled = false; var el = scroller(); var max = Math.max(1, el.scrollHeight - window.innerHeight); send({ type: 'scroll', ratio: Math.min(1, Math.max(0, el.scrollTop / max)), top: el.scrollTop }); }
  window.addEventListener('scroll', function(){ if (Date.now() < suppressUntil) return; if (!scheduled) { scheduled = true; requestAnimationFrame(report); } }, { passive: true });
  var picking = false, keys = [], overlay = null, label = null, current = null;
  function resolveKey(key){
    if (key.charAt(0) === '#') return document.getElementById(key.slice(1));
    var m = /^([a-z][a-z0-9-]*)(?::nth\\((\\d+)\\))?$/.exec(key); if (!m) return null;
    var all = Array.prototype.filter.call(document.querySelectorAll(m[1]), function(el){ return !((m[1] === 'footer' || m[1] === 'header') && el.parentElement && el.parentElement.closest('blockquote, figure')); });
    return all[(m[2] ? Number(m[2]) : 1) - 1] || null;
  }
  function sectionAt(node){
    var best = null;
    for (var i = 0; i < keys.length; i++) { var el = resolveKey(keys[i]); if (el && el.contains(node) && (!best || best.el.contains(el))) best = { el: el, key: keys[i] }; }
    return best;
  }
  function ensureOverlay(){
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.setAttribute('style', 'position:fixed!important;pointer-events:none!important;z-index:2147483647!important;border:2px solid #8b93ff!important;border-radius:6px!important;background:rgba(139,147,255,0.12)!important;box-sizing:border-box!important;transition:all 120ms ease!important;display:none;');
    label = document.createElement('div');
    label.setAttribute('style', 'position:absolute!important;left:6px!important;top:6px!important;font:600 11px/1.4 system-ui,sans-serif!important;color:#fff!important;background:#5b63e6!important;padding:2px 8px!important;border-radius:999px!important;');
    overlay.appendChild(label); document.documentElement.appendChild(overlay);
  }
  function highlight(hit){
    ensureOverlay(); current = hit;
    if (!hit) { overlay.style.display = 'none'; return; }
    var r = hit.el.getBoundingClientRect();
    overlay.style.display = 'block'; overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px'; overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
    label.textContent = hit.key;
  }
  /* ---- Design mode: elements are addressed by data-mv-id, else by their index path under <body>. ---- */
  var designOn = false, selTarget = null, selBox = null, editing = null, editingOriginal = '';
  var SKIP = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1, SVG: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1 };
  function kids(el){ var out = []; for (var i = 0; i < el.children.length; i++) { var c = el.children[i]; if (!SKIP[String(c.tagName).toUpperCase()]) out.push(c); } return out; }
  function pathOfEl(el){ var parts = [], cur = el; while (cur && cur !== document.body) { var p = cur.parentElement; if (!p) return null; parts.unshift(kids(p).indexOf(cur)); cur = p; } return cur === document.body ? parts.join('.') : null; }
  function byPath(path){ var cur = document.body; if (!path) return cur; var parts = String(path).split('.'); for (var i = 0; i < parts.length; i++) { cur = kids(cur)[Number(parts[i])]; if (!cur) return null; } return cur; }
  function targetEl(t){ if (!t) return null; if (t.id) { var all = document.querySelectorAll('[data-mv-id]'); for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-mv-id') === t.id) return all[i]; } return typeof t.path === 'string' ? byPath(t.path) : null; }
  function pickable(node){ var el = node && node.nodeType === 1 ? node : node && node.parentElement; while (el && el.closest && el.closest('svg')) el = el.closest('svg').parentElement; if (!el || el === document.documentElement || el === document.body || el === overlay || el === selBox) return null; return el; }
  function describe(el){ var id = el.getAttribute('data-mv-id'); return el.tagName.toLowerCase() + (id ? ' · ' + id : ''); }
  function textOnly(el){ for (var i = 0; i < el.children.length; i++) if (el.children[i].tagName !== 'BR') return false; return true; }
  function placeSel(){
    if (!selBox) { selBox = document.createElement('div'); selBox.setAttribute('style', 'position:fixed!important;pointer-events:none!important;z-index:2147483646!important;border:2px solid #ff9a52!important;border-radius:4px!important;box-sizing:border-box!important;display:none;'); document.documentElement.appendChild(selBox); }
    var el = designOn ? targetEl(selTarget) : null;
    if (!el) { selBox.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    selBox.style.display = 'block'; selBox.style.left = r.left + 'px'; selBox.style.top = r.top + 'px'; selBox.style.width = r.width + 'px'; selBox.style.height = r.height + 'px';
  }
  var placing = false;
  function schedulePlace(){ if (!placing) { placing = true; requestAnimationFrame(function(){ placing = false; placeSel(); }); } }
  window.addEventListener('scroll', schedulePlace, { passive: true, capture: true });
  window.addEventListener('resize', schedulePlace);
  function finishEdit(commit){
    var el = editing; if (!el) return; editing = null;
    el.removeAttribute('contenteditable');
    var text = el.innerText.replace(/\u00a0/g, ' ');
    if (!commit) { el.innerText = editingOriginal; return; }
    if (text !== editingOriginal) send({ type: 'design-text', id: el.getAttribute('data-mv-id'), path: pathOfEl(el), text: text.slice(0, 5000) });
  }
  function startEdit(el){
    if (editing || !textOnly(el)) return;
    editing = el; editingOriginal = el.innerText;
    el.setAttribute('contenteditable', 'plaintext-only'); el.focus();
    try { var range = document.createRange(); range.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(range); } catch (err) {}
    el.addEventListener('blur', function onBlur(){ el.removeEventListener('blur', onBlur); finishEdit(true); });
  }
  document.addEventListener('mousemove', function(e){
    if (picking) { highlight(sectionAt(e.target)); return; }
    if (designOn && !editing) { var el = pickable(e.target); if (el) { highlight({ el: el, key: describe(el) }); } else highlight(null); }
  }, true);
  document.addEventListener('dblclick', function(e){ if (!designOn) return; var el = pickable(e.target); if (el) { e.preventDefault(); startEdit(el); } }, true);
  document.addEventListener('submit', function(e){ if (designOn) e.preventDefault(); }, true);
  document.addEventListener('click', function(e){
    if (designOn) {
      if (editing && editing.contains(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      var el = pickable(e.target); if (!el) return;
      selTarget = { id: el.getAttribute('data-mv-id'), path: pathOfEl(el) }; placeSel();
      send({ type: 'design-select', id: selTarget.id, path: selTarget.path, tag: el.tagName.toLowerCase() });
      return;
    }
    if (picking) { e.preventDefault(); e.stopPropagation(); var hit = sectionAt(e.target); if (hit) send({ type: 'picked', key: hit.key }); return; }
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null; if (!a) return;
    var href = a.getAttribute('href') || ''; if (href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
    var url; try { url = new URL(href, location.href); } catch (err) { return; }
    if (url.origin !== location.origin) { e.preventDefault(); send({ type: 'blocked-navigation', url: url.href }); return; }
    if (a.target && a.target !== '_self') { e.preventDefault(); location.href = url.href; }
  }, true);
  document.addEventListener('keydown', function(e){
    if (picking && e.key === 'Escape') send({ type: 'pick-cancel' });
    if (editing) { if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editing.blur(); } }
    else if (designOn && e.key === 'Escape') { selTarget = null; placeSel(); send({ type: 'design-select', id: null, path: null, tag: null }); }
  }, true);
  /* ---- Story recording: user actions become story steps with robust locators (sent to the app, never run here). ---- */
  var recording = false, lastFill = null, lastEnter = null;
  function norm(v){ return String(v == null ? '' : v).replace(/\\s+/g, ' ').trim(); }
  function labelOf(el){
    if (el.getAttribute('aria-label')) return norm(el.getAttribute('aria-label'));
    if (el.id) { var l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); if (l) return norm(l.innerText || l.textContent); }
    var w = el.closest('label'); if (w) return norm(w.innerText || w.textContent);
    return '';
  }
  function cssPath(el){
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      var tag = cur.tagName.toLowerCase(); var p = cur.parentElement; if (!p) break;
      var same = Array.prototype.filter.call(p.children, function(c){ return c.tagName === cur.tagName; });
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag);
      if (cur.id && /^[A-Za-z][\\w-]*$/.test(cur.id)) { parts[0] = '#' + cur.id; break; }
      cur = p;
    }
    return parts.join(' > ');
  }
  function locatorFor(el){
    if (el.getAttribute('data-testid')) return { by: 'testid', value: el.getAttribute('data-testid') };
    if (el.getAttribute('data-mv-id')) return { by: 'mv-id', value: el.getAttribute('data-mv-id') };
    var tag = el.tagName, type = String(el.type || '').toLowerCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      var lab = labelOf(el);
      if (type === 'checkbox' || type === 'radio') return lab ? { by: 'role', role: type, name: lab } : { by: 'css', value: cssPath(el) };
      if (type === 'submit' || type === 'button') return { by: 'role', role: 'button', name: norm(el.value) };
      if (lab) return { by: 'label', name: lab };
      if (el.getAttribute('placeholder')) return { by: 'placeholder', value: el.getAttribute('placeholder') };
      return { by: 'css', value: cssPath(el) };
    }
    var name = norm(el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('title'));
    if (tag === 'A' && name) return { by: 'role', role: 'link', name: name.slice(0, 120) };
    if ((tag === 'BUTTON' || tag === 'SUMMARY' || el.getAttribute('role') === 'button') && name) return { by: 'role', role: 'button', name: name.slice(0, 120) };
    if (el.getAttribute('role') && name) return { by: 'role', role: el.getAttribute('role'), name: name.slice(0, 120) };
    if (name && name.length <= 80) return { by: 'text', text: name };
    return { by: 'css', value: cssPath(el) };
  }
  function emit(step){ send({ type: 'story-step', step: step }); }
  function textField(el){ var t = String(el.type || 'text').toLowerCase(); return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|email|search|password|tel|url|number)$/.test(t)) || el.isContentEditable; }
  function flushFill(el){
    if (!el || !textField(el)) return;
    var loc = locatorFor(el), key = JSON.stringify(loc) + '|' + el.value;
    if (lastFill === key) return; lastFill = key;
    emit({ kind: 'fill', target: loc, text: String(el.value || '') });
  }
  document.addEventListener('click', function(e){
    if (!recording) return;
    var t = e.target && e.target.closest ? e.target.closest('button, a[href], summary, [role=button], [role=link], [role=tab], [role=checkbox], input[type=checkbox], input[type=radio], input[type=submit], input[type=button], label, [data-testid]') : null;
    if (!t) return;
    // Enter in a field already became a press step; the browser's implicit submit click is part of it.
    if (lastEnter && e.detail === 0 && t.form && t.form === lastEnter.form && Date.now() - lastEnter.at < 250) return;
    if (t.tagName === 'LABEL') { var c = t.control || t.querySelector('input, select, textarea'); if (!c || textField(c)) return; t = c; }
    if (textField(t)) return;
    var a = document.activeElement; if (a && a !== t && textField(a)) flushFill(a);
    emit({ kind: 'click', target: locatorFor(t) });
  }, true);
  document.addEventListener('change', function(e){
    if (!recording || !e.target) return;
    var el = e.target;
    if (textField(el)) flushFill(el);
    else if (el.tagName === 'SELECT') emit({ kind: 'fill', target: locatorFor(el), text: String(el.value) });
  }, true);
  document.addEventListener('keydown', function(e){
    if (!recording || !e.target) return;
    if (e.key === 'Enter' && textField(e.target) && e.target.tagName !== 'TEXTAREA') { flushFill(e.target); emit({ kind: 'press', target: locatorFor(e.target), key: 'Enter' }); lastEnter = { form: e.target.form || null, at: Date.now() }; }
  }, true);
  window.addEventListener('message', function(e){
    if (e.source !== P) return; var d = e.data; if (!d || d.__mv !== 1) return;
    if (d.type === 'scroll-to') { suppressUntil = Date.now() + 160; var el = scroller(); var max = Math.max(0, el.scrollHeight - window.innerHeight); el.scrollTop = typeof d.top === 'number' ? d.top : Math.round((Number(d.ratio) || 0) * max); }
    else if (d.type === 'pick') { picking = true; keys = Array.isArray(d.keys) ? d.keys.slice(0, 500).map(String) : []; document.documentElement.style.cursor = 'crosshair'; }
    else if (d.type === 'pick-stop') { picking = false; keys = []; highlight(null); document.documentElement.style.cursor = ''; }
    else if (d.type === 'record') { recording = !!d.on; lastFill = null; }
    else if (d.type === 'measure') measure(d);
    else if (d.type === 'design') { designOn = !!d.on; selTarget = d.selected && typeof d.selected === 'object' ? { id: d.selected.id ? String(d.selected.id) : null, path: typeof d.selected.path === 'string' ? d.selected.path : null } : null; if (!designOn) { highlight(null); finishEdit(false); } placeSel(); }
  });
  var mvLocate = null;
  function measure(d){
    var id = Number(d.id) || 0, el = null, t = d.target || {};
    try {
      if (t.kind === 'element') el = (t.id ? document.querySelector('[data-mv-id="' + CSS.escape(String(t.id)) + '"]') : null) || (typeof t.path === 'string' ? byPath(t.path) : null);
      else if (t.kind === 'locator' && t.locator && typeof t.locator === 'object') { if (!mvLocate) mvLocate = (function(){ ${LOCATOR_JS} return all; })(); el = mvLocate(t.locator)[0] || null; }
    } catch (e) { el = null; }
    if (el && d.reveal) { var b = el.getBoundingClientRect(); if (b.top < 0 || b.bottom > window.innerHeight) el.scrollIntoView({ block: 'nearest' }); }
    var r = el ? el.getBoundingClientRect() : null;
    var radius = el ? (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) : 0;
    send({ type: 'measure-result', id: id, rect: r && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height, r: radius } : null });
  }
  function ready(){ send({ type: 'ready', title: document.title || '', height: scroller().scrollHeight, path: location.pathname }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();`;
