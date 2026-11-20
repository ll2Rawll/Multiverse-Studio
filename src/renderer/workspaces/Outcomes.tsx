/**
 * Outcomes: universes side by side by what they produce. Pages, objects and timelines are read
 * from the files; story runs, tests, renders and deploys are measured, and each says what it was
 * measured on. No scores, rankings or predictions.
 */
import { useState, type ReactNode } from 'react';
import { useStudio, toast } from '../state/store';
import { call, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Button } from '../components/primitives';
import { Icon } from '../components/Icon';
import { cx, plural, refKey, relativeTime } from '../lib/util';
import { STATUS_LABEL } from '../../shared/stories';
import type { ContentRef } from '../../shared/types';
import type { ReleaseDestinationView, UniverseOutcomes } from '../../shared/outcomes';

const short = (rev: string | null): string => (rev ? rev.slice(0, 8) : 'unsaved');

function Missing() {
  return <span className="muted small">Not in this version</span>;
}

export function OutcomesView({ refs }: { refs: ContentRef[] }) {
  const project = useStudio((s) => s.project)!;
  const [busy, setBusy] = useState<string | null>(null);
  const data = useAsync(() => call('outcomes.compare', { projectId: project.id, refs }), [project.id, refs.map(refKey).join('|'), project.updatedAt]);
  const releases = useAsync(() => call('releases.list', { projectId: project.id }), [project.id, project.updatedAt]);
  const o = data.data;
  const act = async (key: string, run: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(key);
    try {
      await run();
      toast({ tone: 'success', title: done });
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t run it', body: errorMessage(error) });
    } finally {
      setBusy(null);
      data.reload();
    }
  };
  if (data.error) return <p className="info-banner">{data.error}</p>;
  if (!o) return <div className="editor-loading" />;
  const cols = { ['--outcome-cols' as string]: String(o.sides.length) };
  const labels = o.sides.map((s) => s.label);
  const head = (
    <div className="outcome-row outcome-head" style={cols} aria-hidden="true">
      <span />
      {o.sides.map((s, i) => (
        <span key={i} className="outcome-side">
          <strong>{s.label}</strong>
          <span className="muted small">
            {s.revision ? `at ${short(s.revision)}` : ''}
            {s.draft ? ' with unsaved changes' : ''}
            {s.files ? ` · ${s.files.modified + s.files.added + s.files.deleted === 0 ? 'same files' : `${s.files.modified} changed, ${s.files.added} added, ${s.files.deleted} removed`}` : ''}
          </span>
        </span>
      ))}
    </div>
  );
  return (
    <div className="outcomes" role="region" aria-label="Outcomes by version">
      <p className="outcomes-note muted small">
        <Icon name="info" size={13} /> Pages, objects and timelines are read from the files. Stories, tests, renders and deploys are measured results, shown with the files they ran on. Nothing here is a score or a prediction.
      </p>
      {head}
      <Group sides={labels} title="Tests" measured>
        <div className="outcome-row" style={cols} role="row">
          <span role="rowheader">Test script</span>
          {o.tests.sides.map((t, i) => {
            const side = o.sides[i]!;
            return (
              <span key={i} role="cell" className="outcome-cell">
                {t ? (
                  <span className={cx('outcome-badge', t.passed ? 'is-good' : 'is-bad', !t.current && 'is-stale')}>
                    {t.passed ? 'Passed' : t.exitCode === null ? 'Stopped' : `Failed (exit ${t.exitCode})`}
                  </span>
                ) : (
                  <span className="muted small">Not run</span>
                )}
                {t && <span className="muted small">{t.current ? `on these files, ${relativeTime(t.at)}` : `${relativeTime(t.at)} — files changed since`}</span>}
                {side.ref.kind === 'line' && side.lineId && (
                  <Button size="sm" variant="quiet" icon="play" disabled={busy !== null} onClick={() => void act(`t${i}`, () => call('tests.run', { projectId: project.id, lineId: side.lineId! }), `Tests ran in ${side.label}`)}>
                    {busy === `t${i}` ? 'Running…' : 'Run tests'}
                  </Button>
                )}
              </span>
            );
          })}
        </div>
      </Group>
      <Group sides={labels} title="Stories" measured empty={o.stories.length === 0 ? 'No stories yet. Create one in Stories.' : null}>
        {o.stories.map((st) => (
          <div key={st.id} className="outcome-row" style={cols} role="row">
            <span role="rowheader">{st.name}</span>
            {st.sides.map((s, i) => {
              const side = o.sides[i]!;
              return (
                <span key={i} role="cell" className="outcome-cell">
                  {s ? (
                    <>
                      <span className={cx('story-status', `is-${s.status}`)} title={s.detail}>
                        {STATUS_LABEL[s.status]}
                      </span>
                      <span className="muted small">
                        {plural(s.steps, 'step')}
                        {s.at ? ` · run ${relativeTime(s.at)}${s.revision ? ` at ${short(s.revision)}` : ''}` : ''}
                      </span>
                      {side.ref.kind === 'line' && side.lineId && (
                        <Button size="sm" variant="quiet" icon="play" disabled={busy !== null} onClick={() => void act(`s${st.id}${i}`, () => call('stories.run', { projectId: project.id, lineId: side.lineId!, storyId: st.id }), `Ran “${st.name}” in ${side.label}`)}>
                          {busy === `s${st.id}${i}` ? 'Running…' : 'Run'}
                        </Button>
                      )}
                    </>
                  ) : (
                    <Missing />
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </Group>
      <Group sides={labels} title="Pages" empty={o.pages.length === 0 ? 'No pages.' : null}>
        {o.pages.map((p) => {
          const hashes = new Set(p.sides.map((s) => s?.hash ?? null));
          return (
            <div key={p.path} className="outcome-row" style={cols} role="row">
              <span role="rowheader" className="mono small">
                {p.path}
                {hashes.size > 1 && <span className="outcome-differs">differs</span>}
              </span>
              {p.sides.map((s, i) => (
                <span key={i} role="cell" className="outcome-cell">
                  {s ? (
                    <>
                      <span>{s.heading || s.title || 'No heading'}</span>
                      {s.title && s.heading && <span className="muted small">{s.title}</span>}
                    </>
                  ) : (
                    <Missing />
                  )}
                </span>
              ))}
            </div>
          );
        })}
      </Group>
      <Group sides={labels} title="Living objects" empty={o.objects.length === 0 ? 'No living objects.' : null}>
        {o.objects.map((ob) => (
          <div key={ob.id} className="outcome-row" style={cols} role="row">
            <span role="rowheader">
              {ob.sides.find(Boolean)?.name ?? ob.id}
              {ob.differs.length > 0 && <span className="outcome-differs">{ob.differs.join(', ')} differ</span>}
            </span>
            {ob.sides.map((s, i) => (
              <span key={i} role="cell" className="outcome-cell">
                {s ? (
                  <>
                    <span className="outcome-props">
                      {Object.entries(s.properties)
                        .slice(0, 4)
                        .map(([k, v]) => (
                          <span key={k} className={cx(ob.differs.includes(k) && 'is-different')}>
                            {k}: {v.length > 40 ? `${v.slice(0, 40)}…` : v}
                          </span>
                        ))}
                    </span>
                    <span className="muted small">{plural(s.placements, 'placement')}</span>
                  </>
                ) : (
                  <Missing />
                )}
              </span>
            ))}
          </div>
        ))}
      </Group>
      <Group sides={labels} title="Timelines" empty={o.timelines.length === 0 ? 'No timelines.' : null}>
        {o.timelines.map((t) => {
          const hashes = new Set(t.sides.map((s) => s?.hash ?? null));
          return (
            <div key={t.id} className="outcome-row" style={cols} role="row">
              <span role="rowheader">
                {t.sides.find(Boolean)?.name ?? t.id}
                {hashes.size > 1 && <span className="outcome-differs">differs</span>}
              </span>
              {t.sides.map((s, i) => (
                <span key={i} role="cell" className="outcome-cell">
                  {s ? `${s.seconds} s · ${plural(s.clips, 'clip')} on ${plural(s.tracks, 'track')}` : <Missing />}
                </span>
              ))}
            </div>
          );
        })}
      </Group>
      <Group sides={labels} title="Renders" measured empty={o.renders.length === 0 ? 'No finished exports of these versions.' : null}>
        {o.renders.map((r) => (
          <div key={r.sequenceId} className="outcome-row" style={cols} role="row">
            <span role="rowheader">{r.sides.find(Boolean)?.sequenceName ?? r.sequenceId}</span>
            {r.sides.map((s, i) => (
              <span key={i} role="cell" className="outcome-cell">
                {s ? (
                  <>
                    <span className={cx('outcome-badge', s.outdated ? 'is-stale' : 'is-good')}>{s.outdated ? 'Outdated' : 'Up to date'}</span>
                    <span className="muted small">
                      {s.format.toUpperCase()}
                      {s.seconds !== null ? ` · ${s.seconds.toFixed(1)} s` : ''} · {relativeTime(s.at)}
                      {s.revision ? ` at ${short(s.revision)}` : ''}
                    </span>
                    {s.outdated && <span className="muted small">{s.outdated}</span>}
                  </>
                ) : (
                  <span className="muted small">Not exported</span>
                )}
              </span>
            ))}
          </div>
        ))}
      </Group>
      <Group sides={labels} title="Deploys" measured empty={o.releases.length === 0 ? 'Not published from these versions.' : null}>
        {o.releases.map((r) => (
          <div key={r.targetId} className="outcome-row" style={cols} role="row">
            <span role="rowheader">{r.targetName}</span>
            {r.sides.map((s, i) => (
              <span key={i} role="cell" className="outcome-cell">
                {s ? (
                  <>
                    <span className={cx('outcome-badge', s.current ? 'is-good' : 'is-stale')}>{s.current ? 'Matches' : s.current === false ? 'Behind' : 'Unknown'}</span>
                    <span className="muted small">
                      {relativeTime(s.at)}
                      {s.revision ? ` at ${short(s.revision)}` : ''} · {s.detail}
                    </span>
                  </>
                ) : (
                  <span className="muted small">Not published</span>
                )}
              </span>
            ))}
          </div>
        ))}
      </Group>
      <ReleaseList list={releases.data ?? []} />
    </div>
  );
}

function Group({ title, sides, measured, empty, children }: { title: string; sides: string[]; measured?: boolean; empty?: string | null; children: ReactNode }) {
  return (
    <section className="outcome-group" aria-label={title}>
      <h3 className="outcome-title">
        {title}
        {measured && <span className="outcome-kind">measured</span>}
      </h3>
      {empty ? (
        <p className="muted small">{empty}</p>
      ) : (
        <div role="table" aria-label={title}>
          <div role="row" className="sr-only">
            <span role="columnheader">{title}</span>
            {sides.map((s, i) => (
              <span key={i} role="columnheader">
                {s}
              </span>
            ))}
          </div>
          {children}
        </div>
      )}
    </section>
  );
}

/** Every release destination with its own state. They are separate jobs; nothing claims they changed together. */
export function ReleaseList({ list }: { list: ReleaseDestinationView[] }) {
  return (
    <section className="outcome-group" aria-label="Release destinations">
      <h3 className="outcome-title">Release destinations</h3>
      <p className="muted small">Each destination is updated by its own job and can be at a different version. A site and a video are never released together as one step.</p>
      {list.length === 0 ? (
        <p className="muted small">Nothing published or exported yet.</p>
      ) : (
        <ul className="release-list">
          {list.map((d) => (
            <li key={d.key} className="release-row">
              <Icon name={d.kind === 'website' ? 'globe' : 'film'} size={14} />
              <span className="release-name">{d.name}</span>
              <span className="release-live">
                {d.live ? (
                  <>
                    {d.live.lineName} at {short(d.live.revision)}
                    {d.live.draft ? ' (with unsaved changes)' : ''} · {relativeTime(d.live.at)}
                  </>
                ) : (
                  'Nothing live'
                )}
              </span>
              <span className={cx('outcome-badge', d.current ? 'is-good' : d.current === false ? 'is-stale' : '')}>{d.current ? 'Current' : d.current === false ? 'Behind' : 'Unknown'}</span>
              <span className="muted small release-detail">
                {d.currentDetail}
                {d.latest && d.latest.jobId !== d.live?.jobId ? ` Latest attempt: ${d.latest.state} (${d.latest.detail}).` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
