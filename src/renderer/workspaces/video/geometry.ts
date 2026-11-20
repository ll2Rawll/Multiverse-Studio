/** Shared timeline maths for the player, timeline and inspector. Mirrors src/video/render.ts. */
import { TICKS_PER_SECOND, clipDuration, clipEnd, type Clip, type MediaAssetView, type MediaClip, type Sequence, type Track } from '../../../shared/video';

export const activeClip = (track: Track, t: number): Clip | null => track.clips.find((c) => t >= c.start && t < clipEnd(c)) ?? null;

/** Source time (seconds) shown by a media clip at timeline time t. */
export const sourceSeconds = (clip: MediaClip, t: number): number => (clip.in + (t - clip.start) * clip.speed) / TICKS_PER_SECOND;

/** Opacity/volume multiplier from the clip's fades (and a crossfade or dip into it). */
export function fadeFactor(clip: Clip, t: number): number {
  const len = clipDuration(clip);
  const into = t - clip.start;
  const left = clipEnd(clip) - t;
  const fin = Math.max(clip.fadeIn, clip.transitionIn ? (clip.transitionIn.kind === 'dip' ? clip.transitionIn.duration / 2 : clip.transitionIn.duration) : 0);
  let f = 1;
  if (fin > 0 && into < fin) f = Math.min(f, into / fin);
  if (clip.fadeOut > 0 && left < clip.fadeOut) f = Math.min(f, left / clip.fadeOut);
  return Math.max(0, Math.min(1, len > 0 ? f : 1));
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The full (uncropped) source, positioned inside the box. */
  inner: { left: number; top: number; width: number; height: number };
}

/** Where a media clip sits in the frame, in sequence pixels: contain-fit, then crop, scale and offset. */
export function clipBox(clip: MediaClip, asset: MediaAssetView | undefined, seq: Sequence): Box {
  const W = seq.settings.width;
  const H = seq.settings.height;
  let sw = asset?.probe.width ?? W;
  let sh = asset?.probe.height ?? H;
  if (asset && Math.abs(asset.probe.rotation) % 180 === 90) [sw, sh] = [sh, sw];
  const c = clip.crop;
  const cw = sw * (1 - c.left - c.right);
  const ch = sh * (1 - c.top - c.bottom);
  const fit = Math.min(W / cw, H / ch) * clip.transform.scale;
  const width = cw * fit;
  const height = ch * fit;
  return {
    left: W / 2 + clip.transform.x - width / 2,
    top: H / 2 + clip.transform.y - height / 2,
    width,
    height,
    inner: { left: -c.left * sw * fit, top: -c.top * sh * fit, width: sw * fit, height: sh * fit },
  };
}

export const ticksToPx = (t: number, zoom: number): number => (t / TICKS_PER_SECOND) * zoom;
export const pxToTicks = (px: number, zoom: number): number => Math.round((px / zoom) * TICKS_PER_SECOND);
