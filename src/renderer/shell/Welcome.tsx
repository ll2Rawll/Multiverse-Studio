import { useEffect, useState } from 'react';
import { useStudio } from '../state/store';
import { createFromTemplate, createSample, importProject, openProject, run, refreshRecent, setWorkspace } from '../state/actions';
import { loadAiState, setDraft, setMode, setPanel, useAi } from '../state/ai';
import { call, errorMessage } from '../lib/api';
import { Button, IconButton } from '../components/primitives';
import { Icon } from '../components/Icon';
import { relativeTime, plural, cx } from '../lib/util';
import { openDialog, toast } from '../state/store';
import { TemplateGallery } from './TemplateGallery';

export function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="logo-mark">
      <rect x="1" y="1" width="46" height="46" rx="14" className="logo-bg" />
      <circle cx="17" cy="24" r="7.5" className="logo-ring logo-a" />
      <circle cx="31" cy="18" r="7.5" className="logo-ring logo-b" />
      <circle cx="31" cy="30" r="7.5" className="logo-ring logo-c" />
    </svg>
  );
}

type StartPath = 'ai' | 'manual' | 'open';

const PATHS: { id: StartPath; title: string; body: string; icon: string }[] = [
  { id: 'ai', title: 'Start with AI', body: 'Connect a provider and describe what you want to make.', icon: 'wand' },
  { id: 'manual', title: 'Create manually', body: 'Pick a website, app or video template.', icon: 'brush' },
  { id: 'open', title: 'Open existing work', body: 'Import a project folder or media files.', icon: 'folder' },
];

const KIND_LABEL = { website: 'Websites', app: 'Apps', video: 'Video' } as const;

function StartWithAi() {
  const ai = useAi((s) => s.ai);
  const templates = useStudio((s) => s.templates);
  const [skipped, setSkipped] = useState(false);
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState('landing');
  const connected = (ai?.connections.length ?? 0) > 0;
  const create = async (): Promise<void> => {
    const ok = await createFromTemplate(templateId);
    if (!ok) return;
    // The task is prepared, not sent: the Assistant shows what would be sent and you press Send.
    setMode('build');
    setDraft(description.trim());
    setPanel('assistant');
  };
  return (
    <div className="start-panel" role="region" aria-label="Start with AI">
      <ol className="start-steps">
        <li className={cx('start-step', (connected || skipped) && 'is-done')}>
          <span className="start-step-title">Connect a provider</span>
          {connected ? (
            <span className="muted">
              <Icon name="check" size={12} /> {ai!.connections.map((c) => c.name).join(', ')}
            </span>
          ) : (
            <span className="start-step-actions">
              <Button size="sm" variant="primary" onClick={() => openDialog({ kind: 'settings', tab: 'providers' })}>
                Connect a provider…
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setSkipped(true)} aria-pressed={skipped}>
                Skip for now
              </Button>
            </span>
          )}
          {!connected && skipped && <span className="muted">You can describe the project now and connect a provider before sending it.</span>}
        </li>
        <li className="start-step">
          <label className="start-step-title" htmlFor="start-desc">
            Describe the project
          </label>
          <textarea id="start-desc" className="input" rows={3} value={description} maxLength={4000} placeholder="A site for a neighbourhood bakery with opening hours, a menu and a way to pre-order." onChange={(e) => setDescription(e.target.value)} />
          <div className="start-row">
            <label className="field-label" htmlFor="start-tpl">
              Start from
            </label>
            <select id="start-tpl" className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.stack})
                </option>
              ))}
            </select>
            <Button variant="primary" icon="wand" disabled={!description.trim() || (!connected && !skipped)} onClick={() => void create()}>
              Create project
            </Button>
          </div>
          <p className="field-hint">Creates the project from the template and prepares a Build task with your description. Nothing is sent until you review it and press Send.</p>
        </li>
      </ol>
    </div>
  );
}

function CreateManually() {
  const templates = useStudio((s) => s.templates);
  const kinds = (['website', 'app', 'video'] as const).filter((k) => templates.some((t) => t.kind === k));
  return (
    <div className="start-panel" role="region" aria-label="Create manually">
      {kinds.map((k) => (
        <section key={k} className="welcome-templates" aria-label={KIND_LABEL[k]}>
          <h2>{KIND_LABEL[k]}</h2>
          <TemplateGallery templates={templates.filter((t) => t.kind === k)} />
        </section>
      ))}
      <p className="welcome-note">
        Or{' '}
        <button type="button" className="link-button" onClick={() => void createSample()}>
          create the sample project
        </button>{' '}
        to look around.
      </p>
    </div>
  );
}

