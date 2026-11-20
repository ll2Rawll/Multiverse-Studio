import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useStudio, openDialog } from '../state/store';
import { cancelTask, decideApproval, isActive, loadArtifact, loadProjectAi, newConversation, pauseTask, refKey, refreshPreview, removeReference, selectionReferences, sendPrompt, setAutopilot, setDraft, setMode, setPermission, toggleAttachment, useAi } from '../state/ai';
import { useVideo } from '../state/video';
import { useSelectionRefs } from '../state/selection';
import { selectLine, setWorkspace, startCompare } from '../state/actions';
import { set as setStudio } from '../state/store';
import { Button, IconButton, SegmentedControl, Toggle } from '../components/primitives';
import { Icon } from '../components/Icon';
import { cx } from '../lib/util';
import { Markdown } from './Markdown';
import { STATE_LABEL, breakdownText, bytesText, costText, savedText, stateTone, tokenText } from './format';
import type { StudioReference, TaskMessage, TaskMode, TaskView } from '../../shared/ai';

const MODES: { value: TaskMode; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'plan', label: 'Plan' },
  { value: 'build', label: 'Build' },
  { value: 'autopilot', label: 'Autopilot' },
];

const MODE_HINT: Record<TaskMode, string> = {
  ask: 'Explains and investigates. Never changes files.',
  plan: 'Reads the project and proposes a plan. Never changes files.',
  build: 'Edits a task alternative, runs builds and tests, and reports what it checked.',
  autopilot: 'Works on its own in a task alternative: edits, builds, installs, checks and repairs within the task limits. Anything outside routine work still asks.',
};

const REF_ICON: Record<StudioReference['kind'], string> = { file: 'file', element: 'target', clip: 'film', sequence: 'film', asset: 'image' };

