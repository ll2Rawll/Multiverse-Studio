/**
 * Turns a sequence into an ffmpeg invocation: structured arguments plus a filtergraph script.
 * Pure (no I/O), so it is unit-tested directly.
 *
 * Model:
 * - Media clips are fitted inside the output frame (contain), then moved, scaled, rotated,
 *   cropped and faded as the clip says. Video tracks are layered bottom to top on the sequence
 *   background colour.
 * - A crossfade into a clip that directly follows another uses handles: both clips extend by half
 *   the transition into the other's time (frozen frames fill in if the media runs out). A dip
 *   fades the outgoing clip to black and the incoming clip from black.
 * - Audio from every audible clip is placed at its time, faded and mixed without normalisation.
 * - Text uses drawtext with text files and a bundled font, both referenced by plain file names
 *   relative to the job folder, so no path or text ever needs filtergraph escaping.
 */
import {
  EXPORT_PRESETS,
  TICKS_PER_SECOND,
  clipEnd,
  fpsValue,
  sequenceDuration,
  type ExportSettings,
  type MediaClip,
  type MediaKind,
  type MediaProbe,
  type Sequence,
  type TextClip,
} from '../shared/video';

export interface RenderAsset {
  path: string;
  kind: MediaKind;
  probe: MediaProbe;
}

export interface RenderPlan {
  args: string[];
  filter: string;
  /** Files to write into the job folder before running (text for titles). */
  files: { name: string; content: string }[];
  /** Fonts to copy into the job folder: name in the folder → a bundled face, or a library font's file. */
  fonts: { name: string; weight: 'regular' | 'semibold'; path?: string }[];
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  hasAudio: boolean;
}

export class RenderError extends Error {}

const sec = (t: number): number => t / TICKS_PER_SECOND;
const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
const even = (n: number): number => Math.max(2, 2 * Math.round(n / 2));
const ffColor = (hex: string, alpha = 1): string => `0x${hex.replace('#', '')}${alpha < 1 ? `@${num(alpha)}` : ''}`;

export function outputSize(seq: Sequence, s: ExportSettings): { width: number; height: number } {
  const preset = EXPORT_PRESETS[s.preset];
  let width: number = s.preset === 'sequence' ? seq.settings.width : preset.width;
  let height: number = s.preset === 'sequence' ? seq.settings.height : preset.height;
  if (s.resolution) {
    const f = s.resolution / Math.min(width, height);
    width *= f;
    height *= f;
  }
  return { width: even(width), height: even(height) };
}

