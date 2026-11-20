import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { useVideo, runVideo, select, setPlayhead, setZoom, loadWaveform, setVideo, getVideo } from '../../state/video';
import { toast } from '../../state/store';
import { IconButton } from '../../components/primitives';
import { Menu } from '../../components/Menu';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/util';
import { TICKS_PER_SECOND, clipDuration, clipEnd, sequenceDuration, type Clip, type MediaAssetView, type Sequence, type Track } from '../../../shared/video';
import { pxToTicks, ticksToPx } from './geometry';

const HEADER_W = 156;
const LANE_H: Record<Track['kind'], number> = { video: 58, audio: 46, text: 34 };
const SNAP_PX = 8;

export const ASSET_MIME = 'application/x-mv-asset';

/** Text and video tracks top-most first (as they stack), then audio tracks. */
export function displayOrder(seq: Sequence): Track[] {
  const text = seq.tracks.filter((t) => t.kind === 'text').reverse();
  const video = seq.tracks.filter((t) => t.kind === 'video').reverse();
  const audio = seq.tracks.filter((t) => t.kind === 'audio');
  return [...text, ...video, ...audio];
}

function snapCandidates(seq: Sequence, exclude: string): number[] {
  const out = [0, getVideo().playhead];
  for (const t of seq.tracks) for (const c of t.clips) if (c.id !== exclude) out.push(c.start, clipEnd(c));
  return out;
}

function snap(value: number, candidates: number[], zoom: number): number {
  let best = value;
  let dist = pxToTicks(SNAP_PX, zoom);
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d < dist) {
      dist = d;
      best = c;
    }
  }
  return best;
}

function Waveform({ asset, from, to, width, height }: { asset: MediaAssetView; from: number; to: number; width: number; height: number }) {
  const wave = useVideo((s) => s.waveforms[asset.id]);
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    void loadWaveform(asset.id);
  }, [asset.id]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !wave || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.min(4000, Math.round(width));
    canvas.width = w * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = getComputedStyle(canvas).color;
    // Past 4000 px the drawing stops, so it covers only the matching start of the clip and stays aligned with it.
    const a = from / wave.bucketSeconds;
    const b = (from + ((to - from) * w) / width) / wave.bucketSeconds;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(a + ((b - a) * x) / w);
      const i1 = Math.max(i0 + 1, Math.floor(a + ((b - a) * (x + 1)) / w));
      let peak = 0;
      for (let i = i0; i < i1 && i < wave.peaks.length; i++) peak = Math.max(peak, wave.peaks[i]!);
      const h = Math.max(1, peak * (height - 6));
      ctx.fillRect(x, (height - h) / 2, 1, h);
    }
  }, [wave, from, to, width, height]);
  return <canvas ref={ref} className="tl-wave" style={{ width: Math.min(4000, width), height }} aria-hidden="true" />;
}

interface Drag {
  kind: 'move' | 'trim-start' | 'trim-end';
  clip: Clip;
  track: Track;
  x0: number;
  start: number;
  edge: number;
  trackId: string;
  moved: boolean;
}