function ReferenceChips() {
  // Re-read on every render of the composer: selections live in several stores.
  useStudio((s) => s.workspace);
  useStudio((s) => s.selectedFile[s.selectedLineId] ?? null);
  useVideo((s) => s.selection);
  useVideo((s) => s.sequence);
  useSelectionRefs((s) => s.design);
  useSelectionRefs((s) => s.asset);
  useAi((s) => s.removedRefs);
  const refs = selectionReferences();
  if (!refs.length) return null;
  return (
    <div className="ai-attachments" role="group" aria-label="Referenced objects">
      {refs.map((r) => (
        <span key={refKey(r)} className="ai-chip is-ref" title={`${r.kind} ${r.id}${r.within ? ` in ${r.within}` : ''}`}>
          <Icon name={REF_ICON[r.kind]} size={12} /> {r.label}
          <button type="button" className="ai-chip-remove" onClick={() => removeReference(r)} aria-label={`Remove reference ${r.label}`}>
            <Icon name="close" size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

function AutopilotSwitch() {
  const projectAi = useAi((s) => s.projectAi);
  const projectId = useStudio((s) => s.project?.id);
  useEffect(() => {
    if (projectId) void loadProjectAi(projectId);
  }, [projectId]);
  if (!projectAi) return null;
  return (
    <Toggle
      checked={projectAi.autopilot}
      onChange={(v) => void setAutopilot(v)}
      label="Autopilot for this project"
      description="Lets Autopilot tasks edit, build, install and check without asking. Publishing, purchases, credentials and files outside the project always ask."
    />
  );
}

function ToolMessage({ m }: { m: TaskMessage }) {
  const r = m.toolResult!;
  return (
    <details className={cx('ai-tool', r.ok ? 'is-ok' : 'is-failed')}>
      <summary>
        <Icon name={r.ok ? 'check' : 'warning'} size={13} />
        <span>{m.text || r.name}</span>
      </summary>
      <pre className="ai-tool-output">{r.output.slice(0, 8000)}</pre>
    </details>
  );
}

function Conversation({ task }: { task: TaskView }) {
  const end = useRef<HTMLDivElement | null>(null);
  const last = task.messages[task.messages.length - 1];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [task.messages.length, last?.text.length]);
  const running = isActive(task);
  // Notes (approvals, pauses, cancellation) are shown where they happened in the conversation.
  const notes = task.steps.filter((s) => s.kind === 'note');
  const items: (TaskMessage | { note: (typeof notes)[number] })[] = [...task.messages];
  for (const n of notes) {
    const at = items.findIndex((m) => 'createdAt' in m && m.createdAt > n.startedAt);
    if (at === -1) items.push({ note: n });
    else items.splice(at, 0, { note: n });
  }
  return (
    <div className="ai-conversation" aria-live="polite" aria-busy={running}>
      {items.map((m) =>
        'note' in m ? (
          <p key={m.note.id} className="ai-note">
            {m.note.title}. {m.note.detail}
          </p>
        ) : m.role === 'user' ? (
          <div key={m.id} className="ai-msg ai-user">
            <p>{m.text}</p>
          </div>
        ) : m.role === 'assistant' ? (
          m.text || m.partial ? (
            <div key={m.id} className={cx('ai-msg ai-assistant', m.partial && 'is-streaming')}>
              {m.text ? <Markdown text={m.text} /> : <p className="muted">Waiting for the model…</p>}
            </div>
          ) : null
        ) : m.role === 'tool' && m.toolResult ? (
          <ToolMessage key={m.id} m={m} />
        ) : (
          <p key={m.id} className="ai-note">{m.text}</p>
        ),
      )}
      {task.error && (
        <div className="ai-error" role="alert">
          <Icon name="warning" size={15} />
          <div>
            <p>{task.error.message}</p>
            {(task.error.kind === 'not-configured' || task.error.kind === 'auth' || task.error.kind === 'unsupported') && (
              <Button size="sm" onClick={() => openDialog({ kind: 'settings', tab: task.error!.kind === 'auth' ? 'providers' : 'models' })}>
                Open AI settings
              </Button>
            )}
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function Approval({ task }: { task: TaskView }) {
  if (!task.approval) return null;
  return (
    <div className="ai-approval" role="alertdialog" aria-label="Permission needed">
      <p className="ai-approval-title">
        <Icon name="warning" size={15} /> {task.approval.title}
      </p>
      <p className="muted">{task.approval.detail}</p>
      <div className="ai-approval-actions">
        <Button size="sm" onClick={() => void decideApproval(task.id, false)}>
          Decline
        </Button>
        <Button size="sm" variant="primary" onClick={() => void decideApproval(task.id, true)}>
          Allow once
        </Button>
      </div>
    </div>
  );
}

function Artifacts({ task }: { task: TaskView }) {
  const urls = useAi((s) => s.artifactUrls);
  const shots = task.artifacts ?? [];
  useEffect(() => {
    for (const a of shots) void loadArtifact(task.id, a.file);
  }, [shots.length, task.id]);
  if (!shots.length) return null;
  return (
    <div className="ai-shots">
      {shots.map((a) => (
        <figure key={a.id} className="ai-shot">
          {urls[`${task.id}/${a.file}`] ? <img src={urls[`${task.id}/${a.file}`]} alt={`Screenshot of ${a.label}`} /> : <div className="ai-shot-loading">Loading screenshot…</div>}
          <figcaption>{a.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function WorkingVersion({ task }: { task: TaskView }) {
  const separate = task.workingLineId && task.originLineId && task.workingLineId !== task.originLineId;
  if ((task.mode !== 'build' && task.mode !== 'autopilot') || !separate) return null;
  return (
    <div className="ai-working">
      <p>
        Working in <strong>{task.workingLineName}</strong>. Your version is unchanged.
      </p>
      {task.filesChanged.length > 0 && (
        <ul className="ai-files">
          {task.filesChanged.map((f) => (
            <li key={f}>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  selectLine(task.workingLineId!);
                  setStudio((s) => ({ selectedFile: { ...s.selectedFile, [task.workingLineId!]: f } }));
                  setWorkspace('build');
                }}
              >
                {f}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ai-working-actions">
        <Button size="sm" icon="compare" onClick={() => startCompare({ kind: 'line', lineId: task.originLineId! }, { kind: 'line', lineId: task.workingLineId! })} disabled={task.filesChanged.length === 0}>
          Review changes
        </Button>
        <Button size="sm" icon="combine" onClick={() => startCompare({ kind: 'line', lineId: task.workingLineId! }, { kind: 'line', lineId: task.originLineId! }, 'combine')} disabled={isActive(task) || task.filesChanged.length === 0}>
          Combine into your version
        </Button>
        {task.checkpointId && (
          <Button size="sm" variant="quiet" icon="restore" onClick={() => openDialog({ kind: 'restore', checkpointId: task.checkpointId!, lineIds: [task.originLineId!] })} title="A checkpoint of every version was made before this task started">
            Restore from before the task…
          </Button>
        )}
      </div>
    </div>
  );
}

function TaskStatus({ task }: { task: TaskView }) {
  const running = isActive(task);
  return (
    <div className="ai-status">
      <span className={cx('ai-state', `tone-${stateTone(task.state)}`)}>{STATE_LABEL[task.state]}</span>
      {task.route && (
        <span className="muted" title={task.route.local ? 'Runs on this computer' : `Sent to ${task.route.connectionName}`}>
          {task.route.modelId} {task.route.local ? '· this computer' : `· ${task.route.connectionName}`}
        </span>
      )}
      <span className="muted" title={task.lastRequest ? breakdownText(task.lastRequest) : undefined}>
        {tokenText(task.usage)}
      </span>
      <span className="muted">{costText(task.usage)}</span>
      {savedText(task.usage) && (
        <span className="muted" title={`Estimated at four characters per token. ${task.lastRequest ? breakdownText(task.lastRequest) : ''}`}>
          {savedText(task.usage)}
        </span>
      )}
      {(task.state === 'failed' || task.state === 'interrupted' || task.state === 'cancelled') && task.mode !== 'ask' && (
        <span className="ai-status-actions">
          <Button size="sm" icon="undo" onClick={() => void sendPrompt('Continue this task. First check the current state of the files and processes, then retry the step that failed or was interrupted.')}>
            Retry
          </Button>
        </span>
      )}
      {running && (
        <span className="ai-status-actions">
          {task.state === 'paused' ? (
            <Button size="sm" icon="play" onClick={() => void pauseTask(task.id, false)}>
              Resume
            </Button>
          ) : (
            <Button size="sm" icon="pause" onClick={() => void pauseTask(task.id, true)} disabled={task.state !== 'running'}>
              Pause
            </Button>
          )}
          <Button size="sm" variant="danger" icon="close" onClick={() => void cancelTask(task.id)} disabled={task.state === 'cancelling'}>
            Stop
          </Button>
        </span>
      )}
    </div>
  );
}

function BuildPermissions() {
  const p = useAi((s) => s.permissions);
  const rows: { key: keyof typeof p; label: string }[] = [
    { key: 'editAlternative', label: 'Edit its task alternative' },
    { key: 'runBuildAndTests', label: 'Run the project’s build, tests and scripts' },
    { key: 'installDependencies', label: 'Install dependencies' },
    { key: 'operatePreview', label: 'Run and inspect the preview' },
  ];
  return (
    <fieldset className="ai-perms">
      <legend>Allowed without asking</legend>
      {rows.map((r) => (
        <label key={r.key} className="check-row">
          <input type="checkbox" checked={p[r.key]} onChange={(e) => setPermission(r.key, e.target.checked)} /> {r.label}
        </label>
      ))}
      <p className="field-hint">Anything else asks first. Commands run on this computer as you, in a copy of the task alternative: this is not a sandbox. The task never sees your API keys.</p>
    </fieldset>
  );
}

export function Composer({ task }: { task: TaskView | null }) {
  const draft = useAi((s) => s.draft);
  const mode = useAi((s) => s.mode);
  const attachments = useAi((s) => s.attachments);
  const preview = useAi((s) => s.preview);
  const sending = useAi((s) => s.sending);
  const projectAi = useAi((s) => s.projectAi);
  const workspace = useStudio((s) => s.workspace);
  useVideo((s) => s.selection);
  useSelectionRefs((s) => s.design);
  useSelectionRefs((s) => s.asset);
  useAi((s) => s.removedRefs);
  const refCount = task ? 0 : selectionReferences().length;
  const openFile = useStudio((s) => s.selectedFile[s.selectedLineId] ?? null);
  useEffect(() => {
    void refreshPreview();
  }, []);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendPrompt();
    }
  };
  const continuing = Boolean(task);
  return (
    <form
      className="ai-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void sendPrompt();
      }}
    >
      {!continuing && (
        <div className="ai-mode">
          <SegmentedControl label="Task mode" size="sm" options={projectAi?.autopilot ? MODES : MODES.filter((m) => m.value !== 'autopilot')} value={mode} onChange={setMode} />
          <p className="field-hint">{MODE_HINT[mode]}</p>
          {mode === 'build' && <BuildPermissions />}
          <AutopilotSwitch />
        </div>
      )}
      <label className="sr-only" htmlFor="ai-prompt">
        {continuing ? 'Message' : 'What do you want to create or change?'}
      </label>
      <textarea
        id="ai-prompt"
        className="ai-input"
        rows={3}
        placeholder={continuing ? (task && isActive(task) ? 'Steer this task…' : 'Reply or ask a follow-up…') : 'What do you want to create or change?'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
      />
      {!continuing && <ReferenceChips />}
      <div className="ai-attachments">
        {attachments.map((p) => (
          <button key={p} type="button" className="ai-chip" onClick={() => toggleAttachment(p)} aria-label={`Remove attachment ${p}`}>
            <Icon name="file" size={12} /> {p} <Icon name="close" size={11} />
          </button>
        ))}
        {!continuing && workspace === 'build' && openFile && !attachments.includes(openFile) && (
          <button type="button" className="ai-chip is-add" onClick={() => toggleAttachment(openFile)}>
            <Icon name="plus" size={12} /> Attach {openFile}
          </button>
        )}
      </div>
      {!continuing && preview && (
        <div className="ai-send-preview">
          {preview.route ? (
            <p>
              {preview.route.local ? 'Runs on this computer' : `Sends to ${preview.route.connectionName}`} with {preview.route.modelLabel}
              {preview.items.length > 0 && `: your message${preview.items.filter((i) => i.sent).map((i) => `, ${i.label} (${bytesText(i.bytes)})`).join('')}`}
              {preview.items.length === 0 && ': your message and any selected text. No project files are attached.'}
              {refCount > 0 && ` The ${refCount === 1 ? 'reference' : `${refCount} references`} above ${refCount === 1 ? 'is' : 'are'} sent as ids and names; the task reads their content with tools.`}
            </p>
          ) : (
            <p className="ai-warn">
              {preview.problem}{' '}
              <button type="button" className="link-button" onClick={() => openDialog({ kind: 'settings', tab: 'providers' })}>
                Set up AI
              </button>
            </p>
          )}
          {preview.items.filter((i) => !i.sent).map((i) => (
            <p key={i.label} className="muted">
              {i.label}: {i.note}
            </p>
          ))}
        </div>
      )}
      <div className="ai-composer-actions">
        <Button type="submit" variant="primary" icon="play" disabled={!draft.trim() || sending}>
          {continuing ? 'Send' : mode === 'ask' ? 'Ask' : mode === 'plan' ? 'Make a plan' : 'Start task'}
        </Button>
      </div>
    </form>
  );
}

export function AssistantPanel() {
  const openTaskId = useAi((s) => s.openTaskId);
  const task = useAi((s) => (s.openTaskId ? (s.taskViews[s.openTaskId] ?? null) : null));
  const ai = useAi((s) => s.ai);
  const configured = Boolean(ai?.connections.length);
  return (
    <div className="ai-panel">
      <header className="ai-head">
        <h2>{task ? task.title : 'Assistant'}</h2>
        <IconButton icon="plus" label="New conversation" size="sm" onClick={newConversation} />
      </header>
      {!openTaskId && !configured && (
        <div className="ai-empty">
          <p>Connect a model to plan, build and edit with AI. Everything else in Multiverse Studio works without it.</p>
          <Button icon="settings" onClick={() => openDialog({ kind: 'settings', tab: 'providers' })}>
            Connect a provider
          </Button>
        </div>
      )}
      {!openTaskId && configured && <p className="ai-empty muted">Ask about this project, plan a change, or start a build task. The assistant sees the version you have selected.</p>}
      {task && <TaskStatus task={task} />}
      {task && <WorkingVersion task={task} />}
      {task && <Conversation task={task} />}
      {task && <Artifacts task={task} />}
      {task && <Approval task={task} />}
      <Composer task={task} />
    </div>
  );
}