/** atempo accepts 0.5..2 per stage, so speeds outside that are chained. */
function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${num(s)}`);
  return out;
}

interface Window {
  clip: MediaClip;
  asset: RenderAsset;
  /** Timeline seconds where rendering starts/ends (including transition handles). */
  start: number;
  end: number;
  /** Source seconds to read and frozen padding where the media runs out. */
  srcStart: number;
  srcEnd: number;
  padStart: number;
  padEnd: number;
  alphaIn: number;
  alphaOut: number;
  blackIn: number;
  blackOut: number;
  audioIn: number;
  audioOut: number;
}

function windowsFor(seq: Sequence, assets: Map<string, RenderAsset>): { video: Window[][]; audio: Window[] } {
  const video: Window[][] = [];
  const audio: Window[] = [];
  for (const track of seq.tracks) {
    if (track.kind === 'text') continue;
    const clips = track.clips.filter((c): c is MediaClip => c.type === 'media').sort((a, b) => a.start - b.start);
    const wins: Window[] = [];
    for (const clip of clips) {
      const asset = assets.get(clip.assetId);
      if (!asset) throw new RenderError(`A clip uses media that is missing from the library (${clip.assetId}). Relink it in Assets, then export again.`);
      const len = sec(clipEnd(clip) - clip.start);
      wins.push({
        clip,
        asset,
        start: sec(clip.start),
        end: sec(clipEnd(clip)),
        srcStart: sec(clip.in),
        srcEnd: sec(clip.out),
        padStart: 0,
        padEnd: 0,
        alphaIn: Math.min(sec(clip.fadeIn), len),
        alphaOut: Math.min(sec(clip.fadeOut), len),
        blackIn: 0,
        blackOut: 0,
        audioIn: Math.min(sec(clip.fadeIn), len),
        audioOut: Math.min(sec(clip.fadeOut), len),
      });
    }
    // Transitions between directly adjacent clips (within half a frame).
    const halfFrame = 0.5 / fpsValue(seq.settings.fps);
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i]!;
      const t = w.clip.transitionIn;
      if (!t || t.duration <= 0) continue;
      const d = sec(t.duration);
      const prev = i > 0 ? wins[i - 1]! : null;
      const adjacent = prev !== null && Math.abs(prev.end - w.start) <= halfFrame;
      if (!adjacent) {
        // Nothing to transition from: fade in from what is below (or from black for a dip).
        if (t.kind === 'crossfade') w.alphaIn = Math.max(w.alphaIn, d);
        else w.blackIn = Math.max(w.blackIn, d);
        w.audioIn = Math.max(w.audioIn, d);
        continue;
      }
      const h = d / 2;
      if (t.kind === 'crossfade') {
        w.start -= h;
        w.srcStart -= h * w.clip.speed;
        prev.end += h;
        prev.srcEnd += h * prev.clip.speed;
        w.alphaIn = Math.max(w.alphaIn, d);
        w.audioIn = Math.max(w.audioIn, d);
        prev.audioOut = Math.max(prev.audioOut, d);
      } else {
        w.blackIn = Math.max(w.blackIn, h);
        prev.blackOut = Math.max(prev.blackOut, h);
        w.audioIn = Math.max(w.audioIn, h);
        prev.audioOut = Math.max(prev.audioOut, h);
      }
    }
    // Clamp source reads to the media and freeze frames for the rest.
    for (const w of wins) {
      if (w.srcStart < 0) {
        w.padStart = -w.srcStart / w.clip.speed;
        w.srcStart = 0;
      }
      const dur = w.asset.kind === 'image' ? null : w.asset.probe.durationSeconds;
      if (dur !== null && w.srcEnd > dur) {
        w.padEnd = (w.srcEnd - dur) / w.clip.speed;
        w.srcEnd = dur;
      }
      if (w.srcEnd <= w.srcStart) throw new RenderError('A clip points past the end of its media. Trim it in the timeline, then export again.');
    }
    if (track.kind === 'video' && !track.hidden) video.push(wins.filter((w) => w.asset.kind !== 'audio'));
    if (!track.muted) {
      for (const w of wins) {
        const hasAudio = w.asset.kind !== 'image' && w.asset.probe.hasAudio;
        if (hasAudio && !w.clip.muted && w.clip.volume * track.volume > 0) {
          (w as Window & { gain: number }).gain = w.clip.volume * track.volume;
          audio.push(w);
        }
      }
    }
  }
  return { video, audio };
}

function textExpr(clip: TextClip, width: number, height: number, scaleY: number): { x: string; y: string; size: number } {
  const size = Math.max(8, Math.round(clip.style.fontSize * scaleY));
  const ax = Math.round(clip.style.x * width);
  const ay = Math.round(clip.style.y * height);
  const x = clip.style.align === 'left' ? `${ax}` : clip.style.align === 'right' ? `${ax}-text_w` : `${ax}-text_w/2`;
  return { x, y: `${ay}-text_h/2`, size };
}

export function buildRenderPlan(seq: Sequence, assets: Map<string, RenderAsset>, settings: ExportSettings, output: string): RenderPlan {
  const total = sec(sequenceDuration(seq));
  if (total <= 0) throw new RenderError('The timeline is empty. Add a clip before exporting.');
  const { width: W, height: H } = outputSize(seq, settings);
  const fps = settings.fps === 'sequence' ? fpsValue(seq.settings.fps) : settings.fps;
  const scaleX = W / seq.settings.width;
  const scaleY = H / seq.settings.height;
  const offsetScale = Math.min(scaleX, scaleY);
  const { video, audio } = windowsFor(seq, assets);

  const args: string[] = ['-hide_banner', '-nostdin', '-y'];
  const graph: string[] = [];
  const inputIndex = new Map<Window, number>();
  let inputs = 0;
  const addInput = (w: Window): number => {
    const existing = inputIndex.get(w);
    if (existing !== undefined) return existing;
    if (w.asset.kind === 'image') {
      args.push('-loop', '1', '-framerate', num(fps), '-t', num(w.end - w.start + 1), '-i', w.asset.path);
    } else {
      args.push('-ss', num(w.srcStart), '-t', num(w.srcEnd - w.srcStart), '-i', w.asset.path);
    }
    inputIndex.set(w, inputs);
    return inputs++;
  };

  graph.push(`color=c=${ffColor(seq.settings.background)}:s=${W}x${H}:r=${num(fps)}:d=${num(total)},format=yuv420p[base]`);
  let last = 'base';
  let n = 0;
  for (const wins of video) {
    for (const w of wins) {
      const i = addInput(w);
      const p = w.asset.probe;
      const f: string[] = [];
      f.push(w.asset.kind === 'image' ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${num(w.clip.speed)}`);
      f.push(`fps=${num(fps)}`);
      if (w.padStart > 0 || w.padEnd > 0) f.push(`tpad=start_mode=clone:start_duration=${num(w.padStart)}:stop_mode=clone:stop_duration=${num(w.padEnd)}`);
      if (w.asset.kind === 'image') f.push(`trim=duration=${num(w.end - w.start)}`);
      // Source size after rotation metadata and crop.
      let sw = p.width ?? W;
      let sh = p.height ?? H;
      if (Math.abs(p.rotation) % 180 === 90) [sw, sh] = [sh, sw];
      const c = w.clip.crop;
      if (c.left || c.right || c.top || c.bottom) {
        f.push(`crop=w=iw*${num(1 - c.left - c.right)}:h=ih*${num(1 - c.top - c.bottom)}:x=iw*${num(c.left)}:y=ih*${num(c.top)}`);
        sw *= 1 - c.left - c.right;
        sh *= 1 - c.top - c.bottom;
      }
      const fit = Math.min(W / sw, H / sh) * w.clip.transform.scale;
      f.push(`scale=w=${even(sw * fit)}:h=${even(sh * fit)}`, 'setsar=1', 'format=rgba');
      const tr = w.clip.transform;
      if (tr.rotation) f.push(`rotate=a=${num((tr.rotation * Math.PI) / 180)}:ow=rotw(a):oh=roth(a):c=none`);
      const len = w.end - w.start;
      if (w.blackIn > 0) f.push(`fade=t=in:st=0:d=${num(w.blackIn)}`);
      if (w.blackOut > 0) f.push(`fade=t=out:st=${num(len - w.blackOut)}:d=${num(w.blackOut)}`);
      if (tr.opacity < 1) f.push(`colorchannelmixer=aa=${num(tr.opacity)}`);
      if (w.alphaIn > 0) f.push(`fade=t=in:st=0:d=${num(w.alphaIn)}:alpha=1`);
      if (w.alphaOut > 0) f.push(`fade=t=out:st=${num(len - w.alphaOut)}:d=${num(w.alphaOut)}:alpha=1`);
      f.push(`setpts=PTS-STARTPTS+${num(w.start)}/TB`);
      graph.push(`[${i}:v]${f.join(',')}[v${n}]`);
      const dx = Math.round(tr.x * offsetScale);
      const dy = Math.round(tr.y * offsetScale);
      graph.push(`[${last}][v${n}]overlay=x=(W-w)/2${dx >= 0 ? '+' : ''}${dx}:y=(H-h)/2${dy >= 0 ? '+' : ''}${dy}:eof_action=pass:enable='between(t,${num(w.start)},${num(w.end)})'[o${n}]`);
      last = `o${n}`;
      n++;
    }
  }

  const files: { name: string; content: string }[] = [];
  const fonts = new Map<string, { weight: 'regular' | 'semibold'; path?: string }>();
  let k = 0;
  const drawText = (text: string, weight: 'regular' | 'semibold', size: number, color: string, x: string, y: string, a: number, b: number, fi: number, fo: number, extra = '', fontAssetId?: string | null): void => {
    const name = `text-${files.length}.txt`;
    files.push({ name, content: text });
    // A library font is used when it exists and FreeType reads it (WOFF2 needs Brotli, so it falls back).
    const lib = fontAssetId ? assets.get(fontAssetId) : undefined;
    const libExt = lib ? lib.path.split('.').pop()!.toLowerCase() : '';
    const useLib = lib && lib.kind === 'font' && ['ttf', 'otf', 'woff'].includes(libExt);
    const font = useLib ? `lib-${fontAssetId!.replace(/[^A-Za-z0-9-]/g, '')}.${libExt}` : weight === 'semibold' ? 'font-semibold.otf' : 'font-regular.otf';
    fonts.set(font, useLib ? { weight, path: lib.path } : { weight });
    const alpha = fi > 0 || fo > 0 ? `:alpha='if(lt(t,${num(a + fi)}),(t-${num(a)})/${num(Math.max(fi, 1e-3))},if(gt(t,${num(b - fo)}),(${num(b)}-t)/${num(Math.max(fo, 1e-3))},1))'` : '';
    graph.push(`[${last}]drawtext=fontfile=${font}:textfile=${name}:expansion=none:fontsize=${size}:fontcolor=${color}:line_spacing=${Math.round(size * 0.15)}:x=${x}:y=${y}${extra}${alpha}:enable='between(t,${num(a)},${num(b)})'[x${k}]`);
    last = `x${k}`;
    k++;
  };
  for (const track of seq.tracks) {
    if (track.kind !== 'text' || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type !== 'text' || !clip.text.trim()) continue;
      const a = sec(clip.start);
      const b = sec(clipEnd(clip));
      const fi = sec(clip.fadeIn);
      const fo = sec(clip.fadeOut);
      const { x, y, size } = textExpr(clip, W, H, scaleY);
      const template = clip.template ?? 'plain';
      if (template !== 'plain') {
        // The panel is a generated colour layer, faded like the text and overlaid for the clip's time.
        const panel = clip.style.panelColor ?? '#111014';
        const full = template !== 'lower-third';
        const lines = clip.subtitle ? 2.7 : 1.7;
        const pw = full ? W : even(Math.min(W * 0.9, Math.max(W * 0.42, size * 0.62 * Math.max(clip.text.length, (clip.subtitle?.length ?? 0) * 0.55) + size * 1.2)));
        const ph = full ? H : even(size * lines);
        const px = full ? 0 : Math.round(clip.style.x * W - size * 0.6);
        const py = full ? 0 : Math.round(clip.style.y * H - size * 0.95);
        const pf: string[] = [`color=c=${ffColor(panel)}:s=${pw}x${ph}:r=${num(fps)}:d=${num(b - a)}`, 'format=rgba'];
        if (!full) pf.push('colorchannelmixer=aa=0.88');
        if (fi > 0) pf.push(`fade=t=in:st=0:d=${num(fi)}:alpha=1`);
        if (fo > 0) pf.push(`fade=t=out:st=${num(b - a - fo)}:d=${num(fo)}:alpha=1`);
        pf.push(`setpts=PTS-STARTPTS+${num(a)}/TB`);
        graph.push(`${pf.join(',')}[p${k}]`);
        graph.push(`[${last}][p${k}]overlay=x=${px}:y=${py}:eof_action=pass:enable='between(t,${num(a)},${num(b)})'[q${k}]`);
        last = `q${k}`;
      }
      const box = clip.style.box ? `:box=1:boxcolor=${ffColor(clip.style.boxColor, 0.6)}:boxborderw=${Math.round(size * 0.35)}` : '';
      drawText(clip.text, clip.style.weight, size, ffColor(clip.style.color), x, y, a, b, fi, fo, box, clip.style.fontAssetId);
      if (clip.subtitle?.trim() && template !== 'plain') {
        const sub = Math.max(8, Math.round(size * (template === 'lower-third' ? 0.56 : 0.42)));
        const sy = Math.round(clip.style.y * H + size * 0.62);
        const sx = clip.style.align === 'left' ? x : clip.style.align === 'right' ? `${Math.round(clip.style.x * W)}-text_w` : `${Math.round(clip.style.x * W)}-text_w/2`;
        drawText(clip.subtitle, 'regular', sub, ffColor(clip.style.color, 0.85), sx, `${sy}`, a, b, fi, fo, '', clip.style.fontAssetId);
      }
    }
  }
  graph.push(`[${last}]format=yuv420p[vout]`);

  const mix: string[] = [];
  audio.forEach((w, j) => {
    const i = addInput(w);
    const len = w.end - w.start;
    const f = ['asetpts=PTS-STARTPTS', ...atempoChain(w.clip.speed), `aresample=${seq.settings.sampleRate}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
    if (w.padStart > 0) f.push(`adelay=delays=${Math.round(w.padStart * 1000)}:all=1`);
    f.push(`apad=whole_dur=${num(len)}`, `atrim=0:${num(len)}`);
    f.push(`volume=${num((w as Window & { gain: number }).gain)}`);
    if (w.audioIn > 0) f.push(`afade=t=in:st=0:d=${num(w.audioIn)}`);
    if (w.audioOut > 0) f.push(`afade=t=out:st=${num(len - w.audioOut)}:d=${num(w.audioOut)}`);
    f.push(`adelay=delays=${Math.round(w.start * 1000)}:all=1`);
    graph.push(`[${i}:a]${f.join(',')}[a${j}]`);
    mix.push(`[a${j}]`);
  });
  if (mix.length > 1) graph.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:dropout_transition=0,apad=whole_dur=${num(total)},atrim=0:${num(total)}[aout]`);
  else if (mix.length === 1) graph.push(`${mix[0]}apad=whole_dur=${num(total)},atrim=0:${num(total)}[aout]`);
  else graph.push(`anullsrc=r=${seq.settings.sampleRate}:cl=stereo,atrim=0:${num(total)}[aout]`);

  args.push('-filter_complex_script', 'graph.txt', '-map', '[vout]', '-map', '[aout]');
  if (settings.range) {
    const from = sec(settings.range.start);
    const to = Math.min(total, sec(settings.range.end));
    if (to <= from) throw new RenderError('The export range is empty.');
    args.push('-ss', num(from), '-t', num(to - from));
  } else {
    args.push('-t', num(total));
  }
  args.push('-r', num(fps));
  const crf = { high: [18, 30], standard: [21, 33], small: [26, 38] }[settings.quality];
  if (settings.format === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf[0]), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  } else {
    args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf[1]), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k');
  }
  args.push('-progress', 'pipe:1', '-nostats', output);

  const duration = settings.range ? Math.min(total, sec(settings.range.end)) - sec(settings.range.start) : total;
  return { args, filter: `${graph.join(';\n')}\n`, files, fonts: [...fonts].map(([name, f]) => ({ name, ...f })), width: W, height: H, fps, durationSeconds: duration, hasAudio: mix.length > 0 };
}