async function videoFromMedia(): Promise<void> {
  if (!(await createFromTemplate('launch-video', 'Video project'))) return;
  const project = useStudio.getState().project;
  if (!project) return;
  try {
    const r = await call('media.import', { projectId: project.id });
    setWorkspace('assets');
    if (r?.imported.length) toast({ tone: 'success', title: `Imported ${plural(r.imported.length, 'file')}`, body: 'Copied into the project. Drag them onto the timeline in Video.' });
    for (const f of r?.failed ?? []) toast({ tone: 'error', title: `Could not import ${f.name}`, body: f.reason });
  } catch (error) {
    toast({ tone: 'error', title: 'Could not import', body: errorMessage(error) });
  }
}

function OpenExisting() {
  const hasVideoTemplate = useStudio((s) => s.templates.some((t) => t.id === 'launch-video'));
  return (
    <div className="start-panel" role="region" aria-label="Open existing work">
      <div className="welcome-actions">
        <Button variant="primary" icon="folder" onClick={() => void importProject()}>
          Open a project folder…
        </Button>
        {hasVideoTemplate && (
          <Button icon="film" onClick={() => void videoFromMedia()}>
            New video from media files…
          </Button>
        )}
      </div>
      <p className="welcome-note">
        A project folder needs an <code>index.html</code> (a website) or a <code>package.json</code> with a dev script (an app). Your folder stays untouched — Multiverse Studio works on its own copy. Media files are copied into the project’s library.
      </p>
    </div>
  );
}

export function Welcome() {
  const recent = useStudio((s) => s.recent);
  const info = useStudio((s) => s.info);
  const [path, setPath] = useState<StartPath | null>(null);
  useEffect(() => {
    void loadAiState();
  }, []);
  return (
    <div className="welcome">
      <div className="welcome-drag drag-region" />
      <main className="welcome-card material-modal" aria-labelledby="welcome-title">
        <div className="welcome-hero">
          <LogoMark size={56} />
          <h1 id="welcome-title" data-text="Multiverse Studio">Multiverse Studio</h1>
          <p className="welcome-tagline">Explore different directions. Keep what works.</p>
        </div>
        <div className="start-paths" role="group" aria-label="How do you want to start?">
          {PATHS.map((p, i) => (
            <button key={p.id} type="button" className={cx('start-path', path === p.id && 'is-active')} aria-expanded={path === p.id} onClick={() => setPath(path === p.id ? null : p.id)} data-autofocus={i === 0 ? true : undefined}>
              <Icon name={p.icon} size={18} />
              <span className="start-path-title">{p.title}</span>
              <span className="start-path-body">{p.body}</span>
            </button>
          ))}
        </div>
        {path === 'ai' && <StartWithAi />}
        {path === 'manual' && <CreateManually />}
        {path === 'open' && <OpenExisting />}
        <section className="welcome-recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Recent projects</h2>
          {recent.length === 0 ? (
            <p className="muted">Projects you open will appear here.</p>
          ) : (
            <ul>
              {recent.map((r) => (
                <li key={r.id} className={cx('recent-item', !r.available && 'is-missing')}>
                  <button type="button" className="recent-open" disabled={!r.available} onClick={() => void openProject(r.id)}>
                    <span className="recent-icon">
                      <Icon name={r.available ? 'layers' : 'warning'} size={18} />
                    </span>
                    <span className="recent-text">
                      <span className="recent-name">{r.name}</span>
                      <span className="recent-meta">
                        {r.available ? `${plural(r.alternativeCount, 'alternative')} · opened ${relativeTime(r.lastOpenedAt)}` : r.problem}
                      </span>
                    </span>
                  </button>
                  <IconButton
                    icon="close"
                    size="sm"
                    label={`Remove ${r.name} from recent projects`}
                    onClick={() =>
                      openDialog({
                        kind: 'confirm',
                        title: `Remove “${r.name}” from Recent?`,
                        body: r.available ? 'The project stays in your workspace; it just won’t be listed here. Opening it again requires importing.' : 'The working copy could not be found. This only removes the entry from the list.',
                        confirmLabel: 'Remove',
                        onConfirm: async () => {
                          await run('Could not remove', () => call('projects.removeRecent', { projectId: r.id }));
                          await refreshRecent();
                        },
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        {info && (
          <footer className="welcome-foot">
            <span>Version {info.version}</span>
            <span aria-hidden="true">·</span>
            <span>Works offline. No account needed.</span>
          </footer>
        )}
      </main>
    </div>
  );
}
