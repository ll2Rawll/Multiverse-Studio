import { useEffect, useState } from 'react';
import { useStudio, get } from '../state/store';
import {
  useVideo,
  loadVideo,
  loadSequence,
  createSequence,
  importMedia,
  relinkMedia,
  runVideo,
  stepVideo,
  setPlayhead,
  setPlaying,
  startExport,
  cancelExport,
  revealExport,
  getVideo,
  setVideo,
} from '../state/video';
import { Button, EmptyState, IconButton, SegmentedControl } from '../components/primitives';
import { Menu } from '../components/Menu';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useFoldSidebar, useKeyboard } from '../lib/hooks';
import { bytes, cx } from '../lib/util';
import { Player } from './video/Player';
import { Timeline, ASSET_MIME, splitAtPlayhead, deleteSelection, addTitle } from './video/Timeline';
import { ClipInspector } from './video/ClipInspector';
import { AiEditDialog } from './video/AiEditDialog';
import { RecordDialog } from './video/RecordDialog';
import { GeneratePanel } from './media/GeneratePanel';
import { loadMediaJobs, loadBrand, useMedia, ACTIVE_JOB } from '../state/media';
import { call, errorMessage } from '../lib/api';
import { toast } from '../state/store';
import { EXPORT_PRESETS, TICKS_PER_SECOND, frameTicks, sequenceDuration, type ExportJobView, type ExportSettings, type MediaAssetView } from '../../shared/video';

const duration = (a: MediaAssetView): string => {
  const d = a.probe.durationSeconds;
  if (a.kind === 'font') return 'Font';
  if (d === null) return a.kind === 'image' ? 'Still' : '—';
  return `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}`;
};

export function addAssetToTimeline(a: MediaAssetView): void {
  void runVideo('video.addClip', { assetId: a.id, media: { kind: a.kind, duration: a.probe.durationSeconds === null ? null : Math.round(a.probe.durationSeconds * TICKS_PER_SECOND) } });
}

function MediaBin({ onRecord }: { onRecord: () => void }) {
  const all = useVideo((s) => s.media);
  const hasSequence = useVideo((s) => Boolean(s.sequence));
  const media = all.filter((a) => a.kind !== 'font');
  if (media.length === 0)
    return (
      <div className="bin-empty">
        <p className="muted small">Import video, audio or images, record a page of a website version, or generate media. Files are copied into the project; originals are not changed.</p>
        <div className="job-actions">
          <Button size="sm" icon="upload" onClick={() => void importMedia()}>
            Import media…
          </Button>
          <Button size="sm" variant="quiet" icon="globe" onClick={onRecord}>
            Record a page…
          </Button>
        </div>
      </div>
    );
  return (
    <ul className="bin-list" aria-label="Media">
      {media.map((a) => (
        <li key={a.id} className={cx('bin-item', a.status === 'missing' && 'is-missing')} draggable={a.status === 'ready'} onDragStart={(e) => (e.dataTransfer.setData(ASSET_MIME, a.id), (e.dataTransfer.effectAllowed = 'copy'))} title={a.status === 'ready' ? 'Drag onto the timeline, or use Add' : undefined}>
          <span className="bin-thumb">{a.thumbUrl ? <img src={a.thumbUrl} alt="" draggable={false} /> : <Icon name={a.kind === 'audio' ? 'waveform' : 'film'} size={18} />}</span>
          <span className="bin-text">
            <span className="bin-name">{a.name}</span>
            <span className="bin-meta">
              {a.status === 'missing' ? 'Missing' : `${duration(a)}${a.probe.width ? ` · ${a.probe.width}×${a.probe.height}` : ''}`}
              {a.proxy === 'needed' && ' · preparing preview'}
            </span>
          </span>
          {a.status === 'missing' ? (
            <Button size="sm" variant="quiet" icon="relink" onClick={() => void relinkMedia(a.id)}>
              Relink
            </Button>
          ) : (
            <IconButton icon="plus" size="sm" label={`Add ${a.name} to the end of the timeline`} disabled={!hasSequence} onClick={() => addAssetToTimeline(a)} />
          )}
        </li>
      ))}
    </ul>
  );
}

async function exportAgain(j: ExportJobView): Promise<void> {
  try {
    await call('video.export.start', { projectId: j.projectId, lineId: j.lineId, sequenceId: j.sequenceId, settings: j.settings });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not export again', body: errorMessage(error) });
  }
}

