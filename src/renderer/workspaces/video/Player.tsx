/**
 * The viewer. It plays the timeline with one media element per track, kept in step with a master
 * clock, and draws position, scale, rotation, crop, opacity, fades and titles the way the
 * exporter does. It is a preview: transitions show as fades into the incoming clip, and volume
 * above 100% plays at 100%. The exported file is rendered frame-accurately by FFmpeg.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useVideo, setPlayhead, setPlaying, fmtTime, getVideo } from '../../state/video';
import { IconButton } from '../../components/primitives';
import { TICKS_PER_SECOND, clipEnd, frameTicks, fpsValue, sequenceDuration, type MediaAssetView, type MediaClip, type Sequence, type TextClip, type Track } from '../../../shared/video';
import { activeClip, clipBox, fadeFactor, sourceSeconds } from './geometry';
import { useLibraryFonts } from '../../lib/fonts';

function syncElement(el: HTMLMediaElement, clip: MediaClip, t: number, playing: boolean, fps: number): void {
  const target = sourceSeconds(clip, t);
  const tolerance = playing ? 0.25 : 0.5 / fps;
  if (Math.abs(el.currentTime - target) > tolerance && el.readyState >= 1) el.currentTime = target;
  if (el.playbackRate !== clip.speed) el.playbackRate = clip.speed;
  if (playing && el.paused) void el.play().catch(() => undefined);
  if (!playing && !el.paused) el.pause();
}

function MediaLayer({ track, seq, media, t, playing }: { track: Track; seq: Sequence; media: Map<string, MediaAssetView>; t: number; playing: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const clip = activeClip(track, t);
  const mediaClip = clip?.type === 'media' ? clip : null;
  const asset = mediaClip ? media.get(mediaClip.assetId) : undefined;
  const fps = fpsValue(seq.settings.fps);
  const url = asset?.status === 'ready' ? asset.url : null;

  useEffect(() => {
    const el = ref.current;
    if (!el || !mediaClip || !asset || asset.kind === 'image') return;
    el.muted = track.muted || mediaClip.muted;
    el.volume = Math.max(0, Math.min(1, mediaClip.volume * track.volume * fadeFactor(mediaClip, t)));
    syncElement(el, mediaClip, t, playing, fps);
  });
  useEffect(() => {
    if (!mediaClip) ref.current?.pause();
  }, [mediaClip?.id]);

  if (!mediaClip) return null;
  if (!asset || asset.status === 'missing') {
    return track.kind === 'video' ? (
      <div className="player-missing" style={{ left: 0, top: 0, width: seq.settings.width, height: seq.settings.height, fontSize: seq.settings.height / 22 }}>
        Media offline: {asset?.name ?? mediaClip.assetId}
      </div>
    ) : null;
  }
  if (track.kind === 'audio') return <audio ref={ref as never} src={asset.url ?? undefined} preload="auto" />;
  const box = clipBox(mediaClip, asset, seq);
  const style: CSSProperties = {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    opacity: mediaClip.transform.opacity * fadeFactor(mediaClip, t),
    // A hidden track still plays its sound, as in the export.
    visibility: track.hidden ? 'hidden' : undefined,
    transform: mediaClip.transform.rotation ? `rotate(${mediaClip.transform.rotation}deg)` : undefined,
  };
  const inner: CSSProperties = { left: box.inner.left, top: box.inner.top, width: box.inner.width, height: box.inner.height };
  return (
    <div className="player-layer" style={style}>
      {asset.kind === 'image' ? <img src={url ?? undefined} alt="" style={inner} draggable={false} /> : <video ref={ref} src={url ?? undefined} style={inner} preload="auto" playsInline disablePictureInPicture />}
    </div>
  );
}

/** Titles and motion graphics, laid out like the exporter draws them (panel, text, second line). */
function TextLayer({ clip, seq, t }: { clip: TextClip; seq: Sequence; t: number }) {
  const s = clip.style;
  const W = seq.settings.width;
  const H = seq.settings.height;
  const shift = s.align === 'left' ? '0' : s.align === 'right' ? '-100%' : '-50%';
  const template = clip.template ?? 'plain';
  const family = s.fontAssetId ? `"mvfont-${s.fontAssetId}", 'MV Inter', sans-serif` : undefined;
  const opacity = fadeFactor(clip, t);
  const size = s.fontSize;
  let panel: CSSProperties | null = null;
  if (template !== 'plain') {
    const full = template !== 'lower-third';
    const lines = clip.subtitle ? 2.7 : 1.7;
    const pw = full ? W : Math.min(W * 0.9, Math.max(W * 0.42, size * 0.62 * Math.max(clip.text.length, (clip.subtitle?.length ?? 0) * 0.55) + size * 1.2));
    panel = full ? { left: 0, top: 0, width: W, height: H, background: s.panelColor ?? '#111014', opacity } : { left: s.x * W - size * 0.6, top: s.y * H - size * 0.95, width: pw, height: size * lines, background: s.panelColor ?? '#111014', opacity: opacity * 0.88 };
  }
  const sub = Math.max(8, Math.round(size * (template === 'lower-third' ? 0.56 : 0.42)));
  return (
    <>
      {panel && <div className="player-panel" style={panel} />}
      <div
        className="player-text"
        style={{
          left: s.x * W,
          top: s.y * H,
          transform: `translate(${shift}, -50%)`,
          fontSize: size,
          fontFamily: family,
          color: s.color,
          fontWeight: s.weight === 'semibold' ? 600 : 400,
          textAlign: s.align,
          opacity,
          background: s.box ? `${s.boxColor}99` : undefined,
          padding: s.box ? `${Math.round(size * 0.35)}px` : undefined,
        }}
      >
        {clip.text}
      </div>
      {template !== 'plain' && clip.subtitle && (
        <div className="player-text" style={{ left: s.x * W, top: s.y * H + size * 0.62, transform: `translate(${shift}, 0)`, fontSize: sub, fontFamily: family, color: s.color, opacity: opacity * 0.85, textAlign: s.align }}>
          {clip.subtitle}
        </div>
      )}
    </>
  );
}

