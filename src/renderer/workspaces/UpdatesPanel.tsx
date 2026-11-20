/**
 * Shared dependency updates: everything a version depends on that has moved past it — npm packages
 * that differ from Shared, copies of library media that are older than the library, and exports
 * whose sequence or media changed. Each is brought up to date per version, only when chosen.
 */
import { useState } from 'react';
import { useStudio, toast } from '../state/store';
import { useMedia } from '../state/media';
import { call, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Button, EmptyState } from '../components/primitives';
import { Icon } from '../components/Icon';
import { plural } from '../lib/util';

export function UpdatesPanel() {
  const project = useStudio((s) => s.project)!;
  const revision = useMedia((s) => s.revision);
  const [busy, setBusy] = useState<string | null>(null);
  const status = useAsync(() => call('deps.status', { projectId: project.id }), [project.id, project.updatedAt, revision]);
  const lineName = (id: string): string => (id === project.shared.id ? project.shared.name : (project.alternatives.find((a) => a.id === id)?.name ?? 'Deleted version'));

  const act = async (key: string, fn: () => Promise<string | null>): Promise<void> => {
    setBusy(key);
    try {
      const msg = await fn();
      if (msg) toast({ tone: 'success', title: msg });
      status.reload();
    } catch (error) {
      toast({ tone: 'error', title: 'Could not update', body: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!status.data) return <div className="updates">{status.error ? <p className="info-banner">{status.error}</p> : <div className="editor-loading" />}</div>;
  const { packages, media, exports } = status.data;
  const nothing = packages.length === 0 && media.length === 0 && exports.length === 0;
  return (
    <div className="updates">
      {nothing && <EmptyState icon="check" title="Everything is up to date" body="No version uses older packages than Shared, older copies of library media, or exports of a cut that has changed since." />}
      {packages.length > 0 && (
        <section className="updates-section" aria-labelledby="upd-packages">
          <h2 id="upd-packages" className="assets-heading">
            Packages <span className="muted small">compared with Shared’s package.json</span>
          </h2>
          {packages.map((l) => (
            <article key={l.lineId} className="update-card material-solid">
              <header className="update-head">
                <strong>{l.lineName}</strong>
                <span className="muted small">{l.following ? 'follows Shared — the next shared change may bring these' : 'not following Shared'}</span>
                <span className="bar-spacer" />
                <Button size="sm" icon="sync" disabled={busy !== null} onClick={() => void act(`p:${l.lineId}`, async () => (await call('deps.align', { projectId: project.id, lineId: l.lineId, names: l.packages.map((p) => p.name) })).lockfileNote)}>
                  Match Shared
                </Button>
              </header>
              <table className="update-table">
                <thead>
                  <tr>
                    <th>Package</th>
                    <th>{l.lineName}</th>
                    <th>Shared</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {l.packages.map((p) => (
                    <tr key={`${p.section}:${p.name}`}>
                      <td>
                        {p.name} <span className="muted small">{p.section === 'dependencies' ? '' : p.section}</span>
                      </td>
                      <td>{p.here ?? <span className="muted">not used</span>}</td>
                      <td>{p.shared ?? <span className="muted">removed</span>}</td>
                      <td>
                        <Button size="sm" variant="quiet" disabled={busy !== null} onClick={() => void act(`p:${l.lineId}:${p.name}`, async () => (await call('deps.align', { projectId: project.id, lineId: l.lineId, names: [p.name] })).label)}>
                          Use Shared’s
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          ))}
        </section>
      )}
      {media.length > 0 && (
        <section className="updates-section" aria-labelledby="upd-media">
          <h2 id="upd-media" className="assets-heading">
            Media copies <span className="muted small">older than the asset library</span>
          </h2>
          <article className="update-card material-solid">
            <ul className="update-list">
              {media.map((m) => (
                <li key={`${m.lineId}:${m.path}`}>
                  <Icon name="image" size={14} />
                  <span>
                    <strong>{m.path}</strong> in {m.lineName}
                  </span>
                  <span className="bar-spacer" />
                  <Button size="sm" variant="quiet" disabled={busy !== null} onClick={() => void act(`m:${m.lineId}:${m.path}`, async () => {
                    const r = await call('assets.updateLinks', { projectId: project.id, items: [{ lineId: m.lineId, path: m.path }] });
                    if (r.failed.length) throw new Error(r.failed[0]!.reason);
                    return `Updated ${m.path} in ${m.lineName}`;
                  })}>
                    Update
                  </Button>
                </li>
              ))}
            </ul>
            {media.length > 1 && (
              <Button size="sm" icon="sync" disabled={busy !== null} onClick={() => void act('m:all', async () => {
                const r = await call('assets.updateLinks', { projectId: project.id, items: media.map((m) => ({ lineId: m.lineId, path: m.path })) });
                return `Updated ${plural(r.updated.length, 'copy', 'copies')}${r.failed.length ? `; ${r.failed.length} skipped` : ''}`;
              })}>
                Update all {media.length}
              </Button>
            )}
          </article>
        </section>
      )}
      {exports.length > 0 && (
        <section className="updates-section" aria-labelledby="upd-exports">
          <h2 id="upd-exports" className="assets-heading">
            Exported videos <span className="muted small">made before their sources changed</span>
          </h2>
          <article className="update-card material-solid">
            <ul className="update-list">
              {exports.map((e) => (
                <li key={e.jobId}>
                  <Icon name="film" size={14} />
                  <span>
                    <strong>{e.sequenceName}</strong> from {lineName(e.lineId)} <span className="muted small">· {e.reason}</span>
                  </span>
                  <span className="bar-spacer" />
                  <Button size="sm" variant="quiet" disabled={busy !== null || /deleted/.test(e.reason)} onClick={() => void act(`x:${e.jobId}`, async () => ((await call('video.export.start', { projectId: project.id, lineId: e.lineId, sequenceId: e.sequenceId, settings: e.settings })) ? `Exporting ${e.sequenceName} again` : null))}>
                    Export again
                  </Button>
                </li>
              ))}
            </ul>
          </article>
        </section>
      )}
    </div>
  );
}