function ClipView({ clip, track, asset, zoom, selected, drag, onPointerDown }: { clip: Clip; track: Track; asset: MediaAssetView | undefined; zoom: number; selected: boolean; drag: Drag | null; onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, kind: Drag['kind']) => void }) {
  const dragging = drag?.clip.id === clip.id && drag.moved ? drag : null;
  let start = clip.start;
  let end = clipEnd(clip);
  if (dragging?.kind === 'move') {
    end = dragging.start + (end - start);
    start = dragging.start;
  } else if (dragging?.kind === 'trim-start') start = dragging.edge;
  else if (dragging?.kind === 'trim-end') end = dragging.edge;
  const left = ticksToPx(start, zoom);
  const width = Math.max(4, ticksToPx(end - start, zoom));
  const h = LANE_H[track.kind] - 8;
  const media = clip.type === 'media' ? clip : null;
  const label = clip.type === 'text' ? clip.text : (asset?.name ?? 'Missing media');
  const style: Record<string, string | number> = { left, width };
  if (media && asset?.kind === 'video' && asset.stripUrl && track.kind === 'video') {
    const full = ((asset.probe.durationSeconds ?? 0) / media.speed) * zoom;
    style.backgroundImage = `url("${asset.stripUrl}")`;
    style.backgroundSize = `${full}px 100%`;
    style.backgroundPositionX = `${-((media.in / TICKS_PER_SECOND) / media.speed) * zoom}px`;
  } else if (media && asset?.kind === 'image' && asset.thumbUrl) {
    style.backgroundImage = `url("${asset.thumbUrl}")`;
    style.backgroundSize = `auto 100%`;
  }
  return (
    <div
      className={cx('tl-clip', `is-${track.kind}`, selected && 'is-selected', dragging && 'is-dragging', asset?.status === 'missing' && 'is-missing', track.locked && 'is-locked')}
      style={style}
      data-clip-id={clip.id}
      role="button"
      tabIndex={-1}
      aria-label={`${label}, ${((end - start) / TICKS_PER_SECOND).toFixed(1)} seconds`}
      aria-pressed={selected}
      onPointerDown={(e) => onPointerDown(e, 'move')}
    >
      {media && asset && track.kind !== 'video' && asset.probe.hasAudio && <Waveform asset={asset} from={media.in / TICKS_PER_SECOND} to={media.out / TICKS_PER_SECOND} width={width} height={h} />}
      {media && asset && track.kind === 'video' && asset.probe.hasAudio && (
        <div className="tl-clip-audio">
          <Waveform asset={asset} from={media.in / TICKS_PER_SECOND} to={media.out / TICKS_PER_SECOND} width={width} height={14} />
        </div>
      )}
      <span className="tl-clip-label">
        {clip.transitionIn && <Icon name="transition" size={11} />}
        {media?.muted && <Icon name="mute" size={11} />}
        <span>{label}</span>
        {media && media.speed !== 1 && <span className="tl-badge">{media.speed}×</span>}
      </span>
      {clip.fadeIn > 0 && <span className="tl-fade is-in" style={{ width: ticksToPx(clip.fadeIn, zoom) }} />}
      {clip.fadeOut > 0 && <span className="tl-fade is-out" style={{ width: ticksToPx(clip.fadeOut, zoom) }} />}
      {!track.locked && (
        <>
          <span className="tl-handle is-start" onPointerDown={(e) => (e.stopPropagation(), onPointerDown(e as never, 'trim-start'))} aria-hidden="true" />
          <span className="tl-handle is-end" onPointerDown={(e) => (e.stopPropagation(), onPointerDown(e as never, 'trim-end'))} aria-hidden="true" />
        </>
      )}
    </div>
  );
}

function PlayheadLine({ height }: { height: number }) {
  const t = useVideo((s) => s.playhead);
  const zoom = useVideo((s) => s.zoom);
  return <div className="tl-playhead" style={{ left: HEADER_W + ticksToPx(t, zoom), height }} aria-hidden="true" />;
}

function Ruler({ width, onScrub }: { width: number; onScrub: (e: ReactPointerEvent<HTMLDivElement>) => void }) {
  const zoom = useVideo((s) => s.zoom);
  // Pick a label step that keeps labels at least ~70 px apart.
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * zoom >= 70) ?? 600;
  const marks: number[] = [];
  for (let s = 0; s * zoom <= width; s += step) marks.push(s);
  return (
    <div className="tl-ruler" style={{ width }} onPointerDown={onScrub}>
      {marks.map((s) => (
        <span key={s} className="tl-mark" style={{ left: s * zoom }}>
          {Math.floor(s / 60)}:{String(Math.floor(s % 60)).padStart(2, '0')}
          {step < 1 && s % 1 ? '.5' : ''}
        </span>
      ))}
    </div>
  );
}