export function Player() {
  const seq = useVideo((s) => s.sequence)!;
  const mediaList = useVideo((s) => s.media);
  const t = useVideo((s) => s.playhead);
  const playing = useVideo((s) => s.playing);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const media = new Map(mediaList.map((m) => [m.id, m]));
  useLibraryFonts(mediaList);
  const duration = sequenceDuration(seq);
  const fps = fpsValue(seq.settings.fps);
  const frame = frameTicks(seq.settings.fps);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Master clock.
  useEffect(() => {
    if (!playing) return;
    const start = performance.now();
    const from = getVideo().playhead >= duration ? 0 : getVideo().playhead;
    let raf = 0;
    const tick = (): void => {
      const now = from + ((performance.now() - start) / 1000) * TICKS_PER_SECOND;
      if (now >= duration) {
        setPlayhead(duration);
        setPlaying(false);
        return;
      }
      setPlayhead(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  const scale = size.w > 0 ? Math.min(size.w / seq.settings.width, size.h / seq.settings.height) : 0;
  const texts = seq.tracks
    .filter((tr) => tr.kind === 'text' && !tr.hidden)
    .flatMap((tr) => tr.clips.filter((c): c is TextClip => c.type === 'text' && t >= c.start && t < clipEnd(c)));

  return (
    <section className="player" aria-label="Viewer">
      <div ref={wrapRef} className="player-stage-wrap">
        {scale > 0 && (
          <div className="player-stage" style={{ width: seq.settings.width, height: seq.settings.height, transform: `scale(${scale})`, background: seq.settings.background, left: (size.w - seq.settings.width * scale) / 2, top: (size.h - seq.settings.height * scale) / 2 }}>
            {seq.tracks
              .filter((tr) => tr.kind === 'video')
              .map((tr) => (
                <MediaLayer key={tr.id} track={tr} seq={seq} media={media} t={t} playing={playing} />
              ))}
            {seq.tracks
              .filter((tr) => tr.kind === 'audio')
              .map((tr) => (
                <MediaLayer key={tr.id} track={tr} seq={seq} media={media} t={t} playing={playing} />
              ))}
            {texts.map((c) => (
              <TextLayer key={c.id} clip={c} seq={seq} t={t} />
            ))}
          </div>
        )}
      </div>
      <div className="player-controls">
        <IconButton icon="chevronLeft" size="sm" label="Back one frame (Left arrow)" onClick={() => setPlayhead(t - frame)} />
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => setPlaying(!playing)} />
        <IconButton icon="chevronRight" size="sm" label="Forward one frame (Right arrow)" onClick={() => setPlayhead(t + frame)} />
        <span className="player-time" aria-live="off">
          {fmtTime(t, fps)} <span className="muted">/ {fmtTime(duration, fps)}</span>
        </span>
        <span className="bar-spacer" />
        <span className="muted small">
          {seq.settings.width}×{seq.settings.height} · {Math.round(fps * 100) / 100} fps
        </span>
      </div>
    </section>
  );
}
