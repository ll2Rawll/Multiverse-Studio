/**
 * Assets → Objects: living objects. Create once, place on pages and in timelines, edit at one of
 * three scopes (the shared object, this universe, one placement), and see every use before an
 * edit spreads.
 */
import { useEffect, useMemo, useState } from 'react';
import { useStudio, toast } from '../../state/store';
import { setWorkspace } from '../../state/actions';
import { useSelectionRefs } from '../../state/selection';
import { call, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Button, EmptyState, SegmentedControl } from '../../components/primitives';
import { Icon } from '../../components/Icon';
import { cx, lineRef, plural } from '../../lib/util';
import { OBJECT_TYPES, OBJECT_TYPE_INFO, type ObjectProps, type ObjectType, type ObjectView, type PlacementView } from '../../../shared/objects';
import { SHARED_LINE_ID } from '../../../shared/types';

type Scope = 'shared' | 'universe' | 'instance';
const S = 240_000;
const STATE_LABEL = { current: 'Up to date', outdated: 'Needs update', edited: 'Edited by hand' } as const;

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'object';

function PropertyForm({ type, value, onChange, inherited }: { type: ObjectType; value: ObjectProps; onChange: (v: ObjectProps) => void; inherited?: ObjectProps }) {
  return (
    <div className="obj-form">
      {OBJECT_TYPE_INFO[type].fields.map((f) => {
        const id = `obj-f-${f.key}`;
        const v = value[f.key];
        const placeholder = inherited ? (Array.isArray(inherited[f.key]) ? (inherited[f.key] as string[]).join(' / ') : String(inherited[f.key] ?? '')) : '';
        return (
          <div className="field" key={f.key}>
            <label className="field-label" htmlFor={id}>
              {f.label}
              {f.kind === 'list' && <span className="muted"> (one per line)</span>}
            </label>
            {f.kind === 'list' || f.kind === 'longtext' ? (
              <textarea
                id={id}
                className="input"
                rows={f.kind === 'list' ? 3 : 2}
                value={Array.isArray(v) ? v.join('\n') : (v ?? '')}
                placeholder={placeholder}
                onChange={(e) => onChange({ ...value, [f.key]: f.kind === 'list' ? e.target.value.split('\n') : e.target.value })}
              />
            ) : (
              <input id={id} className={cx('input', f.kind === 'url' && 'mono')} value={typeof v === 'string' ? v : ''} placeholder={placeholder} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
            )}
          </div>
        );
      })}
    </div>
  );
}

const clean = (p: ObjectProps, dropEmpty: boolean): ObjectProps =>
  Object.fromEntries(
    Object.entries(p)
      .map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => x.trim()).filter(Boolean) : v] as const)
      .filter(([, v]) => !dropEmpty || (Array.isArray(v) ? v.length > 0 : v !== '')),
  );

