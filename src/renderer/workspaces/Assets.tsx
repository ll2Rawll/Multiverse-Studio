/**
 * Assets: one library for the project. Media (video, audio, images, fonts, screen recordings and
 * generated media) is shared by every version and lives in the project's media store; copies placed
 * into a version are tracked, so outdated copies can be updated. Brand settings and AI generation
 * live here too.
 */
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { useSelectionRefs } from '../state/selection';
import { ObjectsPanel } from './assets/ObjectsPanel';
import { useStudio, set, toast } from '../state/store';
import { useVideo, loadVideo, importMedia, relinkMedia, refreshMedia } from '../state/video';
import { useMedia, loadMediaJobs, loadBrand } from '../state/media';
import { call, droppedPaths, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Button, EmptyState, SegmentedControl } from '../components/primitives';
import { Icon } from '../components/Icon';
import { allLines, bytes, cx, lineRef } from '../lib/util';
import { addAssetToTimeline } from './Video';
import { GeneratePanel } from './media/GeneratePanel';
import { TranscribeDialog } from './media/TranscribeDialog';
import { BrandPanel } from './assets/BrandPanel';
import { useLibraryFonts } from '../lib/fonts';
import type { MediaAssetView } from '../../shared/video';

type Filter = 'all' | 'video' | 'audio' | 'image' | 'font' | 'generated' | 'recording' | 'missing';
type Tab = 'library' | 'objects' | 'generate' | 'brand';

const KIND_NAME: Record<MediaAssetView['kind'], string> = { video: 'Video', audio: 'Audio', image: 'Image', font: 'Font' };
const SETTING_LABEL: Record<string, string> = { size: 'Requested size', quality: 'Quality', count: 'Images requested', aspectRatio: 'Shape', resolution: 'Resolution', voice: 'Voice', style: 'Delivery', language: 'Language', page: 'Page', seconds: 'Length (s)', width: 'Width', height: 'Height', steps: 'Steps', startImage: 'Started from' };

