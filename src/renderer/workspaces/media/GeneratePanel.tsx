/**
 * Generate images, video clips and voice-overs with the configured providers, and follow the jobs.
 * Every request is reviewed first (what is sent, where, and the cost — "Unknown" when the provider
 * publishes no price we can read). Results land in the project's asset library with provenance.
 */
import { useEffect, useState } from 'react';
import { useStudio, set as setStudio } from '../../state/store';
import { useVideo } from '../../state/video';
import { useMedia, loadMediaJobs, startJob, cancelJob, retryJob, ACTIVE_JOB, JOB_STATE_LABEL, KIND_LABEL, type JobInput } from '../../state/media';
import { Button, SegmentedControl } from '../../components/primitives';
import { Icon } from '../../components/Icon';
import { cx, relativeTime } from '../../lib/util';
import { JobReview, usePlan } from './JobReview';
import type { MediaJobView } from '../../../shared/media';

type Kind = 'image' | 'video' | 'speech';
const VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
const SHAPES: { value: string; label: string }[] = [
  { value: '1024x1024', label: 'Square' },
  { value: '1536x1024', label: 'Landscape' },
  { value: '1024x1536', label: 'Portrait' },
  { value: 'auto', label: 'Let the model choose' },
];

export function GeneratePanel({ compact }: { compact?: boolean }) {
  const projectId = useStudio((s) => s.project!.id);
  const media = useVideo((s) => s.media);
  const images = media.filter((m) => m.kind === 'image' && m.status === 'ready');
  const [kind, setKind] = useState<Kind>('image');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1536x1024');
  const [quality, setQuality] = useState<'auto' | 'low' | 'medium' | 'high'>('auto');
  const [count, setCount] = useState(1);
  const [aspect, setAspect] = useState<'16:9' | '9:16'>('16:9');
  const [resolution, setResolution] = useState<'720p' | '1080p'>('720p');
  const [still, setStill] = useState('');
  const [voice, setVoice] = useState('Kore');
  const [style, setStyle] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void loadMediaJobs(projectId);
  }, [projectId]);
  useEffect(() => setReviewing(false), [kind, prompt, size, quality, count, aspect, resolution, still, voice, style]);

  const job: JobInput | null = !prompt.trim()
    ? null
    : kind === 'image'
      ? { kind: 'image', request: { prompt: prompt.trim(), size, quality, count } }
      : kind === 'video'
        ? { kind: 'video', request: { prompt: prompt.trim(), aspectRatio: aspect, resolution, imageAssetId: still || null } }
        : { kind: 'speech', request: { text: prompt.trim(), voice, style: style.trim() } };
  const review = usePlan(projectId, reviewing ? job : null);

  const start = async (): Promise<void> => {
    if (!job) return;
    setStarting(true);
    const view = await startJob(projectId, job);
    setStarting(false);
    if (view) {
      setReviewing(false);
      setPrompt('');
    }
  };

  return (
    <div className={cx('generate', compact && 'is-compact')}>
      <SegmentedControl<Kind>
        size="sm"
        label="What to generate"
        options={[
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Video' },
          { value: 'speech', label: 'Voice-over' },
        ]}
        value={kind}
        onChange={setKind}
      />
      <label className="gen-field">
        <span className="prop-label">{kind === 'speech' ? 'Narration' : 'Prompt'}</span>
        <textarea className="input textarea" rows={compact ? 3 : 4} aria-label={kind === 'speech' ? 'Narration text' : 'Prompt'} placeholder={kind === 'image' ? 'A clay vase on a sunlit shelf, soft shadows' : kind === 'video' ? 'Slow push-in on hands shaping clay on a wheel' : 'Every piece is thrown, glazed and fired by hand.'} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {kind === 'image' && (
        <div className="gen-row">
          <label className="gen-field">
            <span className="prop-label">Shape</span>
            <select className="input" aria-label="Image shape" value={size} onChange={(e) => setSize(e.target.value)}>
              {SHAPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="gen-field">
            <span className="prop-label">Quality</span>
            <select className="input" aria-label="Quality" value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
              <option value="auto">Auto</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="gen-field gen-narrow">
            <span className="prop-label">Images</span>
            <select className="input" aria-label="Number of images" value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {kind === 'video' && (
        <div className="gen-row">
          <label className="gen-field">
            <span className="prop-label">Shape</span>
            <select className="input" aria-label="Video shape" value={aspect} onChange={(e) => setAspect(e.target.value as typeof aspect)}>
              <option value="16:9">Landscape 16:9</option>
              <option value="9:16">Portrait 9:16</option>
            </select>
          </label>
          <label className="gen-field">
            <span className="prop-label">Resolution</span>
            <select className="input" aria-label="Resolution" value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </label>
          <label className="gen-field">
            <span className="prop-label">Start from</span>
            <select className="input" aria-label="Starting image" value={still} onChange={(e) => setStill(e.target.value)}>
              <option value="">Text only</option>
              {images.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {kind === 'speech' && (
        <div className="gen-row">
          <label className="gen-field">
            <span className="prop-label">Voice</span>
            <input className="input" list="mv-voices" aria-label="Voice" value={voice} onChange={(e) => setVoice(e.target.value)} />
            <datalist id="mv-voices">
              {VOICES.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label className="gen-field gen-wide">
            <span className="prop-label">Delivery</span>
            <input className="input" aria-label="Delivery" placeholder="Warm and unhurried" value={style} onChange={(e) => setStyle(e.target.value)} />
          </label>
        </div>
      )}
      {reviewing ? (
        <>
          <JobReview {...review} />
          <div className="gen-actions">
            <Button size="sm" variant="quiet" onClick={() => setReviewing(false)}>
              Back
            </Button>
            <Button size="sm" variant="primary" icon="wand" disabled={!review.plan || starting} onClick={() => void start()}>
              {kind === 'image' && count > 1 ? `Generate ${count} images` : 'Generate'}
            </Button>
          </div>
        </>
      ) : (
        <div className="gen-actions">
          <Button size="sm" variant="primary" icon="wand" disabled={!job} onClick={() => setReviewing(true)}>
            Review…
          </Button>
        </div>
      )}
      <JobList />
    </div>
  );
}

export function JobList({ kinds }: { kinds?: MediaJobView['kind'][] }) {
  const projectId = useStudio((s) => s.project!.id);
  const jobs = useMedia((s) => s.jobs).filter((j) => !kinds || kinds.includes(j.kind));
  if (!jobs.length) return <p className="muted small gen-empty">Jobs you start appear here. They keep running while you work elsewhere.</p>;
  return (
    <ul className="bin-list gen-jobs" aria-label="AI media jobs">
      {jobs.slice(0, 30).map((j) => (
        <li key={j.id} className={cx('job-item', `is-${j.state}`)}>
          <div className="job-head">
            <Icon name={j.kind === 'video' || j.kind === 'recording' ? 'film' : j.kind === 'speech' ? 'waveform' : j.kind === 'transcription' ? 'text' : 'image'} size={13} />
            <span className="bin-name" title={j.prompt ?? j.title}>
              {j.title}
            </span>
            <span className="job-state">{JOB_STATE_LABEL[j.state]}</span>
          </div>
          {ACTIVE_JOB.has(j.state) && <div className="job-progress is-indeterminate" aria-hidden="true" />}
          <span className="bin-meta">
            {KIND_LABEL[j.kind]}
            {j.model ? ` · ${j.model}` : ''}
            {j.connectionName ? ` on ${j.connectionName}` : ''} · {relativeTime(j.createdAt)}
          </span>
          {j.detail && !['completed'].includes(j.state) && <span className="bin-meta">{j.detail}</span>}
          {j.error && <span className={cx('bin-meta', j.state === 'uncertain' ? 'job-warn' : 'job-error')}>{j.error.split('\n')[0]}</span>}
          <div className="job-actions">
            {ACTIVE_JOB.has(j.state) && j.state !== 'cancelling' && (
              <Button size="sm" variant="quiet" icon="stop" onClick={() => void cancelJob(projectId, j.id)} title={j.remoteCancel ? 'Asks the provider to stop the job' : 'Stops waiting; the provider may still finish and charge for the request'}>
                {j.remoteCancel && j.remoteId ? 'Cancel at provider' : 'Stop waiting'}
              </Button>
            )}
            {['failed', 'interrupted', 'cancelled', 'uncertain'].includes(j.state) && !j.retriedAs && (
              <Button size="sm" variant="quiet" icon="sync" onClick={() => retryJob(projectId, j)}>
                {j.state === 'uncertain' ? 'Check, then retry…' : 'Try again'}
              </Button>
            )}
            {j.state === 'completed' && j.assetIds.length > 0 && (
              <Button size="sm" variant="quiet" icon="stack" onClick={() => setStudio({ workspace: 'assets' })}>
                Show in Assets
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