export function Timeline() {
  const seq = useVideo((s) => s.sequence)!;
  const zoom = useVideo((s) => s.zoom);
  const snapping = useVideo((s) => s.snapping);
  const selection = useVideo((s) => s.selection);
  const mediaList = useVideo((s) => s.media);
  const media = new Map(mediaList.map((m) => [m.id, m]));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [viewW, setViewW] = useState(800);
  const tracks = displayOrder(seq);
  const duration = sequenceDuration(seq);
  const contentW = Math.max(viewW - HEADER_W, ticksToPx(duration, zoom) + 400);
  const totalH = 26 + tracks.reduce((h, t) => h + LANE_H[t.kind], 0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setViewW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xToTicks = (clientX: number): number => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, pxToTicks(clientX - rect.left - HEADER_W + el.scrollLeft, zoom));
  };

  const scrub = (e: ReactPointerEvent<HTMLDivElement>): void => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPlayhead(xToTicks(e.clientX));
    const move = (ev: PointerEvent): void => setPlayhead(xToTicks(ev.clientX));
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>, clip: Clip, track: Track, kind: Drag['kind']): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    (scrollRef.current as HTMLElement).focus({ preventScroll: true });
    const sel = getVideo().selection;
    if (e.shiftKey || e.metaKey || e.ctrlKey) select(sel.includes(clip.id) ? sel.filter((x) => x !== clip.id) : [...sel, clip.id]);
    else if (!sel.includes(clip.id) || sel.length > 1) select([clip.id]);
    if (track.locked) return;
    const d: Drag = { kind, clip, track, x0: e.clientX, start: clip.start, edge: kind === 'trim-start' ? clip.start : clipEnd(clip), trackId: track.id, moved: false };
    dragRef.current = d;
    const candidates = snapCandidates(seq, clip.id);
    const move = (ev: PointerEvent): void => {
      const cur = dragRef.current!;
      const dx = ev.clientX - cur.x0;
      if (!cur.moved && Math.abs(dx) < 3) return;
      const delta = pxToTicks(dx, zoom);
      const next: Drag = { ...cur, moved: true };
      if (kind === 'move') {
        let start = Math.max(0, clip.start + delta);
        if (getVideo().snapping) {
          const len = clipDuration(clip);
          const s1 = snap(start, candidates, zoom);
          const s2 = snap(start + len, candidates, zoom) - len;
          start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : Math.max(0, s2);
        }
        next.start = start;
        const lane = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-track-id]');
        const target = lane ? seq.tracks.find((t) => t.id === lane.dataset.trackId) : null;
        next.trackId = target && target.kind === track.kind && !target.locked ? target.id : track.id;
      } else {
        let edge = Math.max(0, (kind === 'trim-start' ? clip.start : clipEnd(clip)) + delta);
        if (getVideo().snapping) edge = snap(edge, candidates, zoom);
        next.edge = edge;
      }
      dragRef.current = next;
      setDrag(next);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const cur = dragRef.current;
      dragRef.current = null;
      if (!cur?.moved) {
        setDrag(null);
        return;
      }
      const asset = clip.type === 'media' ? media.get(clip.assetId) : undefined;
      const done =
        kind === 'move'
          ? runVideo('video.moveClip', { clipId: clip.id, start: cur.start, ...(cur.trackId !== track.id ? { trackId: cur.trackId } : {}) })
          : runVideo('video.trimClip', { clipId: clip.id, edge: kind === 'trim-start' ? 'start' : 'end', at: cur.edge, sourceDuration: asset && asset.kind !== 'image' && asset.probe.durationSeconds !== null ? Math.round(asset.probe.durationSeconds * TICKS_PER_SECOND) : null });
      void done.finally(() => setDrag(null));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, track: Track): void => {
    const id = e.dataTransfer.getData(ASSET_MIME);
    if (!id) return;
    e.preventDefault();
    const asset = media.get(id);
    if (!asset) return;
    const fits = asset.kind === 'audio' ? track.kind === 'audio' : track.kind === 'video';
    let start = xToTicks(e.clientX);
    if (snapping) start = snap(start, snapCandidates(seq, ''), zoom);
    void runVideo('video.addClip', { assetId: asset.id, media: { kind: asset.kind, duration: asset.probe.durationSeconds === null ? null : Math.round(asset.probe.durationSeconds * TICKS_PER_SECOND) }, start, ...(fits ? { trackId: track.id } : {}) });
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  return (
    <section className="timeline material-solid" aria-label="Timeline">
      <TimelineBar seq={seq} />
      <div ref={scrollRef} className="tl-scroll" tabIndex={0} onWheel={onWheel} aria-label="Tracks and clips">
        <div className="tl-inner" style={{ width: HEADER_W + contentW, height: totalH }}>
          <div className="tl-row tl-ruler-row">
            <div className="tl-head tl-corner" />
            <Ruler width={contentW} onScrub={scrub} />
          </div>
          {tracks.map((track) => (
            <div key={track.id} className={cx('tl-row', `is-${track.kind}`)} style={{ height: LANE_H[track.kind] }}>
              <div className="tl-head">
                <span className="tl-track-name" title={track.name}>
                  <Icon name={track.kind === 'audio' ? 'waveform' : track.kind === 'text' ? 'text' : 'film'} size={13} />
                  {track.name}
                </span>
                {track.kind !== 'audio' && <IconButton icon={track.hidden ? 'eyeOff' : 'eye'} size="sm" label={track.hidden ? `Show ${track.name}` : `Hide ${track.name}`} active={track.hidden} onClick={() => void runVideo('video.setTrack', { trackId: track.id, patch: { hidden: !track.hidden } })} />}
                {track.kind !== 'text' && <IconButton icon={track.muted ? 'mute' : 'volume'} size="sm" label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`} active={track.muted} onClick={() => void runVideo('video.setTrack', { trackId: track.id, patch: { muted: !track.muted } })} />}
                <IconButton icon="lock" size="sm" className={cx('tl-lock', track.locked && 'is-on')} label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`} active={track.locked} onClick={() => void runVideo('video.setTrack', { trackId: track.id, patch: { locked: !track.locked } })} />
              </div>
              <div
                className="tl-lane"
                data-track-id={track.id}
                style={{ width: contentW }}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  select([]);
                  scrub(e);
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(ASSET_MIME)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }
                }}
                onDrop={(e) => onDrop(e, track)}
              >
                {track.clips.map((clip) => (
                  <ClipView key={clip.id} clip={clip} track={track} asset={clip.type === 'media' ? media.get(clip.assetId) : undefined} zoom={zoom} selected={selection.includes(clip.id)} drag={drag && (drag.trackId === track.id || drag.track.id === track.id) ? drag : null} onPointerDown={(e, kind) => beginDrag(e, clip, track, kind)} />
                ))}
                {drag?.moved && drag.kind === 'move' && drag.trackId === track.id && drag.track.id !== track.id && (
                  <div className="tl-clip is-ghost" style={{ left: ticksToPx(drag.start, zoom), width: ticksToPx(clipDuration(drag.clip), zoom) }} />
                )}
              </div>
            </div>
          ))}
          <PlayheadLine height={totalH} />
        </div>
      </div>
    </section>
  );
}

