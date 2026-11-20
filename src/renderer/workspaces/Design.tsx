/**
 * Design: visual editing of HTML pages where the source stays the truth. Every action is a
 * command (design.*) that rewrites the page's HTML or design.css exactly; the preview reloads
 * from the new source. Undo and redo use the command layer, so they survive restarts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSelectionRefs } from '../state/selection';
import { useStudio, toast } from '../state/store';
import { useFoldSidebar } from '../lib/hooks';
import { setWorkspace } from '../state/actions';
import { call, errorMessage, ApiError } from '../lib/api';
import { PreviewFrame, type DesignTarget } from '../components/PreviewFrame';
import { Button, EmptyState, IconButton, SegmentedControl } from '../components/primitives';
import { Menu } from '../components/Menu';
import { Icon } from '../components/Icon';
import { cx, lineRef, type Viewport } from '../lib/util';
import type { DesignBreakpoint, DesignNodeView, DesignPageView } from '../../shared/design';

import { useDesignUi } from '../state/designUi';

const BREAKPOINT_OPTIONS: { value: DesignBreakpoint; label: string; icon: string }[] = [
  { value: 'desktop', label: 'Desktop', icon: 'desktop' },
  { value: 'tablet', label: 'Tablet', icon: 'tablet' },
  { value: 'mobile', label: 'Mobile', icon: 'mobile' },
];

const targetOf = (t: DesignTarget): { id: string } | { path: string } => (t.id ? { id: t.id } : { path: t.path ?? '' });

function findNode(nodes: DesignNodeView[], t: DesignTarget | null): DesignNodeView | null {
  if (!t) return null;
  for (const n of nodes) {
    if ((t.id && n.mvId === t.id) || (!t.id && t.path !== null && n.path === t.path)) return n;
    const hit = findNode(n.children, t);
    if (hit) return hit;
  }
  return null;
}

function sectionOf(sections: DesignNodeView[], t: DesignTarget | null): DesignNodeView | null {
  if (!t) return null;
  return sections.find((s) => findNode([s], t)) ?? null;
}

/* ---------------- outline ---------------- */

