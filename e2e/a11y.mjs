/**
 * A small accessibility audit run inside the page (axe-core is not available offline here).
 * Checks: accessible names for controls, labels for form fields, duplicate ids, images without
 * alt text, and text contrast (WCAG AA: 4.5:1, or 3:1 for large text) against the composited
 * background. Glass surfaces are approximated by blending ancestor backgrounds over the theme base.
 */
export async function audit(page, scope = 'body') {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector) ?? document.body;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false; // includes visually hidden (sr-only) text
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[aria-hidden="true"], [inert]');
    };
    const describe = (el) => {
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
      return `${el.tagName.toLowerCase()}${id}${cls} “${(el.textContent ?? '').trim().slice(0, 40)}”`;
    };
    const nameOf = (el) => {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) return lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? '').join(' ').trim();
      const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return (el.getAttribute('aria-label') ?? '').trim() || (forLabel?.textContent ?? '').trim() || (el.textContent ?? '').trim() || (el.getAttribute('title') ?? '').trim() || (el.querySelector('img[alt]')?.getAttribute('alt') ?? '').trim();
    };
    const unnamed = [];
    for (const el of root.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="radio"], [role="switch"], [role="checkbox"]')) {
      if (!visible(el) || el.tagName === 'INPUT') continue;
      if (!nameOf(el)) unnamed.push(describe(el));
    }
    const unlabeled = [];
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (el.type === 'hidden' || !visible(el)) continue;
      const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.getAttribute('title');
      if (!labelled) unlabeled.push(describe(el));
    }
    const ids = new Map();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    const duplicateIds = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
    const noAlt = [...root.querySelectorAll('img')].filter((i) => visible(i) && !i.hasAttribute('alt')).map(describe);

    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    // The app canvas colour (wallpaper base) is what glass surfaces sit on.
    const probe = document.createElement('div');
    probe.style.background = 'var(--canvas)';
    document.body.appendChild(probe);
    const base = parse(getComputedStyle(probe).backgroundColor) ?? { r: 0, g: 0, b: 0, a: 1 };
    probe.remove();
    const backgroundOf = (el) => {
      const layers = [];
      for (let n = el; n; n = n.parentElement) {
        // A gradient or image behind the text cannot be composited here: report it as unknown.
        if (getComputedStyle(n).backgroundImage !== 'none') return null;
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) layers.push(c);
        if (c && c.a >= 1) break;
      }
      let bg = { ...base, a: 1 };
      for (const l of layers.reverse()) bg = over(l, bg);
      return bg;
    };
    const lowContrast = [];
    let unknown = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      if (!el || seen.has(el) || !t.textContent.trim() || !visible(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (el.closest('button:disabled, [aria-disabled="true"], .is-disabled, input:disabled + *, iframe, .tpl-schematic, svg')) continue;
      const fg = parse(cs.color);
      if (!fg || fg.a === 0) continue; // painted another way (gradient clip or pseudo-element layers)
      const bg = backgroundOf(el);
      if (!bg) {
        unknown += 1;
        continue;
      }
      const effective = over({ ...fg, a: fg.a * Number(cs.opacity || 1) }, bg);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const r = ratio(effective, bg);
      if (r < (large ? 3 : 4.5)) lowContrast.push(`${describe(el)} ${r.toFixed(2)}:1`);
    }
    return { unnamed, unlabeled, duplicateIds, noAlt, lowContrast, contrastUnknown: unknown };
  }, scope);
}