function Provenance({ asset }: { asset: MediaAssetView }) {
  const p = asset.provenance;
  if (!p || p.source === 'imported') return null;
  const rows: [string, string][] = [
    ['Made by', p.source === 'recording' ? 'Recording in an isolated browser' : `${p.connectionName ?? p.provider ?? 'Unknown provider'}`],
    ...(p.model ? ([['Model', p.model]] as [string, string][]) : []),
    ...(p.prompt ? ([['Prompt', p.prompt]] as [string, string][]) : []),
    ...Object.entries(p.settings)
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => [SETTING_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1), String(v)] as [string, string]),
    ['Created', new Date(p.createdAt).toLocaleString()],
    ...(p.requestId ? ([['Request id', p.requestId]] as [string, string][]) : []),
  ];
  return (
    <section className="asset-prov" aria-label="Where this came from">
      <h3 className="panel-subhead">{p.source === 'recording' ? 'Recording' : 'Generated'}</h3>
      <dl className="asset-facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={k === 'Prompt' ? 'prov-prompt' : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Tags({ asset }: { asset: MediaAssetView }) {
  const projectId = useStudio((s) => s.project!.id);
  const [draft, setDraft] = useState('');
  const save = async (tags: string[]): Promise<void> => {
    try {
      await call('media.setTags', { projectId, assetId: asset.id, tags });
      await refreshMedia();
    } catch (error) {
      toast({ tone: 'error', title: 'Could not save tags', body: errorMessage(error) });
    }
  };
  return (
    <div className="asset-tags" aria-label="Tags">
      {asset.tags.map((t) => (
        <span key={t} className="chip">
          {t}
          <button type="button" className="chip-x" aria-label={`Remove tag ${t}`} onClick={() => void save(asset.tags.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        className="input tag-input"
        aria-label="Add a tag"
        placeholder="Add tag"
        value={draft}
        maxLength={40}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            void save([...asset.tags, draft.trim()]);
            setDraft('');
          }
        }}
      />
    </div>
  );
}

function Usage({ asset }: { asset: MediaAssetView }) {
  const project = useStudio((s) => s.project)!;
  const revision = useMedia((s) => s.revision);
  const usage = useAsync(() => call('media.usage', { projectId: project.id, assetId: asset.id }), [project.id, asset.id, asset.sha256, project.updatedAt, revision]);
  const [lineId, setLineId] = useState(useStudio.getState().selectedLineId);
  const [placing, setPlacing] = useState(false);
  const place = async (): Promise<void> => {
    setPlacing(true);
    try {
      const r = await call('assets.place', { projectId: project.id, lineId, assetId: asset.id });
      toast({ tone: 'success', title: r.changed ? `Copied into ${r.path}` : `${r.path} already has this file`, body: 'Use it in Design, or reference it from your code. If the library file changes, this copy is flagged as outdated.' });
      usage.reload();
    } catch (error) {
      toast({ tone: 'error', title: 'Could not place the file', body: errorMessage(error) });
    } finally {
      setPlacing(false);
    }
  };
  const update = async (items: { lineId: string; path: string }[]): Promise<void> => {
    const r = await call('assets.updateLinks', { projectId: project.id, items });
    toast({ tone: r.failed.length ? 'warning' : 'success', title: `Updated ${r.updated.length} cop${r.updated.length === 1 ? 'y' : 'ies'}`, body: r.failed.map((f) => f.reason).join(' ') || undefined });
    usage.reload();
  };
  const u = usage.data;
  const outdated = u?.files.filter((f) => f.outdated) ?? [];
  return (
    <section className="asset-usage" aria-label="Used in">
      <h3 className="panel-subhead">Used in</h3>
      {!u ? (
        <p className="muted small">Checking…</p>
      ) : u.sequences.length + u.files.length + u.brand.length === 0 ? (
        <p className="muted small">Not used in any version yet.</p>
      ) : (
        <ul className="usage-list">
          {u.sequences.map((s) => (
            <li key={`${s.lineId}:${s.sequenceId}`}>
              <Icon name="film" size={12} /> {s.sequenceName} <span className="muted small">in {s.lineName} · {s.clips} clip{s.clips === 1 ? '' : 's'}</span>
            </li>
          ))}
          {u.files.map((f) => (
            <li key={`${f.lineId}:${f.path}`} className={cx(f.outdated && 'is-outdated')}>
              <Icon name={f.outdated ? 'warning' : 'file'} size={12} /> {f.path} <span className="muted small">in {f.lineName}</span>
              {f.outdated && (
                <button type="button" className="link-btn" onClick={() => void update([{ lineId: f.lineId, path: f.path }])}>
                  Update copy
                </button>
              )}
            </li>
          ))}
          {u.brand.map((b) => (
            <li key={b}>
              <Icon name="brush" size={12} /> {b}
            </li>
          ))}
        </ul>
      )}
      {outdated.length > 1 && (
        <Button size="sm" icon="sync" onClick={() => void update(outdated.map((f) => ({ lineId: f.lineId, path: f.path })))}>
          Update all {outdated.length} outdated copies
        </Button>
      )}
      {asset.status === 'ready' && (
        <div className="place-row">
          <select className="input" aria-label="Version to place the file in" value={lineId} onChange={(e) => setLineId(e.target.value)}>
            {allLines(project).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <Button size="sm" icon="plus" disabled={placing} onClick={() => void place()}>
            Copy into version
          </Button>
        </div>
      )}
    </section>
  );
}

function Detail({ asset }: { asset: MediaAssetView }) {
  const p = asset.probe;
  const [transcribing, setTranscribing] = useState(false);
  const projectId = useStudio((s) => s.project!.id);
  const transcript = useAsync(() => call('media.transcript', { projectId, assetId: asset.id }), [projectId, asset.id, asset.hasTranscript], asset.hasTranscript);
  const rows: [string, string][] =
    asset.kind === 'font'
      ? [
          ['Kind', 'Font'],
          ['File', bytes(asset.size)],
          ['Imported', new Date(asset.importedAt).toLocaleString()],
        ]
      : asset.kind === 'image'
        ? [
            ['Kind', 'Image'],
            ['Size', p.width ? `${p.width}×${p.height}` : '—'],
            ['Format', p.videoCodec ?? asset.name.split('.').pop() ?? '—'],
            ['File', bytes(asset.size)],
            ['Imported', new Date(asset.importedAt).toLocaleString()],
          ]
        : [
          ['Kind', KIND_NAME[asset.kind]],
          ['Length', p.durationSeconds === null ? '—' : `${p.durationSeconds.toFixed(2)} s`],
          ['Size', p.width ? `${p.width}×${p.height}${p.rotation ? ` (rotated ${p.rotation}°)` : ''}` : '—'],
          ['Frame rate', p.fps ? `${(p.fps.num / p.fps.den).toFixed(2)} fps` : '—'],
          ['Video', p.videoCodec ?? '—'],
          ['Audio', p.audioCodec ? `${p.audioCodec}${p.sampleRate ? `, ${p.sampleRate / 1000} kHz` : ''}${p.channels ? `, ${p.channels === 1 ? 'mono' : p.channels === 2 ? 'stereo' : `${p.channels} ch`}` : ''}` : '—'],
          ['File', bytes(asset.size)],
          ['Preview', p.playable ? 'Plays directly' : asset.proxy === 'ready' ? 'Uses a smaller preview copy' : asset.proxy === 'failed' ? 'Preview copy failed' : 'Preparing a preview copy'],
          ['Imported', new Date(asset.importedAt).toLocaleString()],
        ];
  return (
    <aside className="asset-detail material-solid" aria-label={`${asset.name} details`}>
      <div className="asset-detail-media">
        {asset.status === 'missing' ? (
          <div className="asset-missing">
            <Icon name="warning" size={22} />
            <p>The file for this asset is missing from the project.</p>
          </div>
        ) : asset.kind === 'video' ? (
          <video src={asset.url ?? undefined} controls preload="metadata" poster={asset.thumbUrl ?? undefined} />
        ) : asset.kind === 'audio' ? (
          <audio src={asset.url ?? undefined} controls preload="metadata" />
        ) : asset.kind === 'font' ? (
          <div className="font-sample" style={{ fontFamily: `"mvfont-${asset.id}", var(--font-ui)` }}>
            Aa Bb Cc 123
          </div>
        ) : (
          <img src={asset.url ?? undefined} alt={asset.name} />
        )}
      </div>
      <h2 className="asset-detail-name">{asset.name}</h2>
      <Tags asset={asset} />
      <dl className="asset-facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <Provenance asset={asset} />
      {(asset.kind === 'video' || asset.kind === 'audio') && asset.probe.hasAudio && (
        <section aria-label="Transcript">
          <h3 className="panel-subhead">Transcript</h3>
          {asset.hasTranscript && transcript.data ? (
            <ol className="transcript">
              {transcript.data.segments.slice(0, 200).map((s, i) => (
                <li key={i}>
                  <span className="muted small">{s.start.toFixed(1)} s</span> {s.speaker ? <strong>{s.speaker}: </strong> : null}
                  {s.text}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">Not transcribed yet.</p>
          )}
          <Button size="sm" icon="text" disabled={asset.status !== 'ready'} onClick={() => setTranscribing(true)}>
            {asset.hasTranscript ? 'Transcribe again…' : 'Transcribe…'}
          </Button>
        </section>
      )}
      <Usage asset={asset} />
      <div className="asset-actions">
        {asset.status === 'missing' ? (
          <Button variant="primary" icon="relink" onClick={() => void relinkMedia(asset.id)}>
            Relink…
          </Button>
        ) : (
          asset.kind !== 'font' && (
            <Button
              icon="film"
              onClick={() => {
                set({ workspace: 'video' });
                setTimeout(() => useVideo.getState().sequence && addAssetToTimeline(asset), 300);
              }}
            >
              Add to the timeline
            </Button>
          )
        )}
      </div>
      {transcribing && <TranscribeDialog asset={asset} onClose={() => setTranscribing(false)} />}
    </aside>
  );
}

export function Assets() {
  const project = useStudio((s) => s.project)!;
  const lineId = useStudio((s) => s.selectedLineId);
  const version = useStudio((s) => s.previewVersions[s.selectedLineId] ?? 0);
  const media = useVideo((s) => s.media);
  const tools = useVideo((s) => s.tools);
  const [tab, setTab] = useState<Tab>(() => (useSelectionRefs.getState().openObject ? 'objects' : 'library'));
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const files = useAsync(() => call('files.list', { projectId: project.id, ref: lineRef(lineId) }), [project.id, lineId, version]);
  useLibraryFonts(media);

  useEffect(() => {
    void loadVideo(project.id, lineId);
  }, [project.id, lineId, version]);
  useEffect(() => {
    void loadMediaJobs(project.id);
    void loadBrand(project.id);
  }, [project.id]);

  const siteImages = (files.data ?? []).filter((f) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(f.path) && !f.path.startsWith('node_modules/'));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return media.filter((a) => {
      const okFilter = filter === 'all' || (filter === 'missing' ? a.status === 'missing' : filter === 'generated' ? a.provenance?.source === 'generated' : filter === 'recording' ? a.provenance?.source === 'recording' : a.kind === filter);
      const okQuery = !q || a.name.toLowerCase().includes(q) || a.tags.some((t) => t.includes(q)) || (a.provenance?.prompt ?? '').toLowerCase().includes(q);
      return okFilter && okQuery;
    });
  }, [media, filter, query]);
  const current = media.find((a) => a.id === selected) ?? null;
  useEffect(() => {
    useSelectionRefs.setState({ asset: current ? { id: current.id, label: current.name } : null });
  }, [current?.id, current?.name]);
  useEffect(() => () => useSelectionRefs.setState({ asset: null }), []);
  const missing = media.filter((a) => a.status === 'missing').length;
  const count = (f: (a: MediaAssetView) => boolean): number => media.filter(f).length;

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDropping(false);
    const paths = droppedPaths(e.dataTransfer.files);
    if (paths.length) void importMedia(paths);
    else if (e.dataTransfer.files.length) toast({ tone: 'info', title: 'Use Import media…', body: 'Dropping files is available in the desktop app.' });
  };

  return (
    <div className="assets">
      <div className="workspace-bar">
        <h1 className="workspace-title" data-text="Assets">
          Assets
        </h1>
        <SegmentedControl<Tab>
          size="sm"
          label="Assets section"
          options={[
            { value: 'library', label: 'Library' },
            { value: 'objects', label: 'Objects' },
            { value: 'generate', label: 'Generate' },
            { value: 'brand', label: 'Brand' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'library' && <input className="input asset-search" type="search" placeholder="Search names, tags, prompts" aria-label="Search assets" value={query} onChange={(e) => setQuery(e.target.value)} />}
        <span className="bar-spacer" />
        <Button size="sm" icon="upload" disabled={tools?.available === false} onClick={() => void importMedia()}>
          Import media…
        </Button>
      </div>
      {tools && !tools.available && (
        <div className="info-banner video-tools-banner" role="alert">
          <Icon name="warning" size={15} /> {tools.message}
        </div>
      )}
      {tab === 'objects' ? (
        <div className="assets-scroll">
          <ObjectsPanel />
        </div>
      ) : tab === 'brand' ? (
        <div className="assets-scroll">
          <BrandPanel />
        </div>
      ) : tab === 'generate' ? (
        <div className="assets-scroll">
          <div className="generate-page">
            <GeneratePanel />
          </div>
        </div>
      ) : (
        <div
          className={cx('assets-body', current && 'has-detail', dropping && 'is-dropping')}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDropping(true);
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
          onDrop={onDrop}
        >
          <div className="assets-scroll">
            <SegmentedControl<Filter>
              size="sm"
              label="Show"
              className="asset-filters"
              options={[
                { value: 'all', label: 'All' },
                { value: 'video', label: 'Video' },
                { value: 'audio', label: 'Audio' },
                { value: 'image', label: 'Images' },
                ...(count((a) => a.kind === 'font') ? [{ value: 'font' as const, label: 'Fonts' }] : []),
                ...(count((a) => a.provenance?.source === 'generated') ? [{ value: 'generated' as const, label: 'Generated' }] : []),
                ...(count((a) => a.provenance?.source === 'recording') ? [{ value: 'recording' as const, label: 'Recordings' }] : []),
                ...(missing ? [{ value: 'missing' as const, label: `Missing · ${missing}` }] : []),
              ]}
              value={filter}
              onChange={setFilter}
            />
            <section aria-labelledby="media-heading">
              <h2 id="media-heading" className="assets-heading">
                Project media <span className="muted small">shared by every version · drop files here to import</span>
              </h2>
              {shown.length === 0 ? (
                <EmptyState icon="stack" title={media.length ? 'Nothing matches' : 'No media yet'} body={media.length ? 'Try another filter or search.' : 'Import footage, music, pictures or fonts, record a page, or generate media.'} />
              ) : (
                <ul className="asset-grid">
                  {shown.map((a) => (
                    <li key={a.id} data-live={`asset:${a.id}`}>
                      <button type="button" className={cx('asset-tile', a.id === selected && 'is-selected', a.status === 'missing' && 'is-missing')} onClick={() => setSelected(a.id === selected ? null : a.id)} aria-pressed={a.id === selected}>
                        <span className="asset-thumb">
                          {a.thumbUrl && a.status === 'ready' ? <img src={a.thumbUrl} alt="" /> : a.kind === 'font' ? <span className="font-tile" style={{ fontFamily: `"mvfont-${a.id}", var(--font-ui)` }}>Aa</span> : <Icon name={a.status === 'missing' ? 'warning' : a.kind === 'audio' ? 'waveform' : 'film'} size={24} />}
                          {a.provenance && a.provenance.source !== 'imported' && <span className="asset-badge">{a.provenance.source === 'recording' ? 'Recorded' : 'AI'}</span>}
                        </span>
                        <span className="asset-name">{a.name}</span>
                        <span className="asset-meta">
                          {a.status === 'missing' ? 'Missing' : a.kind === 'font' ? 'Font' : a.probe.durationSeconds !== null ? `${a.probe.durationSeconds.toFixed(1)} s` : 'Still'}
                          {a.usedIn.length > 0 && ' · on a timeline'}
                          {a.hasTranscript && ' · transcribed'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {(filter === 'all' || filter === 'image') && siteImages.length > 0 && (
              <section aria-labelledby="site-heading">
                <h2 id="site-heading" className="assets-heading">
                  Site images <span className="muted small">files in this version</span>
                </h2>
                <ul className="site-images">
                  {siteImages
                    .filter((f) => !query.trim() || f.path.toLowerCase().includes(query.trim().toLowerCase()))
                    .map((f) => (
                      <li key={f.path}>
                        <button
                          type="button"
                          className="site-image"
                          onClick={() => {
                            set((s) => ({ selectedFile: { ...s.selectedFile, [lineId]: f.path }, workspace: 'build' }));
                          }}
                          title="Open in Build"
                        >
                          <Icon name="image" size={14} />
                          <span>{f.path}</span>
                          <span className="muted small">{bytes(f.size)}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            )}
          </div>
          {current && <Detail asset={current} />}
        </div>
      )}
    </div>
  );
}