function OutlineNode({ node, depth, selected, onSelect }: { node: DesignNodeView; depth: number; selected: DesignNodeView | null; onSelect: (n: DesignNodeView) => void }) {
  const [open, setOpen] = useState(depth === 0 ? false : true);
  const isSelected = selected?.key === node.key;
  const contains = selected && !isSelected && findNode(node.children, { id: selected.mvId, path: selected.path });
  const expanded = open || Boolean(contains);
  const icon = node.kind === 'section' ? 'layers' : node.kind === 'image' ? 'image' : node.kind === 'link' || node.kind === 'button' ? 'link' : node.kind === 'text' ? 'text' : 'grid';
  return (
    <li>
      <div className={cx('outline-row', isSelected && 'is-selected')} style={{ paddingLeft: 6 + depth * 14 }}>
        {node.children.length > 0 ? (
          <button type="button" className="outline-twisty" aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
        ) : (
          <span className="outline-twisty" />
        )}
        <button type="button" className="outline-label" onClick={() => onSelect(node)} aria-current={isSelected ? 'true' : undefined}>
          <Icon name={icon} size={13} />
          <span>{node.label}</span>
          {node.component && <span className="outline-badge">Component</span>}
          {node.object && <span className="outline-badge">Object</span>}
        </button>
      </div>
      {expanded && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <OutlineNode key={c.key} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ---------------- property fields ---------------- */

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="prop-row">
      <span className="prop-label">
        {label}
        {hint && <span className="prop-hint">{hint}</span>}
      </span>
      <span className="prop-control">{children}</span>
    </label>
  );
}

/** A text input that commits on Enter or blur and only when the value changed. */
function CommitInput({ value, onCommit, placeholder, multiline, label }: { value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; label?: string }) {
  const [draft, setDraft] = useState(value);
  // Enter (or Ctrl+Enter) commits, and so does the blur that follows; send each value once.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    setDraft(value);
    sent.current = null;
  }, [value]);
  const commit = (): void => {
    if (draft !== value && draft !== sent.current) {
      sent.current = draft;
      onCommit(draft);
    }
  };
  if (multiline)
    return (
      <textarea
        className="input textarea prop-input"
        aria-label={label}
        rows={3}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
          if (e.key === 'Escape') setDraft(value);
        }}
      />
    );
  return (
    <input
      className="input prop-input"
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

const isHex = (v: string): boolean => /^#[0-9a-f]{6}$/i.test(v.trim());

function StyleField({ prop, label, value, inherited, onCommit, kind = 'text', options }: { prop: string; label: string; value: string; inherited: string | null; onCommit: (prop: string, v: string | null) => void; kind?: 'text' | 'color' | 'select'; options?: string[] }) {
  return (
    <Row label={label} hint={!value && inherited ? `from wider screens: ${inherited}` : undefined}>
      {kind === 'color' && <input type="color" className="prop-swatch" aria-label={`${label} picker`} value={isHex(value) ? value : isHex(inherited ?? '') ? inherited! : '#000000'} onChange={(e) => onCommit(prop, e.target.value)} />}
      {kind === 'select' ? (
        <select className="input prop-input" value={value} aria-label={label} onChange={(e) => onCommit(prop, e.target.value || null)}>
          <option value="">{inherited ? `Inherited (${inherited})` : 'Not set'}</option>
          {options!.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <CommitInput label={label} value={value} placeholder={inherited ?? 'Not set'} onCommit={(v) => onCommit(prop, v.trim() || null)} />
      )}
      {value && <IconButton icon="close" size="sm" label={`Clear ${label}`} onClick={() => onCommit(prop, null)} />}
    </Row>
  );
}

/* ---------------- main ---------------- */

export function Design() {
  const project = useStudio((s) => s.project)!;
  const lineId = useStudio((s) => s.selectedLineId);
  const version = useStudio((s) => s.previewVersions[s.selectedLineId] ?? 0);
  const ui = useDesignUi();
  const page = ui.page[`${project.id}:${lineId}`] ?? 'index.html';
  const [view, setView] = useState<DesignPageView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DesignTarget | null>(null);
  const [busy, setBusy] = useState(false);

  // The latest outline, read by queued commands (state in a closure may be one edit behind).
  const viewRef = useRef<DesignPageView | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const load = useCallback(async (): Promise<DesignPageView | null> => {
    try {
      const v = await call('design.describe', { projectId: project.id, lineId, page });
      viewRef.current = v;
      setView(v);
      setLoadError(null);
      return v;
    } catch (error) {
      setLoadError(errorMessage(error));
      return null;
    }
  }, [project.id, lineId, page]);

  // Design needs width for the canvas: fold the project sidebar away while here (the outline replaces it).
  useFoldSidebar();

  useEffect(() => {
    void load();
  }, [load, version]);
  useEffect(() => setSelected(null), [project.id, lineId, page]);

  /** Run a design command against the source; refresh the outline and keep the selection. */
  /**
   * Edits made in quick succession (apply text, then change the link) run one after another, each
   * against the outline the previous one produced, so the second is not rejected as stale.
   */
  const run = (name: string, args: Record<string, unknown>, keep: DesignTarget | null = selected): Promise<boolean> => {
    const next = queue.current.then(() => runNow(name, args, keep));
    queue.current = next.catch(() => undefined);
    return next;
  };
  const runNow = async (name: string, args: Record<string, unknown>, keep: DesignTarget | null): Promise<boolean> => {
    const current = viewRef.current;
    if (!current) return false;
    setBusy(true);
    try {
      await call('commands.run', { projectId: project.id, lineId, name, args, expected: current.hashes });
      const next = await load();
      // An element selected by path gains a data-mv-id on its first edit; follow it.
      if (keep && next) {
        const node = keep.id ? findNode(next.sections, keep) : findNode(next.sections, { id: null, path: keep.path });
        setSelected(node ? { id: node.mvId, path: node.path } : keep);
      }
      return true;
    } catch (error) {
      const stale = error instanceof ApiError && error.code === 'stale-command';
      toast({ tone: stale ? 'warning' : 'error', title: stale ? 'The page changed in code' : 'Could not apply the change', body: stale ? 'The outline has been refreshed. Try again.' : errorMessage(error) });
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const step = async (scope: string, direction: 'undo' | 'redo'): Promise<void> => {
    try {
      const r = await call('commands.step', { projectId: project.id, lineId, scope, direction });
      if (r.label) toast({ tone: 'info', title: `${direction === 'undo' ? 'Undid' : 'Redid'}: ${r.label}` });
      await load();
    } catch (error) {
      toast({ tone: 'error', title: `Could not ${direction}`, body: errorMessage(error) });
    }
  };

  const node = view ? findNode(view.sections, selected) : null;
  // Offer the selected element to the Assistant as a reference (by its stable data-mv-id).
  useEffect(() => {
    useSelectionRefs.setState({ design: node?.mvId ? { page, id: node.mvId, label: node.label } : null });
  }, [node?.mvId, node?.label, page]);
  useEffect(() => () => useSelectionRefs.setState({ design: null }), []);
  const section = view ? sectionOf(view.sections, selected) : null;
  const sectionIndex = section && view ? view.sections.indexOf(section) : -1;
  const viewport: Viewport = ui.breakpoint;
  const setPage = (p: string): void => useDesignUi.setState((s) => ({ page: { ...s.page, [`${project.id}:${lineId}`]: p } }));

  if (project.kind === 'app' && view && !view.supported) {
    return (
      <div className="design">
        <DesignBar view={view} page={page} setPage={setPage} step={step} />
        <EmptyState icon="code" title="This app is drawn by code" body={view.reason ?? 'Edit its components in Build.'}>
          <Button icon="code" onClick={() => setWorkspace('build')}>
            Open in Build
          </Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="design">
      <DesignBar view={view} page={page} setPage={setPage} step={step} />
      {loadError && <p className="info-banner">{loadError}</p>}
      <div className="design-body">
        <aside className="design-left material-solid" aria-label="Page structure">
          <SegmentedControl
            size="sm"
            label="Design panel"
            className="design-tabs"
            options={[
              { value: 'outline', label: 'Outline' },
              { value: 'add', label: 'Add' },
              { value: 'pages', label: 'Pages' },
              { value: 'theme', label: 'Theme' },
            ]}
            value={ui.tab}
            onChange={(tab) => useDesignUi.setState({ tab })}
          />
          <div className="design-left-scroll">
            {!view ? null : ui.tab === 'outline' ? (
              view.supported ? (
                view.sections.length ? (
                  <ul className="outline-tree" aria-label="Sections and elements">
                    {view.sections.map((s) => (
                      <OutlineNode key={s.key} node={s} depth={0} selected={node} onSelect={(n) => setSelected({ id: n.mvId, path: n.path })} />
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">This page has no sections yet. Add one from the Add tab.</p>
                )
              ) : (
                <p className="muted small">{view.reason}</p>
              )
            ) : ui.tab === 'add' ? (
              <AddPanel view={view} afterIndex={sectionIndex} run={run} />
            ) : ui.tab === 'pages' ? (
              <PagesPanel view={view} page={page} setPage={setPage} run={run} />
            ) : (
              <ThemePanel view={view} run={run} step={step} />
            )}
          </div>
        </aside>

        <section className="design-canvas" aria-label="Page canvas">
          <div className="design-canvas-frame">
            <PreviewFrame
              projectId={project.id}
              contentRef={lineRef(lineId)}
              version={version}
              viewport={viewport}
              interactive
              path={page}
              title={`${page} in Design`}
              design={{ selected }}
              onDesignSelect={(t) => setSelected(t)}
              onDesignText={(t, text) => void run('design.setText', { page, target: targetOf(t), text }, t)}
              onBlockedNavigation={() => undefined}
            />
          </div>
          <p className="design-canvas-hint muted small">
            Click to select · double-click text to edit it in place · Esc clears the selection
          </p>
        </section>

        <aside className="design-right material-solid" aria-label="Selected element">
          {!view ? null : !node && !selected ? (
            <div className="design-empty">
              <Icon name="target" size={22} />
              <p>Select an element on the canvas or in the outline to edit its content and style.</p>
            </div>
          ) : (
            <ElementPanel key={`${selected?.id ?? ''}|${selected?.path ?? ''}`} view={view} page={page} node={node} target={selected!} section={section} sectionIndex={sectionIndex} breakpoint={ui.breakpoint} busy={busy} run={run} onDeselect={() => setSelected(null)} />
          )}
        </aside>
      </div>
    </div>
  );
}

function DesignBar({ view, page, setPage, step }: { view: DesignPageView | null; page: string; setPage: (p: string) => void; step: (scope: string, d: 'undo' | 'redo') => Promise<void> }) {
  const breakpoint = useDesignUi((s) => s.breakpoint);
  return (
    <div className="workspace-bar">
      <h1 className="workspace-title" data-text="Design">
        Design
      </h1>
      <Menu
        label="Page"
        align="start"
        items={(view?.pages ?? [page]).map((p) => ({ label: p, icon: 'file', checked: p === page, onSelect: () => setPage(p) }))}
        trigger={(props) => (
          <button type="button" className="page-chip" {...props}>
            <Icon name="file" size={14} />
            <span>{page}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        )}
      />
      <SegmentedControl size="sm" label="Breakpoint" options={BREAKPOINT_OPTIONS} value={breakpoint} onChange={(b) => useDesignUi.setState({ breakpoint: b })} />
      <span className="bar-spacer" />
      <IconButton icon="undo" size="sm" label={view?.undo ? `Undo ${view.undo}` : 'Nothing to undo on this page'} disabled={!view?.undo} onClick={() => void step(`design:${page}`, 'undo')} />
      <IconButton icon="restore" size="sm" className="flip-x" label={view?.redo ? `Redo ${view.redo}` : 'Nothing to redo on this page'} disabled={!view?.redo} onClick={() => void step(`design:${page}`, 'redo')} />
    </div>
  );
}

function AddPanel({ view, afterIndex, run }: { view: DesignPageView; afterIndex: number; run: (name: string, args: Record<string, unknown>, keep?: DesignTarget | null) => Promise<boolean> }) {
  const index = afterIndex >= 0 ? afterIndex + 1 : view.sections.length;
  const where = afterIndex >= 0 ? 'after the selected section' : 'at the end of the page';
  return (
    <div className="add-panel">
      <p className="muted small">Sections are inserted {where}. They use your theme’s colours and fonts.</p>
      <ul className="library-list">
        {view.library.map((item) => (
          <li key={item.kind}>
            <button type="button" className="library-item" disabled={!view.supported} onClick={() => void run('design.insertSection', { page: view.page, kind: item.kind, index }, null)}>
              <span className="library-name">{item.label}</span>
              <span className="library-desc">{item.description}</span>
            </button>
          </li>
        ))}
      </ul>
      {view.components.length > 0 && (
        <>
          <h3 className="panel-subhead">Your components</h3>
          <ul className="library-list">
            {view.components.map((c) => (
              <li key={c}>
                <button type="button" className="library-item" onClick={() => void run('design.insertComponent', { page: view.page, name: c, index }, null)}>
                  <span className="library-name">{c}</span>
                  <span className="library-desc">Reusable block from components/{c}.html</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PagesPanel({ view, page, setPage, run }: { view: DesignPageView; page: string; setPage: (p: string) => void; run: (name: string, args: Record<string, unknown>, keep?: DesignTarget | null) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/') + 1) : '';
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const create = async (): Promise<void> => {
    if (!slug) return;
    const file = `${dir}${slug}.html`;
    if (await run('design.createPage', { from: page, page: file, title: name.trim() }, null)) {
      setName('');
      setPage(file);
    }
  };
  return (
    <div className="pages-panel">
      <ul className="library-list">
        {view.pages.map((p) => (
          <li key={p}>
            <button type="button" className={cx('library-item', p === page && 'is-current')} onClick={() => setPage(p)}>
              <span className="library-name">{p}</span>
            </button>
          </li>
        ))}
      </ul>
      <form className="new-page" onSubmit={(e) => (e.preventDefault(), void create())}>
        <label className="prop-label" htmlFor="new-page-name">
          New page from this one’s header and footer
        </label>
        <div className="new-page-row">
          <input id="new-page-name" className="input" placeholder="Page title, e.g. About" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" type="submit" disabled={!slug}>
            Create
          </Button>
        </div>
        {slug && <span className="muted small">Creates {dir}{slug}.html</span>}
      </form>
      <h3 className="panel-subhead">Page title</h3>
      <CommitInput label="Page title" value={view.title} onCommit={(title) => title.trim() && void run('design.setTitle', { page, title: title.trim() }, null)} />
    </div>
  );
}

function ThemePanel({ view, run, step }: { view: DesignPageView; run: (name: string, args: Record<string, unknown>, keep?: DesignTarget | null) => Promise<boolean>; step: (scope: string, d: 'undo' | 'redo') => Promise<void> }) {
  if (!view.theme.stylesheet) return <p className="muted small">No theme tokens found. Themes are CSS custom properties named --mv-… in a :root rule (for example in theme.css).</p>;
  const set = (name: string, value: string): void => void run('design.setTheme', { stylesheet: view.theme.stylesheet, tokens: { [name]: value } });
  return (
    <div className="theme-panel">
      <p className="muted small">Edits {view.theme.stylesheet}. Every page and section that uses these tokens updates.</p>
      {view.theme.tokens.map((t) => (
        <Row key={t.name} label={t.name.replace(/^--mv-/, '').replace(/-/g, ' ')}>
          {isHex(t.value) && <input type="color" className="prop-swatch" aria-label={`${t.name} colour`} value={t.value} onChange={(e) => set(t.name, e.target.value)} />}
          <CommitInput label={t.name} value={t.value} onCommit={(v) => v.trim() && set(t.name, v.trim())} />
        </Row>
      ))}
      <div className="theme-undo">
        <Button size="sm" variant="quiet" icon="undo" onClick={() => void step('design:theme', 'undo')}>
          Undo theme change
        </Button>
      </div>
    </div>
  );
}

const WEIGHTS = ['300', '400', '500', '600', '700', '800'];
const ALIGN = ['left', 'center', 'right'];

function ElementPanel({
  view,
  page,
  node,
  target,
  section,
  sectionIndex,
  breakpoint,
  busy,
  run,
  onDeselect,
}: {
  view: DesignPageView;
  page: string;
  node: DesignNodeView | null;
  target: DesignTarget;
  section: DesignNodeView | null;
  sectionIndex: number;
  breakpoint: DesignBreakpoint;
  busy: boolean;
  run: (name: string, args: Record<string, unknown>, keep?: DesignTarget | null) => Promise<boolean>;
  onDeselect: () => void;
}) {
  const t = targetOf(target);
  const styles = (target.id && view.styles[target.id]) || {};
  const own = styles[breakpoint] ?? {};
  const inheritedOf = (prop: string): string | null => {
    const order: DesignBreakpoint[] = breakpoint === 'mobile' ? ['tablet', 'desktop'] : breakpoint === 'tablet' ? ['desktop'] : [];
    for (const b of order) if (styles[b]?.[prop]) return styles[b]![prop]!;
    return null;
  };
  const setStyle = (prop: string, value: string | null): void => void run('design.setStyle', { page, target: t, breakpoint, props: { [prop]: value } });
  const field = (prop: string, label: string, kind?: 'text' | 'color' | 'select', options?: string[]) => <StyleField key={prop} prop={prop} label={label} value={own[prop] ?? ''} inherited={inheritedOf(prop)} onCommit={setStyle} kind={kind} options={options} />;
  const isSection = node?.kind === 'section';
  const images = useMemo(() => view.images, [view.images]);

  return (
    <div className="element-panel" aria-busy={busy}>
      <header className="element-head">
        <div>
          <h2>{node?.label ?? `<${target.path}>`}</h2>
          <span className="muted small">
            {node ? `<${node.tag}>` : 'Element'}
            {target.id ? ` · ${target.id}` : ''}
          </span>
        </div>
        <IconButton icon="close" size="sm" label="Clear selection" onClick={onDeselect} />
      </header>

      {node?.editableText && (
        <section className="prop-group">
          <h3 className="panel-subhead">Text</h3>
          <CommitInput label="Text" multiline value={node.text ?? ''} onCommit={(text) => void run('design.setText', { page, target: t, text })} />
          <span className="muted small">Ctrl+Enter to apply. Or double-click the text on the canvas.</span>
        </section>
      )}
      {node && !node.editableText && node.kind !== 'image' && node.text !== null && node.kind !== 'section' && (
        <p className="muted small">This element contains other elements; select a single text element to edit its words.</p>
      )}

      {(node?.kind === 'link' || node?.kind === 'button') && node.tag === 'a' && (
        <section className="prop-group">
          <h3 className="panel-subhead">Link</h3>
          <Row label="Goes to">
            <CommitInput label="Link address" value={node.attrs.href ?? ''} placeholder="about.html or https://…" onCommit={(v) => void run('design.setAttribute', { page, target: t, name: 'href', value: v.trim() || null })} />
          </Row>
          <Row label="Opens in">
            <select className="input prop-input" value={node.attrs.target === '_blank' ? '_blank' : ''} onChange={(e) => void run('design.setAttribute', { page, target: t, name: 'target', value: e.target.value || null })}>
              <option value="">Same tab</option>
              <option value="_blank">New tab</option>
            </select>
          </Row>
        </section>
      )}

      {node?.kind === 'image' && (
        <section className="prop-group">
          <h3 className="panel-subhead">Image</h3>
          <Row label="File">
            <select className="input prop-input" value={images.includes(node.attrs.src ?? '') ? node.attrs.src : ''} onChange={(e) => e.target.value && void run('design.setAttribute', { page, target: t, name: 'src', value: e.target.value })}>
              <option value="">{node.attrs.src ?? 'Choose an image'}</option>
              {images.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </Row>
          <Row label="Description" hint="for screen readers">
            <CommitInput label="Alternative text" value={node.attrs.alt ?? ''} onCommit={(v) => void run('design.setAttribute', { page, target: t, name: 'alt', value: v })} />
          </Row>
        </section>
      )}

      <section className="prop-group">
        <h3 className="panel-subhead">
          Style · {breakpoint === 'desktop' ? 'all screens' : breakpoint === 'tablet' ? 'tablet and smaller' : 'phones'}
        </h3>
        {field('color', 'Text colour', 'color')}
        {field('background-color', 'Background', 'color')}
        {field('font-size', 'Font size')}
        {field('font-weight', 'Weight', 'select', WEIGHTS)}
        {field('text-align', 'Alignment', 'select', ALIGN)}
        {field('line-height', 'Line height')}
        {field('padding', 'Padding')}
        {field('margin-top', 'Space above')}
        {field('margin-bottom', 'Space below')}
        {isSection && field('gap', 'Gap between items')}
        {field('border-radius', 'Corner radius')}
        {field('max-width', 'Max width')}
        {field('opacity', 'Opacity')}
        <p className="muted small">Saved in design.css as one rule per element and breakpoint.</p>
      </section>

      {section && (
        <section className="prop-group">
          <h3 className="panel-subhead">Section</h3>
          <div className="section-actions">
            <Button size="sm" variant="quiet" icon="chevronLeft" className="rot-90" disabled={sectionIndex <= 0} onClick={() => void run('design.moveSection', { page, target: section.mvId ? { id: section.mvId } : { path: section.path }, toIndex: sectionIndex - 1 })}>
              Move up
            </Button>
            <Button size="sm" variant="quiet" icon="chevronRight" className="rot-90" disabled={sectionIndex >= view.sections.length - 1} onClick={() => void run('design.moveSection', { page, target: section.mvId ? { id: section.mvId } : { path: section.path }, toIndex: sectionIndex + 1 })}>
              Move down
            </Button>
            <Button size="sm" variant="quiet" icon="copy" onClick={() => void run('design.duplicateSection', { page, target: section.mvId ? { id: section.mvId } : { path: section.path } })}>
              Duplicate
            </Button>
            <Button size="sm" variant="quiet" icon="trash" onClick={() => void run('design.removeSection', { page, target: section.mvId ? { id: section.mvId } : { path: section.path } }, null).then((ok) => ok && onDeselect())}>
              Remove
            </Button>
          </div>
          {section.object ? (
            <div className="component-note">
              <p className="muted small">This section shows the living object “{section.object}”. Edit the object to update every page and video that uses it; editing the text here marks this placement as edited by hand.</p>
              <Button
                size="sm"
                variant="quiet"
                icon="layers"
                onClick={() => {
                  useSelectionRefs.setState({ openObject: section.object });
                  setWorkspace('assets');
                }}
              >
                Edit object · where is it used?
              </Button>
            </div>
          ) : (
            <SaveComponent page={page} pages={view.pages} section={section} run={run} />
          )}
        </section>
      )}
    </div>
  );
}

function SaveComponent({ page, pages, section, run }: { pages: string[]; page: string; section: DesignNodeView; run: (name: string, args: Record<string, unknown>, keep?: DesignTarget | null) => Promise<boolean> }) {
  const [name, setName] = useState(section.component ?? '');
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (section.component)
    return (
      <div className="component-note">
        <p className="muted small">This section is the “{section.component}” component. Changes here can be copied to its other uses.</p>
        <Button size="sm" variant="quiet" icon="sync" onClick={() => void run('design.syncComponent', { name: section.component, pages: pages.filter((p) => p !== page), from: page })}>
          Update other uses
        </Button>
      </div>
    );
  return (
    <form className="new-page" onSubmit={(e) => (e.preventDefault(), slug && void run('design.saveComponent', { page, target: section.mvId ? { id: section.mvId } : { path: section.path }, name: slug }))}>
      <label className="prop-label" htmlFor="component-name">
        Save as a reusable component
      </label>
      <div className="new-page-row">
        <input id="component-name" className="input" placeholder="Name, e.g. site-footer" value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="sm" type="submit" disabled={!slug}>
          Save
        </Button>
      </div>
    </form>
  );
}
