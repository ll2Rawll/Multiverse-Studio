/**
 * Website → Video: record a page of any version (or its running dev server) in an isolated browser,
 * either as it loads or following a short script of scrolls, clicks and typing. The recording
 * lands in the asset library, ready for the timeline. Nothing is sent anywhere.
 */
import { useEffect, useState } from 'react';
import { useStudio } from '../../state/store';
import { startJob } from '../../state/media';
import { call } from '../../lib/api';
import { allLines, lineRef } from '../../lib/util';
import { Dialog } from '../../components/Dialog';
import { Button, IconButton, SegmentedControl } from '../../components/primitives';
import { JobReview, usePlan } from '../media/JobReview';
import type { RecordStep } from '../../../shared/media';

const SIZES: { label: string; w: number; h: number }[] = [
  { label: 'Desktop 1280×720', w: 1280, h: 720 },
  { label: 'Full HD 1920×1080', w: 1920, h: 1080 },
  { label: 'Phone 390×844', w: 390, h: 844 },
  { label: 'Square 1080×1080', w: 1080, h: 1080 },
];

const STEP_LABEL: Record<RecordStep['kind'], string> = { wait: 'Wait', scroll: 'Scroll', click: 'Click', type: 'Type', hover: 'Hover' };

export function RecordDialog({ onClose }: { onClose: () => void }) {
  const project = useStudio((s) => s.project)!;
  const selected = useStudio((s) => s.selectedLineId);
  const [lineId, setLineId] = useState(selected);
  const [pages, setPages] = useState<string[]>([]);
  const [page, setPage] = useState('index.html');
  const [size, setSize] = useState(0);
  const [seconds, setSeconds] = useState(8);
  const [mode, setMode] = useState<'load' | 'script'>('load');
  const [steps, setSteps] = useState<RecordStep[]>([{ kind: 'wait', ms: 1000 }, { kind: 'scroll', y: 900, ms: 2500 }]);
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    void call('files.list', { projectId: project.id, ref: lineRef(lineId) }).then((files) => {
      const html = files.map((f) => f.path).filter((p) => /\.html?$/i.test(p) && !p.startsWith('node_modules/') && !p.startsWith('components/'));
      setPages(html);
      if (!html.includes(page) && page !== 'dev-server') setPage(html[0] ?? 'index.html');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, lineId]);
  useEffect(() => setReviewing(false), [lineId, page, size, seconds, mode, steps]);

  const job = { kind: 'recording' as const, request: { lineId, page, width: SIZES[size]!.w, height: SIZES[size]!.h, seconds, steps: mode === 'script' ? steps : [] } };
  const review = usePlan(project.id, reviewing ? job : null);
  const update = (i: number, patch: Partial<RecordStep>): void => setSteps((list) => list.map((s, k) => (k === i ? ({ ...s, ...patch } as RecordStep) : s)));
  const start = async (): Promise<void> => {
    if (await startJob(project.id, job)) onClose();
  };

  return (
    <Dialog
      title="Record a page"
      description="Records in an isolated browser with no access to the app or your keys. The video goes into Assets."
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          {reviewing ? (
            <Button variant="primary" icon="film" disabled={!review.plan} onClick={() => void start()}>
              Record {seconds} s
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setReviewing(true)}>
              Review…
            </Button>
          )}
        </>
      }
    >
      <div className="form-grid">
        <label className="prop-row">
          <span className="prop-label">Version</span>
          <select className="input" aria-label="Version to record" value={lineId} onChange={(e) => setLineId(e.target.value)}>
            {allLines(project).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="prop-row">
          <span className="prop-label">Page</span>
          <select className="input" aria-label="Page to record" value={page} onChange={(e) => setPage(e.target.value)}>
            {pages.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="dev-server">The running dev server (start it in Build)</option>
          </select>
        </label>
        <label className="prop-row">
          <span className="prop-label">Size</span>
          <select className="input" aria-label="Recording size" value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {SIZES.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="prop-row">
          <span className="prop-label">Length</span>
          <span className="quick-inline">
            <input className="input num-input" type="number" min={1} max={120} aria-label="Recording length in seconds" value={seconds} onChange={(e) => setSeconds(Math.max(1, Math.min(120, Number(e.target.value) || 1)))} /> s
          </span>
        </label>
        <div className="prop-row">
          <span className="prop-label">What happens</span>
          <SegmentedControl
            size="sm"
            label="Recording mode"
            options={[
              { value: 'load', label: 'Page loads and plays' },
              { value: 'script', label: 'Follow steps' },
            ]}
            value={mode}
            onChange={setMode}
          />
        </div>
      </div>
      {mode === 'script' && (
        <div className="record-steps">
          <ol>
            {steps.map((s, i) => (
              <li key={i} className="record-step">
                <select className="input" aria-label={`Step ${i + 1} action`} value={s.kind} onChange={(e) => setSteps((list) => list.map((x, k) => (k === i ? defaults(e.target.value as RecordStep['kind']) : x)))}>
                  {Object.entries(STEP_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                {s.kind === 'wait' && <input className="input num-input" type="number" min={0} max={60000} step={100} aria-label={`Step ${i + 1} milliseconds`} value={s.ms} onChange={(e) => update(i, { ms: Number(e.target.value) })} />}
                {s.kind === 'scroll' && (
                  <>
                    <input className="input num-input" type="number" aria-label={`Step ${i + 1} scroll pixels`} value={s.y} onChange={(e) => update(i, { y: Number(e.target.value) })} />
                    <span className="muted small">px over</span>
                    <input className="input num-input" type="number" min={0} max={20000} step={100} aria-label={`Step ${i + 1} scroll milliseconds`} value={s.ms} onChange={(e) => update(i, { ms: Number(e.target.value) })} />
                    <span className="muted small">ms</span>
                  </>
                )}
                {(s.kind === 'click' || s.kind === 'hover' || s.kind === 'type') && <input className="input" aria-label={`Step ${i + 1} selector`} placeholder="CSS selector, e.g. .cta" value={s.selector} onChange={(e) => update(i, { selector: e.target.value })} />}
                {s.kind === 'type' && <input className="input" aria-label={`Step ${i + 1} text`} placeholder="Text to type" value={s.text} onChange={(e) => update(i, { text: e.target.value })} />}
                <IconButton icon="trash" size="sm" label={`Remove step ${i + 1}`} onClick={() => setSteps((list) => list.filter((_, k) => k !== i))} />
              </li>
            ))}
          </ol>
          <Button size="sm" variant="quiet" icon="plus" disabled={steps.length >= 50} onClick={() => setSteps((list) => [...list, { kind: 'wait', ms: 1000 }])}>
            Add step
          </Button>
        </div>
      )}
      {reviewing && <JobReview {...review} />}
    </Dialog>
  );
}

function defaults(kind: RecordStep['kind']): RecordStep {
  if (kind === 'wait') return { kind, ms: 1000 };
  if (kind === 'scroll') return { kind, y: 600, ms: 1500 };
  if (kind === 'type') return { kind, selector: '', text: '' };
  return { kind, selector: '' };
}