export function ObjectsPanel() {
  const project = useStudio((s) => s.project)!;
  const lineId = useStudio((s) => s.selectedLineId);
  const version = useStudio((s) => s.previewVersions[s.selectedLineId] ?? 0);
  const sharedVersion = useStudio((s) => s.previewVersions[SHARED_LINE_ID] ?? 0);
  const lineName = lineId === SHARED_LINE_ID ? project.shared.name : (project.alternatives.find((a) => a.id === lineId)?.name ?? '');
  const list = useAsync(() => call('objects.list', { projectId: project.id, lineId }), [project.id, lineId, version]);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const id = useSelectionRefs.getState().openObject;
    if (id) useSelectionRefs.setState({ openObject: null });
    return id;
  });
  const [creating, setCreating] = useState<ObjectType | null>(null);
  const objects = list.data ?? [];
  const selected = objects.find((o) => o.id === selectedId) ?? objects[0] ?? null;

  return (
    <div className="objects-page">
      <aside className="objects-list" aria-label="Living objects">
        <div className="objects-list-head">
          <h2>Living objects</h2>
          <span className="muted small">in {lineName}</span>
        </div>
        {objects.length === 0 && !list.loading && <p className="muted small">Create content once — a price, a feature list, a title — and use it on pages and in videos.</p>}
        <ul>
          {objects.map((o) => {
            const stale = o.placements.filter((p) => p.state === 'outdated').length;
            return (
              <li key={o.id} data-live={`object:${o.id}`}>
                <button type="button" className={cx('objects-item', selected?.id === o.id && 'is-selected')} aria-current={selected?.id === o.id} onClick={() => setSelectedId(o.id)}>
                  <strong>{o.name}</strong>
                  <span className="muted small">
                    {OBJECT_TYPE_INFO[o.type].label} · {plural(o.placements.length, 'use')}
                    {stale > 0 && <span className="is-warning"> · {stale} need update</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="objects-new" role="group" aria-label="New living object">
          <span className="field-label">New</span>
          {OBJECT_TYPES.map((t) => (
            <Button key={t} size="sm" variant="quiet" onClick={() => setCreating(t)}>
              {OBJECT_TYPE_INFO[t].label}
            </Button>
          ))}
        </div>
      </aside>
      <section className="objects-detail">
        {creating ? (
          <CreateObject
            type={creating}
            projectId={project.id}
            lineId={lineId}
            onDone={(id) => {
              setCreating(null);
              if (id) setSelectedId(id);
              list.reload();
            }}
          />
        ) : selected ? (
          <ObjectEditor key={`${selected.id}:${lineId}`} object={selected} projectId={project.id} lineId={lineId} lineName={lineName} sharedVersion={sharedVersion} onChanged={list.reload} />
        ) : (
          <EmptyState icon="layers" title="No living objects yet" body="Pick a type under New. Objects live in this universe’s files, so universes can change them independently and combine them later." />
        )}
      </section>
    </div>
  );
}

function CreateObject({ type, projectId, lineId, onDone }: { type: ObjectType; projectId: string; lineId: string; onDone: (id: string | null) => void }) {
  const info = OBJECT_TYPE_INFO[type];
  const [name, setName] = useState(info.label);
  const [props, setProps] = useState<ObjectProps>({ ...info.defaults });
  const create = async (): Promise<void> => {
    const id = `${slug(name)}-${Date.now().toString(36).slice(-4)}`;
    try {
      await call('commands.run', { projectId, lineId, name: 'objects.create', args: { object: id, type, name: name.trim(), properties: clean(props, false) } });
      toast({ tone: 'success', title: `${info.label} created`, body: 'Place it on a page or add it to a video next.' });
      onDone(id);
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t create it', body: errorMessage(error) });
    }
  };
  return (
    <form
      className="objects-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <h2>New {info.label.toLowerCase()}</h2>
      <p className="muted">{info.description}</p>
      <div className="field">
        <label className="field-label" htmlFor="obj-name">
          Name
        </label>
        <input id="obj-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </div>
      <PropertyForm type={type} value={props} onChange={setProps} />
      <div className="dialog-actions">
        <Button onClick={() => onDone(null)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Create
        </Button>
      </div>
    </form>
  );
}

function ObjectEditor({ object, projectId, lineId, lineName, sharedVersion, onChanged }: { object: ObjectView; projectId: string; lineId: string; lineName: string; sharedVersion: number; onChanged: () => void }) {
  const project = useStudio((s) => s.project)!;
  const onShared = lineId === SHARED_LINE_ID;
  const [scope, setScope] = useState<Scope>(onShared ? 'shared' : 'universe');
  const [instance, setInstance] = useState<PlacementView | null>(null);
  const [draft, setDraft] = useState<ObjectProps>(object.properties);
  const [overrides, setOverrides] = useState<ObjectProps>({});
  const [busy, setBusy] = useState(false);
  const uses = useAsync(() => call('objects.uses', { projectId, objectId: object.id }), [projectId, object.id, object.revision, sharedVersion, object.placements.length]);
  const pages = useAsync(() => call('files.list', { projectId, ref: lineRef(lineId) }).then((f) => f.map((x) => x.path).filter((p) => /\.html?$/i.test(p) && !p.startsWith('node_modules/'))), [projectId, lineId]);
  const seqs = useAsync(() => call('sequences.list', { projectId, lineId }), [projectId, lineId, object.placements.length]);
  const [page, setPage] = useState('');
  const [seq, setSeq] = useState('');
  // Shared scope edits the Shared version’s copy of the object, not this universe’s values.
  const sharedCopy = useAsync(() => (onShared ? Promise.resolve(object) : call('objects.list', { projectId, lineId: SHARED_LINE_ID }).then((l) => l.find((o) => o.id === object.id) ?? null)), [projectId, object.id, sharedVersion, onShared ? object.revision : 0]);
  const base = scope === 'shared' ? (sharedCopy.data ?? null) : object;
  useEffect(() => {
    if (base) setDraft(base.properties);
  }, [base?.revision, base?.properties, scope]);
  useEffect(() => {
    if (scope === 'instance' && instance) setOverrides(instance.overrides);
  }, [scope, instance]);

  // The universe an edit lands in, and the uses it would update (shown before applying).
  const targetLine = scope === 'shared' ? SHARED_LINE_ID : lineId;
  const targetUniverse = uses.data?.universes.find((u) => u.lineId === targetLine);
  const following = scope === 'shared' ? (uses.data?.universes ?? []).filter((u) => u.lineId !== SHARED_LINE_ID && project.alternatives.find((a) => a.id === u.lineId)?.following) : [];
  const affected = scope === 'instance' ? (instance ? [instance] : []) : (targetUniverse?.placements ?? []);
  const keptByHand = affected.filter((p) => p.state === 'edited').length;
  const changed = useMemo(() => Boolean(base) && JSON.stringify(clean(draft, false)) !== JSON.stringify(clean(base!.properties, false)), [draft, base]);

  const run = async (name: string, args: Record<string, unknown>, on = targetLine): Promise<boolean> => {
    setBusy(true);
    try {
      await call('commands.run', { projectId, lineId: on, name, args });
      onChanged();
      uses.reload();
      return true;
    } catch (error) {
      toast({ tone: 'error', title: 'Not applied', body: errorMessage(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const apply = async (): Promise<void> => {
    if (scope === 'instance') {
      if (!instance) return;
      if (await run('objects.setInstance', { object: object.id, path: instance.path, instance: instance.instance, overrides: clean(overrides, true) }, lineId)) toast({ tone: 'success', title: 'This placement updated', body: 'Other uses are unchanged.' });
      return;
    }
    const sync = [...new Set((targetUniverse?.placements ?? []).map((p) => p.path))];
    if (await run('objects.update', { object: object.id, properties: clean(draft, false), sync })) {
      toast({
        tone: 'success',
        title: scope === 'shared' ? 'Shared object updated' : `Updated in ${lineName}`,
        body: scope === 'shared' ? `Saved to the Shared draft. Save the Shared version to send it to ${plural(following.length, 'following universe')}; their own values are kept.` : 'Only this universe changed.',
      });
    }
  };

  const placeOnPage = async (): Promise<void> => {
    const target = page || pages.data?.[0];
    if (target && (await run('objects.place', { object: object.id, page: target, index: 500 }, lineId))) toast({ tone: 'success', title: `Placed on ${target}`, body: 'At the end of the page. Move it in Design.' });
  };
  const addToVideo = async (): Promise<void> => {
    const s = seqs.data?.find((x) => x.id === (seq || seqs.data?.[0]?.id));
    if (!s) return;
    const start = Math.round(s.durationSeconds * S);
    if (await run('objects.addScene', { object: object.id, sequence: s.id, start, duration: 4 * S }, lineId)) toast({ tone: 'success', title: `Added to ${s.name}`, body: 'A 4-second scene at the end, on a titles track. Trim, move or animate it in Video.' });
  };

  return (
    <div className="objects-editor">
      <div className="objects-editor-head">
        <h2>{object.name}</h2>
        <span className="muted small">
          {OBJECT_TYPE_INFO[object.type].label} · revision {object.revision} · <code>{object.id}</code>
        </span>
      </div>
      <SegmentedControl<Scope>
        size="sm"
        label="Edit scope"
        options={[
          { value: 'shared' as const, label: 'Shared object' },
          ...(onShared ? [] : [{ value: 'universe' as const, label: 'This universe' }]),
          ...(object.placements.length ? [{ value: 'instance' as const, label: 'This placement' }] : []),
        ]}
        value={scope}
        onChange={(v) => {
          setScope(v);
          if (v === 'instance' && !instance) setInstance(object.placements[0] ?? null);
        }}
      />
      <p className="field-hint">
        {scope === 'shared'
          ? 'Changes the object in the Shared version. Following universes receive it when you save the Shared version; values a universe changed itself are kept.'
          : scope === 'universe'
            ? `Changes the object only in ${lineName}.`
            : 'Overrides values for one placement. Leave a field empty to use the object’s value.'}
      </p>
      {scope === 'shared' && !onShared && sharedCopy.data === null && <p className="field-hint is-warning">This object exists only in {lineName}. Combine it into the Shared version first, or edit it here with “This universe”.</p>}
      {scope === 'instance' ? (
        <>
          <div className="field">
            <label className="field-label" htmlFor="obj-instance">
              Placement
            </label>
            <select id="obj-instance" className="input" value={instance ? `${instance.path}#${instance.instance}` : ''} onChange={(e) => setInstance(object.placements.find((p) => `${p.path}#${p.instance}` === e.target.value) ?? null)}>
              {object.placements.map((p) => (
                <option key={`${p.path}#${p.instance}`} value={`${p.path}#${p.instance}`}>
                  {p.kind === 'page' ? 'Page' : 'Scene'} · {p.path}
                </option>
              ))}
            </select>
          </div>
          <PropertyForm type={object.type} value={overrides} onChange={setOverrides} inherited={object.properties} />
        </>
      ) : (
        <PropertyForm type={object.type} value={draft} onChange={setDraft} />
      )}
      <section className="objects-impact" aria-live="polite" aria-label="What this edit updates">
        <strong>{scope === 'instance' ? 'Updates 1 placement' : `Updates ${plural(affected.length - keptByHand, 'placement')} in ${scope === 'shared' ? 'the Shared version' : lineName}`}</strong>
        {keptByHand > 0 && <span className="muted"> · {keptByHand} edited by hand will be kept</span>}
        {scope === 'shared' && following.length > 0 && <span className="muted"> · then {plural(following.length, 'following universe')} after you save Shared</span>}
      </section>
      <div className="dialog-actions">
        <Button variant="primary" disabled={busy || (scope === 'instance' ? !instance : !changed)} onClick={() => void apply()}>
          {scope === 'instance' ? 'Apply to this placement' : 'Apply'}
        </Button>
      </div>

      <h3 className="ai-subhead">Use it</h3>
      <div className="objects-use-row">
        <select className="input" aria-label="Page" value={page} onChange={(e) => setPage(e.target.value)}>
          {(pages.data ?? []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <Button size="sm" icon="grid" disabled={busy || !pages.data?.length} onClick={() => void placeOnPage()}>
          Place on page
        </Button>
      </div>
      <div className="objects-use-row">
        <select className="input" aria-label="Sequence" value={seq} onChange={(e) => setSeq(e.target.value)} disabled={!seqs.data?.length}>
          {(seqs.data ?? []).length === 0 && <option value="">No sequences in this universe</option>}
          {(seqs.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button size="sm" icon="film" disabled={busy || !seqs.data?.length} onClick={() => void addToVideo()}>
          Add to video
        </Button>
      </div>

      <h3 className="ai-subhead">Where is this used?</h3>
      {!uses.data ? (
        <p className="muted small">Looking…</p>
      ) : (
        <ul className="objects-uses">
          {uses.data.universes.map((u) => (
            <li key={u.lineId}>
              <div className="objects-uses-head">
                <strong>{u.name}</strong>
                <span className="muted small">{u.revision === null ? 'Not in this version' : `${u.differsFromShared ? 'Own values · ' : ''}${plural(u.placements.length, 'use')}`}</span>
                {u.placements.some((p) => p.state === 'outdated') && (
                  <Button size="sm" onClick={() => void run('objects.sync', { object: object.id, paths: [...new Set(u.placements.map((p) => p.path))] }, u.lineId)} disabled={busy}>
                    Update uses
                  </Button>
                )}
              </div>
              {u.placements.length > 0 && (
                <ul>
                  {u.placements.map((p) => (
                    <li key={`${p.path}#${p.instance}`} className="objects-use">
                      <Icon name={p.kind === 'page' ? 'grid' : 'film'} size={12} />
                      <button type="button" className="link-button" onClick={() => setWorkspace(p.kind === 'page' ? 'design' : 'video')}>
                        {p.path}
                      </button>
                      {Object.keys(p.overrides).length > 0 && <span className="muted small">own values</span>}
                      <span className={cx('obj-state', `is-${p.state}`)}>{STATE_LABEL[p.state]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