function TimelineBar({ seq }: { seq: Sequence }) {
  const zoom = useVideo((s) => s.zoom);
  const snapping = useVideo((s) => s.snapping);
  const selection = useVideo((s) => s.selection);
  const playhead = useVideo((s) => s.playhead);
  const busy = useVideo((s) => s.busy);
  return (
    <div className="tl-bar">
      <IconButton icon="scissors" size="sm" label="Split at the playhead (S)" onClick={() => void splitAtPlayhead()} />
      <IconButton icon="trash" size="sm" label="Delete selected clips (Delete; Shift+Delete closes the gap)" disabled={selection.length === 0} onClick={() => void deleteSelection(false)} />
      <IconButton icon="text" size="sm" label="Add a title at the playhead (T)" onClick={() => void addTitle()} />
      <Menu
        label="Add track"
        align="start"
        items={[
          { label: 'Video track', icon: 'film', onSelect: () => void runVideo('video.addTrack', { kind: 'video' }) },
          { label: 'Audio track', icon: 'waveform', onSelect: () => void runVideo('video.addTrack', { kind: 'audio' }) },
          { label: 'Titles track', icon: 'text', onSelect: () => void runVideo('video.addTrack', { kind: 'text' }) },
        ]}
        trigger={(props) => <IconButton icon="plus" size="sm" label="Add track" {...props} />}
      />
      <span className="toolbar-divider" aria-hidden="true" />
      <IconButton icon="magnet" size="sm" label={snapping ? 'Snapping on' : 'Snapping off'} active={snapping} onClick={() => setVideo({ snapping: !snapping })} />
      <label className="tl-zoom">
        <Icon name="zoomOut" size={13} />
        <input type="range" min={4} max={600} step={1} value={zoom} aria-label="Timeline zoom" onChange={(e) => setZoom(Number(e.target.value))} />
        <Icon name="zoomIn" size={13} />
      </label>
      <span className="bar-spacer" />
      {busy && <span className="spinner tl-busy" aria-label="Saving" />}
      <span className="muted small">{seq.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · playhead {(playhead / TICKS_PER_SECOND).toFixed(2)} s</span>
    </div>
  );
}

/* ---------------- actions shared with keyboard shortcuts ---------------- */

export async function splitAtPlayhead(): Promise<void> {
  const { sequence, playhead, selection } = getVideo();
  if (!sequence) return;
  const order = displayOrder(sequence);
  const under = (c: Clip): boolean => playhead > c.start && playhead < clipEnd(c);
  const target =
    order.flatMap((t) => t.clips.filter((c) => selection.includes(c.id) && under(c) && !t.locked))[0] ?? order.filter((t) => !t.locked).flatMap((t) => t.clips.filter(under))[0];
  if (!target) {
    toast({ tone: 'info', title: 'Nothing to split here', body: 'Move the playhead over a clip.' });
    return;
  }
  await runVideo('video.splitClip', { clipId: target.id, at: playhead });
}

export async function deleteSelection(ripple: boolean): Promise<void> {
  const { selection } = getVideo();
  if (!selection.length) return;
  if (await runVideo('video.deleteClips', { clipIds: selection, ripple })) select([]);
}

export async function addTitle(): Promise<void> {
  const { sequence, playhead } = getVideo();
  if (!sequence) return;
  if (!sequence.tracks.some((t) => t.kind === 'text')) await runVideo('video.addTrack', { kind: 'text' });
  await runVideo('video.addText', { start: playhead, duration: 3 * TICKS_PER_SECOND, text: 'Title' });
}