function ExportList() {
  const jobs = useVideo((s) => s.jobs);
  if (jobs.length === 0) return <p className="muted small bin-empty">Exports you start appear here with their progress.</p>;
  return (
    <ul className="bin-list" aria-label="Exports">
      {jobs.map((j) => (
        <li key={j.id} className={cx('job-item', `is-${j.state}`)}>
          <div className="job-head">
            <span className="bin-name">
              {j.sequenceName} · {j.settings.format.toUpperCase()}
            </span>
            <span className="job-state">{{ queued: 'Waiting', running: `${Math.round(j.progress * 100)}%`, completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' }[j.state]}</span>
          </div>
          {(j.state === 'running' || j.state === 'queued') && (
            <div className="job-progress" role="progressbar" aria-label={`Export of ${j.sequenceName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(j.progress * 100)}>
              <span style={{ width: `${j.progress * 100}%` }} />
            </div>
          )}
          {j.verified && (
            <span className="bin-meta">
              {j.verified.width}×{j.verified.height} · {j.verified.durationSeconds.toFixed(1)} s · {bytes(j.verified.size)} · checked
            </span>
          )}
          {j.error && <span className="bin-meta job-error">{j.error.split('\n')[0]}</span>}
          {j.outdated && (
            <span className="bin-meta job-warn">
              <Icon name="warning" size={11} /> Outdated: {j.outdated.detail}
            </span>
          )}
          <div className="job-actions">
            {(j.state === 'running' || j.state === 'queued') && (
              <Button size="sm" variant="quiet" icon="stop" onClick={() => void cancelExport(j.id)}>
                Cancel
              </Button>
            )}
            {j.state === 'completed' && (
              <Button size="sm" variant="quiet" icon="folder" onClick={() => void revealExport(j.id)}>
                Show file
              </Button>
            )}
            {j.outdated && j.outdated.reason !== 'sequence-deleted' && j.outdated.reason !== 'version-deleted' && (
              <Button size="sm" variant="quiet" icon="sync" onClick={() => void exportAgain(j)}>
                Export again
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const seq = useVideo((s) => s.sequence)!;
  const playhead = useVideo((s) => s.playhead);
  const [s, setS] = useState<ExportSettings>({ preset: 'sequence', resolution: 0, fps: 'sequence', quality: 'standard', format: 'mp4', range: null });
  const [rangeMode, setRangeMode] = useState<'all' | 'check'>('all');
  const total = sequenceDuration(seq);
  const submit = async (): Promise<void> => {
    const range = rangeMode === 'check' ? { start: Math.min(playhead, Math.max(0, total - 1)), end: Math.min(total, playhead + 5 * TICKS_PER_SECOND) } : null;
    if (await startExport({ ...s, range })) onClose();
  };
  return (
    <Dialog
      title={`Export ${seq.name}`}
      description="Rendered with FFmpeg. The file is only marked done after it is read back and checked."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="export" disabled={total === 0} onClick={() => void submit()}>
            Export…
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <label className="prop-row">
          <span className="prop-label">Shape</span>
          <select className="input" aria-label="Shape" value={s.preset} onChange={(e) => setS({ ...s, preset: e.target.value as ExportSettings['preset'] })}>
            {Object.entries(EXPORT_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {k === 'sequence' ? `${v.label} (${seq.settings.width}×${seq.settings.height})` : `${v.label} (${v.width}×${v.height})`}
              </option>
            ))}
          </select>
        </label>
        <label className="prop-row">
          <span className="prop-label">Resolution</span>
          <select className="input" aria-label="Resolution" value={s.resolution} onChange={(e) => setS({ ...s, resolution: Number(e.target.value) as ExportSettings['resolution'] })}>
            <option value={0}>As above</option>
            <option value={2160}>2160p</option>
            <option value={1080}>1080p</option>
            <option value={720}>720p</option>
            <option value={480}>480p</option>
          </select>
        </label>
        <label className="prop-row">
          <span className="prop-label">Frame rate</span>
          <select className="input" aria-label="Frame rate" value={String(s.fps)} onChange={(e) => setS({ ...s, fps: e.target.value === 'sequence' ? 'sequence' : (Number(e.target.value) as 24) })}>
            <option value="sequence">Same as the sequence</option>
            {[24, 25, 30, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
        <label className="prop-row">
          <span className="prop-label">Quality</span>
          <select className="input" aria-label="Quality" value={s.quality} onChange={(e) => setS({ ...s, quality: e.target.value as ExportSettings['quality'] })}>
            <option value="high">High (large file)</option>
            <option value="standard">Standard</option>
            <option value="small">Small file</option>
          </select>
        </label>
        <div className="prop-row">
          <span className="prop-label">Format</span>
          <SegmentedControl size="sm" label="Format" options={[{ value: 'mp4', label: 'MP4 (H.264)' }, { value: 'webm', label: 'WebM (VP9)' }]} value={s.format} onChange={(format) => setS({ ...s, format })} />
        </div>
        <div className="prop-row">
          <span className="prop-label">Length</span>
          <SegmentedControl size="sm" label="Length" options={[{ value: 'all', label: 'Whole sequence' }, { value: 'check', label: '5 s from playhead' }]} value={rangeMode} onChange={setRangeMode} />
        </div>
      </div>
    </Dialog>
  );
}

function NewSequence({ compact }: { compact?: boolean }) {
  const presets: [string, number, number][] = [
    ['Landscape', 1920, 1080],
    ['Portrait', 1080, 1920],
    ['Square', 1080, 1080],
  ];
  const count = useVideo((s) => s.sequences.length);
  const projectId = useStudio((s) => s.project!.id);
  const lineId = useStudio((s) => s.selectedLineId);
  const make = (label: string, w: number, h: number): void => void createSequence(projectId, lineId, count ? `${label} ${count + 1}` : 'First cut', w, h, 30);
  if (compact)
    return (
      <Menu label="New sequence" align="start" items={presets.map(([l, w, h]) => ({ label: `${l} ${w}×${h}`, icon: 'film', onSelect: () => make(l, w, h) }))} trigger={(props) => <IconButton icon="plus" size="sm" label="New sequence" {...props} />} />
    );
  return (
    <div className="new-seq">
      {presets.map(([l, w, h]) => (
        <button key={l} type="button" className="new-seq-btn" onClick={() => make(l, w, h)}>
          <span className="new-seq-frame" style={{ aspectRatio: `${w} / ${h}` }} />
          <span>{l}</span>
          <span className="muted small">
            {w}×{h} · 30 fps
          </span>
        </button>
      ))}
    </div>
  );
}

export function Video() {
  const project = useStudio((s) => s.project)!;
  const lineId = useStudio((s) => s.selectedLineId);
  const version = useStudio((s) => s.previewVersions[s.selectedLineId] ?? 0);
  const tools = useVideo((s) => s.tools);
  const sequences = useVideo((s) => s.sequences);
  const seq = useVideo((s) => s.sequence);
  const sequenceId = useVideo((s) => s.sequenceId);
  const undo = useVideo((s) => s.undo);
  const redo = useVideo((s) => s.redo);
  const loadError = useVideo((s) => s.loadError);
  const jobs = useVideo((s) => s.jobs);
  const aiDialog = useVideo((s) => s.aiDialog);
  const genActive = useMedia((s) => s.jobs.filter((j) => ACTIVE_JOB.has(j.state) && j.kind !== 'transcription').length);
  const [binTab, setBinTab] = useState<'media' | 'generate' | 'exports'>('media');
  const [exporting, setExporting] = useState(false);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    void loadVideo(project.id, lineId);
  }, [project.id, lineId, version]);
  useEffect(() => {
    void loadMediaJobs(project.id);
    void loadBrand(project.id);
  }, [project.id]);
  useEffect(() => () => setPlaying(false), []);
  useFoldSidebar();
  // Show the exports list when a new one starts.
  const running = jobs.filter((j) => j.state === 'running' || j.state === 'queued').length;
  useEffect(() => {
    if (running > 0) setBinTab('exports');
  }, [running]);

  useKeyboard((e) => {
    if (get().dialog || exporting || recording || getVideo().aiDialog || !getVideo().sequence) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    const frame = frameTicks(getVideo().sequence!.settings.fps);
    if (e.key === ' ' && !mod) {
      e.preventDefault();
      setPlaying(!getVideo().playing);
    } else if (e.key.toLowerCase() === 'z' && mod) {
      e.preventDefault();
      void stepVideo(e.shiftKey ? 'redo' : 'undo');
    } else if (e.key.toLowerCase() === 'y' && mod) {
      e.preventDefault();
      void stepVideo('redo');
    } else if (mod || e.altKey) {
      return;
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      void splitAtPlayhead();
    } else if (e.key.toLowerCase() === 't') {
      e.preventDefault();
      void addTitle();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void deleteSelection(e.shiftKey);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? TICKS_PER_SECOND : frame;
      setPlayhead(getVideo().playhead + (e.key === 'ArrowLeft' ? -step : step));
    } else if (e.key === 'Home') {
      setPlayhead(0);
    } else if (e.key === 'End') {
      setPlayhead(sequenceDuration(getVideo().sequence!));
    } else if (e.key === 'Escape') {
      setVideo({ selection: [] });
    }
  });

  const current = sequences.find((s) => s.id === sequenceId);
  return (
    <div className="video">
      <div className="workspace-bar">
        <h1 className="workspace-title" data-text="Video">
          Video
        </h1>
        {sequences.length > 0 && (
          <Menu
            label="Sequence"
            align="start"
            items={sequences.map((s) => ({ label: s.name, icon: 'film', checked: s.id === sequenceId, hint: `${Math.round(s.durationSeconds)} s`, onSelect: () => void loadSequence(s.id) }))}
            trigger={(props) => (
              <button type="button" className="page-chip" {...props}>
                <Icon name="film" size={14} />
                <span>{current?.name ?? 'Sequence'}</span>
                <Icon name="chevronDown" size={12} />
              </button>
            )}
          />
        )}
        {tools?.available && sequences.length > 0 && <NewSequence compact />}
        <span className="bar-spacer" />
        {seq && (
          <>
            <IconButton icon="undo" size="sm" label={undo ? `Undo ${undo} (Ctrl+Z)` : 'Nothing to undo'} disabled={!undo} onClick={() => void stepVideo('undo')} />
            <IconButton icon="restore" size="sm" className="flip-x" label={redo ? `Redo ${redo} (Ctrl+Shift+Z)` : 'Nothing to redo'} disabled={!redo} onClick={() => void stepVideo('redo')} />
            <Button size="sm" icon="wand" disabled={!tools?.available} onClick={() => setVideo({ aiDialog: true })}>
              Edit with AI…
            </Button>
            <Button size="sm" variant="primary" icon="export" disabled={!tools?.available || sequenceDuration(seq) === 0} onClick={() => setExporting(true)}>
              Export…
            </Button>
          </>
        )}
      </div>
      {tools && !tools.available && (
        <div className="info-banner video-tools-banner" role="alert">
          <Icon name="warning" size={15} /> {tools.message}
        </div>
      )}
      {loadError && <p className="info-banner">{loadError}</p>}
      <div className={cx('video-body', !seq && 'no-sequence')}>
        <aside className="video-bin material-solid" aria-label="Media and exports">
          <div className="bin-head">
            <SegmentedControl
              size="sm"
              label="Show"
              className="design-tabs"
              options={[
                { value: 'media', label: 'Media' },
                { value: 'generate', label: genActive ? `Generate · ${genActive}` : 'Generate' },
                { value: 'exports', label: running ? `Exports · ${running}` : 'Exports' },
              ]}
              value={binTab}
              onChange={setBinTab}
            />
          </div>
          {binTab === 'media' && tools?.available && (
            <div className="bin-tools">
              <Button size="sm" variant="quiet" icon="upload" onClick={() => void importMedia()} aria-label="Import media">
                Import
              </Button>
              <Button size="sm" variant="quiet" icon="globe" onClick={() => setRecording(true)} aria-label="Record a page of a version">
                Record a page
              </Button>
            </div>
          )}
          <div className="bin-scroll">{binTab === 'media' ? <MediaBin onRecord={() => setRecording(true)} /> : binTab === 'generate' ? <GeneratePanel compact /> : <ExportList />}</div>
        </aside>
        {seq ? (
          <>
            <Player />
            <ClipInspector />
            <Timeline />
          </>
        ) : (
          <div className="video-start">
            <EmptyState icon="film" title="Start a sequence" body="A sequence is a timeline. It is saved in this version of the project, so alternatives can try different cuts of the same footage.">
              {tools?.available !== false && <NewSequence />}
            </EmptyState>
          </div>
        )}
      </div>
      {exporting && seq && <ExportDialog onClose={() => setExporting(false)} />}
      {aiDialog && seq && <AiEditDialog onClose={() => setVideo({ aiDialog: false })} />}
      {recording && <RecordDialog onClose={() => setRecording(false)} />}
    </div>
  );
}
