/**
 * Stories: record a product flow in the live preview, add checks, chapters, captions and narration,
 * run it as a browser test, record it as video, and put the recording into a timeline.
 */
import { useEffect, useMemo, useState } from 'react';
import { useStudio, toast } from '../state/store';
import { setWorkspace } from '../state/actions';
import { call, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Button, EmptyState, IconButton, SegmentedControl } from '../components/primitives';
import { Icon } from '../components/Icon';
import { PreviewFrame, type RecordedStep } from '../components/PreviewFrame';
import { cx, lineRef, plural, relativeTime, type Viewport } from '../lib/util';
import { VIEWPORT_OPTIONS } from './PreviewCard';
import { STEP_GROUP, STATUS_LABEL, describeStep, type StoryRunView, type StoryStep, type StoryView } from '../../shared/stories';
import { useStoryRuns, useStoryUi } from '../state/stories';
import { useLive } from '../state/live';

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'story';
const newId = (): string => `s${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
const GROUP_ICON: Record<string, string> = { action: 'interact', assertion: 'check', timing: 'pause', narration: 'volume', caption: 'text', chapter: 'film' };

type AddKind = 'verify' | 'chapter' | 'annotate' | 'narrate' | 'hold' | 'open';
const ADD_LABEL: Record<AddKind, string> = { verify: 'Check text', chapter: 'Chapter', annotate: 'Caption', narrate: 'Narration', hold: 'Hold', open: 'Open page' };

export function Stories() {
  const project = useStudio((s) => s.project)!;
  const lineId = useStudio((s) => s.selectedLineId);
  const version = useStudio((s) => s.previewVersions[s.selectedLineId] ?? 0);
  const revision = useStoryRuns((s) => s.revision);
  const lineName = lineId === project.shared.id ? project.shared.name : (project.alternatives.find((a) => a.id === lineId)?.name ?? '');
  const stories = useAsync(() => call('stories.list', { projectId: project.id, lineId }), [project.id, lineId, version, revision]);
  const files = useAsync(() => call('files.list', { projectId: project.id, ref: lineRef(lineId) }), [project.id, lineId, version, project.updatedAt]);
  const pages = (files.data ?? []).map((f) => f.path).filter((p) => /\.html?$/i.test(p) && !p.startsWith('node_modules/'));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [recording, setRecording] = useState(false);
  const [captured, setCaptured] = useState<StoryStep[]>([]);
  const [newName, setNewName] = useState('');
  const list = stories.data ?? [];
  const selected = list.find((s) => s.id === selectedId) ?? list[0] ?? null;
  const want = useStoryUi((s) => s.want);
  useEffect(() => {
    if (want && list.some((s) => s.id === want.storyId)) setSelectedId(want.storyId);
  }, [want?.at, list.length]);

  useEffect(() => {
    setRecording(false);
    setCaptured([]);
  }, [selected?.id, lineId]);

  const create = async (): Promise<void> => {
    const id = `${slug(newName)}-${Date.now().toString(36).slice(-3)}`;
    try {
      await call('commands.run', { projectId: project.id, lineId, name: 'stories.create', args: { story: id, name: newName.trim(), page: pages.includes('index.html') ? 'index.html' : (pages[0] ?? 'index.html') } });
      setNewName('');
      setSelectedId(id);
      stories.reload();
      toast({ tone: 'success', title: 'Story created', body: 'Press Record steps and use the preview, then add checks and chapters.' });
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t create the story', body: errorMessage(error) });
    }
  };

  const onStep = (step: RecordedStep): void => {
    setCaptured((list) => {
      const last = list[list.length - 1];
      // Typing then pressing Enter in the same field is one fill followed by the key; repeated fills of one field collapse.
      if (step.kind === 'fill' && last?.kind === 'fill' && JSON.stringify(last.target) === JSON.stringify(step.target)) return [...list.slice(0, -1), { ...last, text: step.text }];
      return [...list, { id: newId(), ...step } as StoryStep];
    });
  };

  return (
    <div className="stories">
      <section className="stories-preview" aria-label="Live preview for stories">
        <div className="preview-bar">
          <SegmentedControl size="sm" label="Preview size" options={VIEWPORT_OPTIONS} value={viewport} onChange={setViewport} />
          <span className="bar-spacer" />
          {selected && (
            <Button size="sm" variant={recording ? 'danger' : 'primary'} icon={recording ? 'stop' : 'dot'} onClick={() => setRecording((r) => !r)} aria-pressed={recording}>
              {recording ? 'Stop recording' : 'Record steps'}
            </Button>
          )}
        </div>
        {recording && (
          <p className="stories-recording" role="status">
            <span className="rec-dot" aria-hidden /> Recording steps in {lineName}: click, type and press Enter in the preview. {plural(captured.length, 'step')} so far.
          </p>
        )}
        <div className="edit-preview-frame">
          <PreviewFrame projectId={project.id} contentRef={lineRef(lineId)} version={version} viewport={viewport} interactive title={`${lineName} preview for stories`} record={recording} onStoryStep={onStep} path={selected && selected.page !== 'dev-server' ? selected.page : undefined} />
        </div>
      </section>
      <section className="stories-panel" aria-label="Stories">
        <div className="stories-head">
          <h1 className="workspace-title" data-text="Stories">
            Stories
          </h1>
          <span className="muted small">in {lineName}</span>
        </div>
        <ul className="stories-list">
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" className={cx('objects-item', selected?.id === s.id && 'is-selected')} aria-current={selected?.id === s.id} onClick={() => setSelectedId(s.id)}>
                <strong>{s.name}</strong>
                <span className={cx('story-status', `is-${s.status}`)}>{STATUS_LABEL[s.status]}</span>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="objects-use-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) void create();
          }}
        >
          <input className="input" aria-label="New story name" placeholder="New story, e.g. Create a first task" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button size="sm" type="submit" icon="plus" disabled={!newName.trim()}>
            Create
          </Button>
        </form>
        {selected ? (
          <StoryEditor key={`${selected.id}:${lineId}`} story={selected} projectId={project.id} lineId={lineId} pages={pages} captured={captured} clearCaptured={() => setCaptured([])} recording={recording} onSaved={stories.reload} />
        ) : (
          <EmptyState icon="interact" title="No stories in this version" body="A story is a product flow you record once and reuse as a test, a walkthrough and video footage." />
        )}
      </section>
    </div>
  );
}

function StoryEditor({ story, projectId, lineId, pages, captured, clearCaptured, recording, onSaved }: { story: StoryView; projectId: string; lineId: string; pages: string[]; captured: StoryStep[]; clearCaptured: () => void; recording: boolean; onSaved: () => void }) {
  const [steps, setSteps] = useState<StoryStep[]>(story.steps);
  // The step an AI run is on right now (from live activity), shown on the step itself.
  const liveKey = useLive((s) => {
    const t = s.visual?.event.target;
    return t?.kind === 'story-step' && t.storyId === story.id && s.visual!.event.universeId === lineId ? `${t.stepId}|${String(t.ok)}` : '';
  });
  const liveStep = liveKey ? { id: liveKey.split('|')[0]!, ok: liveKey.endsWith('|false') ? false : null } : null;
  const [fixtures, setFixtures] = useState(Object.entries(story.fixtures).map(([k, v]) => `${k} = ${v}`).join('\n'));
  const [page, setPage] = useState(story.page);
  const [delay, setDelay] = useState(story.timing.stepDelayMs);
  const [typing, setTyping] = useState(story.timing.typingMsPerChar);
  const [busy, setBusy] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<AddKind>('verify');
  const [addText, setAddText] = useState('');
  const [target, setTarget] = useState('new');
  const [includeActivity, setIncludeActivity] = useState(false);
  const running = useStoryRuns((s) => s.running[`${story.id}:${lineId}`] ?? false);
  const runs = useAsync(() => call('stories.runs', { projectId }), [projectId, story.lastRun?.id]);
  const seqs = useAsync(() => call('sequences.list', { projectId, lineId }), [projectId, lineId, story.lastRun?.id]);
  const shot = useAsync(() => (story.lastRun && story.lastRun.mode === 'test' ? call('stories.screenshot', { projectId, runId: story.lastRun.id }) : Promise.resolve(null)), [projectId, story.lastRun?.id]);
  // Take the saved steps only when they actually change (a reload with the same steps keeps local edits).
  const savedSteps = JSON.stringify(story.steps);
  useEffect(() => setSteps(story.steps), [savedSteps]);
  const all = [...steps, ...captured];
  const results = new Map((story.lastRun?.steps ?? []).map((r) => [r.id, r]));
  const parsedFixtures = useMemo(() => {
    const out: Record<string, string> = {};
    for (const line of fixtures.split('\n')) {
      const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]!] = m[2]!.trim();
    }
    return out;
  }, [fixtures]);
  const dirty = captured.length > 0 || JSON.stringify(steps) !== JSON.stringify(story.steps) || JSON.stringify(parsedFixtures) !== JSON.stringify(story.fixtures) || page !== story.page || delay !== story.timing.stepDelayMs || typing !== story.timing.typingMsPerChar;
  const mine = (runs.data ?? []).filter((r) => r.storyId === story.id && r.lineId === lineId);
  const recordings = mine.filter((r) => r.mode === 'recording' && r.ok && r.assetId);

  const save = async (): Promise<boolean> => {
    setBusy('save');
    try {
      await call('commands.run', { projectId, lineId, name: 'stories.update', args: { story: story.id, steps: all, fixtures: parsedFixtures, page, timing: { ...story.timing, stepDelayMs: delay, typingMsPerChar: typing } } });
      clearCaptured();
      onSaved();
      return true;
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t save the story', body: errorMessage(error) });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const act = async (what: 'run' | 'record'): Promise<void> => {
    if (dirty && !(await save())) return;
    setBusy(what);
    try {
      const sequence = target === 'none' ? null : target === 'new' ? `story-${story.id}`.slice(0, 120) : target;
      const r = what === 'run' ? await call('stories.run', { projectId, lineId, storyId: story.id }) : await call('stories.record', { projectId, lineId, storyId: story.id, insert: sequence ? { sequence } : null, includeActivity });
      if (r.ok) toast({ tone: 'success', title: what === 'run' ? 'Story passed' : 'Story recorded', body: what === 'run' ? `${r.steps.filter((s) => s.ok).length} actions and checks passed on these files.` : sequence ? `Added to ${sequence} with its titles and captions.` : 'The clip is in Assets.' });
      else toast({ tone: 'error', title: what === 'run' ? 'Story failed' : 'Not recorded', body: `${r.error ?? 'A step failed.'}${what === 'record' ? ' Nothing was added: only a working flow is recorded.' : ''}`, sticky: true });
      onSaved();
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t run the story', body: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };
  const insert = async (run: StoryRunView): Promise<void> => {
    const sequence = target === 'new' || target === 'none' ? `story-${story.id}`.slice(0, 120) : target;
    try {
      await call('stories.insert', { projectId, lineId, runId: run.id, sequence });
      toast({ tone: 'success', title: `Added to ${sequence}`, body: 'Open Video to adjust pacing and titles.' });
      seqs.reload();
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t add it', body: errorMessage(error) });
    }
  };
  const exportWalkthrough = async (): Promise<void> => {
    if (dirty && !(await save())) return;
    try {
      await call('commands.run', { projectId, lineId, name: 'stories.exportWalkthrough', args: { story: story.id } });
      toast({ tone: 'success', title: 'Walkthrough exported', body: `walkthroughs/${story.id}.html is in this version. It controls the app once both are published to the same site.` });
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t export the walkthrough', body: errorMessage(error) });
    }
  };
  const addStep = (): void => {
    const id = newId();
    const t = addText.trim();
    const step: StoryStep | null =
      addKind === 'verify' ? (t ? { id, kind: 'verify', target: null, expect: { text: t } } : null) : addKind === 'chapter' ? (t ? { id, kind: 'chapter', title: t } : null) : addKind === 'annotate' ? (t ? { id, kind: 'annotate', text: t } : null) : addKind === 'narrate' ? (t ? { id, kind: 'narrate', text: t } : null) : addKind === 'hold' ? { id, kind: 'hold', ms: Math.round((Number(t) || 1) * 1000) } : t ? { id, kind: 'open', path: t } : null;
    if (!step) return;
    setSteps((list) => [...list, ...captured, step]);
    clearCaptured();
    setAddText('');
  };
  const move = (i: number, d: -1 | 1): void =>
    setSteps((list) => {
      const next = [...list];
      const j = i + d;
      if (j < 0 || j >= next.length) return list;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <div className="story-editor">
      <div className={cx('story-status-line', `is-${story.status}`)} role="status">
        <strong>{STATUS_LABEL[story.status]}</strong> <span>{story.statusDetail}</span>
        {story.lastRun && (
          <span className="muted small">
            {' '}
            · last {story.lastRun.mode === 'recording' ? 'recording' : 'run'} {relativeTime(story.lastRun.at)} in {story.lastRun.lineName}
            {story.lastRun.revision ? ` at ${story.lastRun.revision.slice(0, 8)}` : ''}
          </span>
        )}
        {story.status === 'failing' && story.lastPassing && <span className="muted small"> · last passed {relativeTime(story.lastPassing.at)}</span>}
      </div>
      <div className="objects-use-row">
        <label className="field-label" htmlFor="story-page">
          Starts at
        </label>
        <select id="story-page" className="input" value={page} onChange={(e) => setPage(e.target.value)}>
          {[...new Set([page, ...pages, 'dev-server'])].map((p) => (
            <option key={p} value={p}>
              {p === 'dev-server' ? 'The app’s dev server' : p}
            </option>
          ))}
        </select>
      </div>
      <h2 className="ai-subhead">Steps</h2>
      {all.length === 0 && <p className="muted small">No steps yet. Press Record steps and use the preview, or add a check below.</p>}
      <ol className="story-steps">
        {all.map((s, i) => {
          const r = results.get(s.id);
          const fresh = i >= steps.length;
          const group = STEP_GROUP[s.kind];
          return (
            <li key={s.id} data-live={`story-step:${s.id}`} className={cx('story-step', `is-${group}`, fresh && 'is-new', liveStep?.id === s.id && 'is-live', liveStep?.id === s.id && liveStep.ok === false && 'is-live-failed')} aria-current={liveStep?.id === s.id ? 'step' : undefined}>
              <Icon name={GROUP_ICON[group] ?? 'dot'} size={13} />
              <span className="story-step-text">
                {describeStep(s)}
                {r && r.ok === false && <span className="story-step-fail"> — {r.detail}</span>}
              </span>
              <span className="story-step-result" aria-label={r ? (r.ok === null ? 'not part of the test' : r.ok ? 'passed' : 'failed') : 'not run'}>
                {r?.ok === true ? <Icon name="check" size={12} /> : r?.ok === false ? <Icon name="warning" size={12} /> : null}
              </span>
              {!fresh && (
                <span className="story-step-tools">
                  <IconButton icon="chevronLeft" className="rot-90" size="sm" label={`Move “${describeStep(s)}” up`} onClick={() => move(i, -1)} />
                  <IconButton icon="trash" size="sm" label={`Remove “${describeStep(s)}”`} onClick={() => setSteps((list) => list.filter((x) => x.id !== s.id))} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="objects-use-row" role="group" aria-label="Add a step">
        <select className="input story-add-kind" aria-label="Kind of step" value={addKind} onChange={(e) => setAddKind(e.target.value as AddKind)}>
          {(Object.keys(ADD_LABEL) as AddKind[]).map((k) => (
            <option key={k} value={k}>
              {ADD_LABEL[k]}
            </option>
          ))}
        </select>
        <input className="input" aria-label={addKind === 'hold' ? 'Seconds' : addKind === 'open' ? 'Page path' : addKind === 'verify' ? 'Text the page should show' : 'Text'} placeholder={addKind === 'hold' ? 'Seconds, e.g. 1.5' : addKind === 'verify' ? 'Text the page should show' : addKind === 'open' ? 'about.html' : 'Text'} value={addText} onChange={(e) => setAddText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addStep())} />
        <Button size="sm" icon="plus" onClick={addStep}>
          Add
        </Button>
      </div>
      <details className="ai-advanced">
        <summary>Fixtures and timing</summary>
        <div className="field">
          <label className="field-label" htmlFor="story-fixtures">
            Fixture data (name = value, one per line; use as {'{{name}}'} in typed text)
          </label>
          <textarea id="story-fixtures" className="input mono" rows={3} value={fixtures} onChange={(e) => setFixtures(e.target.value)} />
          <p className="field-hint">Made-up data for demonstrations and tests. Never use real customer data or credentials.</p>
        </div>
        <div className="objects-use-row">
          <label className="field-label" htmlFor="story-delay">
            Pause between steps (ms)
          </label>
          <input id="story-delay" className="input" type="number" min={0} max={5000} value={delay} onChange={(e) => setDelay(Math.max(0, Math.min(5000, Number(e.target.value) || 0)))} />
          <label className="field-label" htmlFor="story-typing">
            Typing (ms per letter)
          </label>
          <input id="story-typing" className="input" type="number" min={10} max={400} value={typing} onChange={(e) => setTyping(Math.max(10, Math.min(400, Number(e.target.value) || 45)))} />
        </div>
      </details>
      <div className="dialog-actions">
        <Button disabled={!dirty || busy !== null || recording} onClick={() => void save()}>
          Save steps
        </Button>
        <Button icon="play" disabled={busy !== null || running || recording} onClick={() => void act('run')}>
          {busy === 'run' ? 'Running…' : 'Run test'}
        </Button>
      </div>
      <div className="objects-use-row story-wrap">
        <label className="field-label" htmlFor="story-target">
          Recording goes to
        </label>
        <select id="story-target" className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="new">A new sequence</option>
          <option value="none">Assets only</option>
          {(seqs.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              The end of {s.name}
            </option>
          ))}
        </select>
        <label className="check-row story-include-ai">
          <input type="checkbox" checked={includeActivity} onChange={(e) => setIncludeActivity(e.target.checked)} />
          <span>Include AI activity</span>
        </label>
        <Button variant="primary" icon="film" disabled={busy !== null || running || recording} onClick={() => void act('record')}>
          {busy === 'record' ? 'Recording…' : 'Record video'}
        </Button>
      </div>
      <p className="field-hint">A recording runs every action and check again and is kept only if they all pass. The studio’s AI activity overlay is never recorded; “Include AI activity” draws the AI pointer in the video instead of the plain demo pointer. Chapters, captions and narration become editable titles in the timeline.</p>
      <div>
        <Button size="sm" variant="quiet" icon="export" disabled={busy !== null || recording} onClick={() => void exportWalkthrough()}>
          Export walkthrough
        </Button>
        <p className="field-hint">An interactive guide (walkthroughs/{story.id}.html) that performs each step in the app when both are served from the same site.</p>
      </div>
      {shot.data && (
        <figure className="story-shot">
          <img src={shot.data} alt={`The page at the end of the last run of ${story.name}`} />
          <figcaption className="muted small">End of the last test run</figcaption>
        </figure>
      )}
      {recordings.length > 0 && (
        <>
          <h2 className="ai-subhead">Recordings</h2>
          <ul className="deploy-list">
            {recordings.slice(0, 5).map((r) => (
              <li key={r.id} className="deploy-row" data-state="completed">
                <div className="deploy-main">
                  <span>
                    {relativeTime(r.at)} · {(r.durationMs / 1000).toFixed(1)} s · {r.lineName}
                    {r.revision ? ` at ${r.revision.slice(0, 8)}` : ''}
                  </span>
                </div>
                <div className="conn-actions">
                  <Button size="sm" onClick={() => void insert(r)}>
                    Add to video
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setWorkspace('assets')}>
                    Assets
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
