import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useVideo, runVideo, setVideo } from '../../state/video';
import { useMedia, loadBrand, ACTIVE_JOB } from '../../state/media';
import { useStudio } from '../../state/store';
import { setWorkspace } from '../../state/actions';
import { useSelectionRefs } from '../../state/selection';
import { TranscribeDialog } from '../media/TranscribeDialog';
import { brandTitleStyle } from '../../../shared/brand';
import { Button, IconButton, SegmentedControl, Toggle } from '../../components/primitives';
import { Icon } from '../../components/Icon';
import { TICKS_PER_SECOND, TEXT_TEMPLATES, TEXT_TEMPLATE_LABELS, clipDuration, type Clip, type MediaAssetView, type MediaClip, type Sequence, type TextClip, type TextTemplate, type Track } from '../../../shared/video';

const sec = (t: number): string => (t / TICKS_PER_SECOND).toFixed(2);

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
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

/** A number box that commits on Enter or blur, in display units. */
function NumberInput({ value, onCommit, min, max, label, suffix }: { value: number; onCommit: (v: number) => void; min: number; max: number; label: string; suffix?: string }) {
  const [draft, setDraft] = useState(String(value));
  const sent = useRef<number | null>(null);
  useEffect(() => {
    setDraft(String(value));
    sent.current = null;
  }, [value]);
  const commit = (): void => {
    const n = Number(draft);
    if (!Number.isFinite(n)) return setDraft(String(value));
    const clamped = Math.max(min, Math.min(max, n));
    if (clamped !== value && clamped !== sent.current) {
      sent.current = clamped;
      onCommit(clamped);
    } else if (clamped === value) setDraft(String(value));
  };
  return (
    <>
      <input className="input prop-input num-input" inputMode="decimal" aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => (e.key === 'Enter' ? commit() : e.key === 'Escape' ? setDraft(String(value)) : undefined)} />
      {suffix && <span className="prop-suffix">{suffix}</span>}
    </>
  );
}

