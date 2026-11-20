import { Fragment, type ReactNode } from 'react';

/**
 * Minimal Markdown for model output: fenced code, headings, lists, paragraphs, inline code and
 * bold. Everything is rendered as React text nodes, never as HTML, so model output cannot inject
 * markup or scripts.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    out.push(token.startsWith('`') ? <code key={key++}>{token.slice(1, -1)}</code> : <strong key={key++}>{token.slice(2, -2)}</strong>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const newline = part.indexOf('\n');
      const lang = newline > 0 ? part.slice(0, newline).trim() : '';
      const code = newline >= 0 ? part.slice(newline + 1) : part;
      blocks.push(
        <pre key={`c${i}`} className="md-code" data-lang={lang || undefined}>
          <code>{code.replace(/\n$/, '')}</code>
        </pre>,
      );
      return;
    }
    const lines = part.split('\n');
    let list: { ordered: boolean; items: string[] } | null = null;
    let para: string[] = [];
    const flushPara = (k: string): void => {
      if (para.length) blocks.push(<p key={k}>{inline(para.join(' '))}</p>);
      para = [];
    };
    const flushList = (k: string): void => {
      if (!list) return;
      const items = list.items.map((it, n) => <li key={n}>{inline(it)}</li>);
      blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      list = null;
    };
    lines.forEach((line, n) => {
      const k = `${i}-${n}`;
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        flushPara(`p${k}`);
        const ordered = Boolean(numbered);
        if (list && list.ordered !== ordered) flushList(`l${k}`);
        list = list ?? { ordered, items: [] };
        list.items.push((bullet ?? numbered)![1]!);
      } else if (heading) {
        flushPara(`p${k}`);
        flushList(`l${k}`);
        blocks.push(<p key={`h${k}`} className="md-heading">{inline(heading[2]!)}</p>);
      } else if (!line.trim()) {
        flushPara(`p${k}`);
        flushList(`l${k}`);
      } else {
        flushList(`l${k}`);
        para.push(line.trim());
      }
    });
    flushPara(`p${i}-end`);
    flushList(`l${i}-end`);
  });
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