/** A slider that commits once, when released, so dragging makes one undo step. */
function Slider({ value, onCommit, min, max, step, label, format }: { value: number; onCommit: (v: number) => void; min: number; max: number; step: number; label: string; format: (v: number) => string }) {
  const [live, setLive] = useState<number | null>(null);
  const v = live ?? value;
  const commit = (): void => {
    if (live !== null && live !== value) onCommit(live);
    setLive(null);
  };
  return (
    <>
      <input type="range" className="prop-range" aria-label={label} min={min} max={max} step={step} value={v} onChange={(e) => setLive(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <span className="prop-value">{format(v)}</span>
    </>
  );
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function MediaPanel({ clip, asset }: { clip: MediaClip; asset: MediaAssetView | undefined }) {
  const set = (patch: Record<string, unknown>): void => void runVideo('video.setClip', { clipId: clip.id, patch });
  const t = clip.transform;
  const c = clip.crop;
  const isAudio = asset?.kind === 'audio';
  const hasAudio = asset ? asset.kind !== 'image' && asset.probe.hasAudio : false;
  return (
    <>
      <section className="prop-group">
        <h3 className="panel-subhead">Timing</h3>
        <p className="muted small">
          Starts at {sec(clip.start)} s · {sec(clipDuration(clip))} s on the timeline · uses {sec(clip.in)}–{sec(clip.out)} s of the source
        </p>
        {asset?.kind !== 'image' && (
          <Field label="Speed">
            <select className="input prop-input" value={clip.speed} aria-label="Speed" onChange={(e) => set({ speed: Number(e.target.value) })}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Fade in">
          <NumberInput label="Fade in seconds" value={Number(sec(clip.fadeIn))} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeIn: Math.round(v * TICKS_PER_SECOND) })} />
        </Field>
        <Field label="Fade out">
          <NumberInput label="Fade out seconds" value={Number(sec(clip.fadeOut))} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeOut: Math.round(v * TICKS_PER_SECOND) })} />
        </Field>
        <Field label="Transition in" hint="from the clip before">
          <select className="input prop-input" aria-label="Transition in" value={clip.transitionIn?.kind ?? ''} onChange={(e) => set({ transitionIn: e.target.value ? { kind: e.target.value, duration: clip.transitionIn?.duration ?? TICKS_PER_SECOND / 2 } : null })}>
            <option value="">Cut</option>
            <option value="crossfade">Crossfade</option>
            <option value="dip">Dip to black</option>
          </select>
        </Field>
        {clip.transitionIn && (
          <Field label="Length">
            <NumberInput label="Transition seconds" value={Number(sec(clip.transitionIn.duration))} min={0.04} max={10} suffix="s" onCommit={(v) => set({ transitionIn: { ...clip.transitionIn!, duration: Math.round(v * TICKS_PER_SECOND) } })} />
          </Field>
        )}
      </section>

      {hasAudio && asset && <TranscriptSection asset={asset} />}

      {hasAudio && (
        <section className="prop-group">
          <h3 className="panel-subhead">Sound</h3>
          <Field label="Volume">
            <Slider label="Volume" value={Math.round(clip.volume * 100)} min={0} max={200} step={1} format={(v) => `${v}%`} onCommit={(v) => set({ volume: v / 100 })} />
          </Field>
          <Toggle label="Mute this clip" checked={clip.muted} onChange={(v) => set({ muted: v })} />
        </section>
      )}

      {!isAudio && (
        <section className="prop-group">
          <div className="prop-group-head">
            <h3 className="panel-subhead">Position</h3>
            <Button size="sm" variant="quiet" icon="restore" onClick={() => set({ transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, crop: { left: 0, right: 0, top: 0, bottom: 0 } })}>
              Reset
            </Button>
          </div>
          <Field label="X">
            <NumberInput label="Horizontal offset" value={Math.round(t.x)} min={-20000} max={20000} suffix="px" onCommit={(v) => set({ transform: { x: v } })} />
          </Field>
          <Field label="Y">
            <NumberInput label="Vertical offset" value={Math.round(t.y)} min={-20000} max={20000} suffix="px" onCommit={(v) => set({ transform: { y: v } })} />
          </Field>
          <Field label="Scale">
            <Slider label="Scale" value={Math.round(t.scale * 100)} min={5} max={400} step={1} format={(v) => `${v}%`} onCommit={(v) => set({ transform: { scale: v / 100 } })} />
          </Field>
          <Field label="Rotation">
            <Slider label="Rotation" value={Math.round(t.rotation)} min={-180} max={180} step={1} format={(v) => `${v}°`} onCommit={(v) => set({ transform: { rotation: v } })} />
          </Field>
          <Field label="Opacity">
            <Slider label="Opacity" value={Math.round(t.opacity * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onCommit={(v) => set({ transform: { opacity: v / 100 } })} />
          </Field>
          <h3 className="panel-subhead">Crop</h3>
          {(['left', 'right', 'top', 'bottom'] as const).map((edge) => (
            <Field key={edge} label={edge[0]!.toUpperCase() + edge.slice(1)}>
              <Slider label={`Crop ${edge}`} value={Math.round(c[edge] * 100)} min={0} max={45} step={1} format={(v) => `${v}%`} onCommit={(v) => set({ crop: { [edge]: v / 100 } })} />
            </Field>
          ))}
        </section>
      )}
    </>
  );
}

function TranscriptSection({ asset }: { asset: MediaAssetView }) {
  const [open, setOpen] = useState(false);
  const running = useMedia((s) => s.jobs.some((j) => j.kind === 'transcription' && j.sourceAssetId === asset.id && ACTIVE_JOB.has(j.state)));
  return (
    <section className="prop-group">
      <h3 className="panel-subhead">Transcript</h3>
      <p className="muted small">{running ? 'Transcribing…' : asset.hasTranscript ? 'Saved with this media. Use it for captions or to lower music during speech.' : 'Not transcribed yet. Only a small audio extract is sent, after you review it.'}</p>
      <div className="job-actions">
        <Button size="sm" icon="text" disabled={running} onClick={() => setOpen(true)}>
          {asset.hasTranscript ? 'Transcribe again…' : 'Transcribe…'}
        </Button>
        {asset.hasTranscript && (
          <Button size="sm" variant="quiet" icon="wand" onClick={() => setVideo({ aiDialog: true })}>
            Captions…
          </Button>
        )}
      </div>
      {open && <TranscribeDialog asset={asset} onClose={() => setOpen(false)} />}
    </section>
  );
}

function TextPanel({ clip }: { clip: TextClip }) {
  const set = (patch: Record<string, unknown>): void => void runVideo('video.setClip', { clipId: clip.id, patch });
  const s = clip.style;
  const projectId = useStudio((st) => st.project!.id);
  const brand = useMedia((st) => st.brand);
  const media = useVideo((st) => st.media);
  const frameH = useVideo((st) => st.sequence?.settings.height ?? 1080);
  const fonts = media.filter((m) => m.kind === 'font' && m.status === 'ready');
  useEffect(() => {
    if (!brand) void loadBrand(projectId);
  }, [brand, projectId]);
  const [subtitle, setSubtitle] = useState(clip.subtitle ?? '');
  useEffect(() => setSubtitle(clip.subtitle ?? ''), [clip.subtitle]);
  const template: TextTemplate = clip.template ?? 'plain';
  const [text, setText] = useState(clip.text);
  const sent = useRef<string | null>(null);
  useEffect(() => {
    setText(clip.text);
    sent.current = null;
  }, [clip.text]);
  const apply = (): void => {
    if (text.trim() && text !== clip.text && text !== sent.current) {
      sent.current = text;
      set({ text });
    }
  };
  return (
    <>
      {clip.object && (
        <section className="prop-group component-note">
          <p className="muted small">This scene shows the living object “{clip.object.id}”. Its text comes from the object; timing, layout, style and fades are this scene’s own. Editing the text here marks it as edited by hand.</p>
          <Button
            size="sm"
            variant="quiet"
            icon="layers"
            onClick={() => {
              useSelectionRefs.setState({ openObject: clip.object!.id });
              setWorkspace('assets');
            }}
          >
            Edit object · where is it used?
          </Button>
        </section>
      )}
      <section className="prop-group">
        <h3 className="panel-subhead">Text</h3>
        <textarea className="input textarea prop-input" aria-label="Title text" rows={3} value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && apply()} />
        <span className="muted small">Ctrl+Enter to apply.</span>
      </section>
      <section className="prop-group">
        <h3 className="panel-subhead">Layout</h3>
        <Field label="Kind">
          <select className="input prop-input" aria-label="Title layout" value={template} onChange={(e) => set({ template: e.target.value })}>
            {TEXT_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {TEXT_TEMPLATE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        {template !== 'plain' && (
          <>
            <Field label="Second line">
              <input className="input prop-input" aria-label="Second line" value={subtitle} maxLength={300} onChange={(e) => setSubtitle(e.target.value)} onBlur={() => subtitle !== (clip.subtitle ?? '') && set({ subtitle })} onKeyDown={(e) => e.key === 'Enter' && subtitle !== (clip.subtitle ?? '') && set({ subtitle })} />
            </Field>
            <Field label="Panel">
              <input type="color" className="prop-swatch" aria-label="Panel colour" value={s.panelColor ?? '#111014'} onChange={(e) => set({ style: { panelColor: e.target.value } })} />
              <span className="prop-value">{s.panelColor ?? '#111014'}</span>
            </Field>
          </>
        )}
        <Field label="Brand style" hint={clip.brandStyleId ? 'follows brand updates' : undefined}>
          <select
            className="input prop-input"
            aria-label="Brand style"
            value={clip.brandStyleId ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              const style = id && brand ? brandTitleStyle(brand, id, frameH) : null;
              set({ brandStyleId: id, ...(style ? { style } : {}) });
            }}
          >
            <option value="">None</option>
            {(brand?.textStyles ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      </section>
      <section className="prop-group">
        <h3 className="panel-subhead">Style</h3>
        <Field label="Font">
          <select className="input prop-input" aria-label="Font" value={s.fontAssetId ?? ''} onChange={(e) => set({ style: { fontAssetId: e.target.value || null } })}>
            <option value="">Inter (built in)</option>
            {fonts.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.name.toLowerCase().endsWith('.woff2') ? ' (preview only; export uses Inter)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Size">
          <NumberInput label="Font size" value={s.fontSize} min={8} max={600} suffix="px" onCommit={(v) => set({ style: { fontSize: v } })} />
        </Field>
        <Field label="Colour">
          <input type="color" className="prop-swatch" aria-label="Text colour" value={s.color} onChange={(e) => set({ style: { color: e.target.value } })} />
          <span className="prop-value">{s.color}</span>
        </Field>
        <Field label="Weight">
          <SegmentedControl size="sm" label="Weight" options={[{ value: 'regular', label: 'Regular' }, { value: 'semibold', label: 'Semibold' }]} value={s.weight} onChange={(v) => set({ style: { weight: v } })} />
        </Field>
        <Field label="Align">
          <SegmentedControl size="sm" label="Alignment" options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} value={s.align} onChange={(v) => set({ style: { align: v } })} />
        </Field>
        <Field label="Across">
          <Slider label="Horizontal position" value={Math.round(s.x * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onCommit={(v) => set({ style: { x: v / 100 } })} />
        </Field>
        <Field label="Down">
          <Slider label="Vertical position" value={Math.round(s.y * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onCommit={(v) => set({ style: { y: v / 100 } })} />
        </Field>
        <Toggle label="Background box" checked={s.box} onChange={(v) => set({ style: { box: v } })} />
        <Field label="Fade in">
          <NumberInput label="Fade in seconds" value={Number(sec(clip.fadeIn))} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeIn: Math.round(v * TICKS_PER_SECOND) })} />
        </Field>
        <Field label="Fade out">
          <NumberInput label="Fade out seconds" value={Number(sec(clip.fadeOut))} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeOut: Math.round(v * TICKS_PER_SECOND) })} />
        </Field>
      </section>
    </>
  );
}

function SequencePanel({ seq }: { seq: Sequence }) {
  const set = (patch: Record<string, unknown>): void => void runVideo('video.setSequence', patch);
  return (
    <section className="prop-group">
      <h3 className="panel-subhead">Sequence</h3>
      <Field label="Name">
        <input className="input prop-input" aria-label="Sequence name" defaultValue={seq.name} key={seq.name} onBlur={(e) => e.target.value.trim() && e.target.value !== seq.name && set({ name: e.target.value.trim() })} />
      </Field>
      <Field label="Frame">
        <select
          className="input prop-input"
          aria-label="Frame size"
          value={`${seq.settings.width}x${seq.settings.height}`}
          onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number);
            set({ settings: { width: w, height: h } });
          }}
        >
          {[
            [1920, 1080, 'Landscape 1920×1080'],
            [1280, 720, 'Landscape 1280×720'],
            [1080, 1920, 'Portrait 1080×1920'],
            [1080, 1080, 'Square 1080×1080'],
            [3840, 2160, '4K 3840×2160'],
          ]
            .concat([[seq.settings.width, seq.settings.height, `${seq.settings.width}×${seq.settings.height}`]])
            .filter((o, i, all) => all.findIndex((x) => x[0] === o[0] && x[1] === o[1]) === i)
            .map(([w, h, l]) => (
              <option key={`${w}x${h}`} value={`${w}x${h}`}>
                {l}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Frame rate">
        <select className="input prop-input" aria-label="Frame rate" value={`${seq.settings.fps.num}/${seq.settings.fps.den}`} onChange={(e) => set({ settings: { fps: { num: Number(e.target.value.split('/')[0]), den: Number(e.target.value.split('/')[1]) } } })}>
          {['24000/1001', '24/1', '25/1', '30000/1001', '30/1', '50/1', '60/1'].map((f) => (
            <option key={f} value={f}>
              {(Number(f.split('/')[0]) / Number(f.split('/')[1])).toFixed(f.includes('1001') ? 3 : 0)} fps
            </option>
          ))}
        </select>
      </Field>
      <Field label="Background">
        <input type="color" className="prop-swatch" aria-label="Background colour" value={seq.settings.background} onChange={(e) => set({ settings: { background: e.target.value } })} />
      </Field>
      <p className="muted small">Select a clip on the timeline to edit it. Space plays, S splits, Delete removes, arrow keys step frames.</p>
    </section>
  );
}

export function ClipInspector() {
  const seq = useVideo((s) => s.sequence)!;
  const selection = useVideo((s) => s.selection);
  const media = useVideo((s) => s.media);
  let found: { clip: Clip; track: Track } | null = null;
  for (const track of seq.tracks) for (const clip of track.clips) if (clip.id === selection[0]) found = { clip, track };
  const asset = found?.clip.type === 'media' ? media.find((m) => m.id === (found!.clip as MediaClip).assetId) : undefined;
  return (
    <aside className="clip-inspector material-solid" aria-label="Clip settings">
      <div className="element-panel">
        {!found ? (
          <SequencePanel seq={seq} />
        ) : (
          <>
            <header className="element-head">
              <div>
                <h2>{found.clip.type === 'text' ? 'Title' : (asset?.name ?? 'Missing media')}</h2>
                <span className="muted small">
                  {found.track.name}
                  {selection.length > 1 ? ` · ${selection.length} clips selected (editing the first)` : ''}
                  {found.track.locked ? ' · locked' : ''}
                </span>
              </div>
              <IconButton icon="close" size="sm" label="Clear selection" onClick={() => useVideo.setState({ selection: [] })} />
            </header>
            {asset?.status === 'missing' && (
              <p className="info-banner">
                <Icon name="warning" size={14} /> This clip’s media is missing. Relink it in the media list.
              </p>
            )}
            {found.clip.type === 'media' ? <MediaPanel clip={found.clip} asset={asset} /> : <TextPanel clip={found.clip} />}
          </>
        )}
      </div>
    </aside>
  );
}
