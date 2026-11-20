import { useStudio, openDialog } from '../state/store';
import { importProject, openProject, setWorkspace } from '../state/actions';
import { useAi, openTask } from '../state/ai';
import { Button } from '../components/primitives';
import { Icon } from '../components/Icon';
import { TemplateGallery } from '../shell/TemplateGallery';
import { STATE_LABEL, stateTone } from '../assistant/format';
import { cx, plural, relativeTime } from '../lib/util';
import type { Workspace } from '../state/store';

function Jump({ icon, title, body, to }: { icon: string; title: string; body: string; to: Workspace }) {
  return (
    <button type="button" className="home-jump" onClick={() => setWorkspace(to)}>
      <Icon name={icon} size={20} />
      <span className="home-jump-title">{title}</span>
      <span className="home-jump-body">{body}</span>
    </button>
  );
}

export function Home() {
  const project = useStudio((s) => s.project)!;
  const recent = useStudio((s) => s.recent);
  const templates = useStudio((s) => s.templates);
  const tasks = useAi((s) => s.tasks);
  const template = templates.find((t) => t.id === project.templateId);
  const origin = project.sourceKind === 'template' ? `Started from the ${template?.name ?? project.templateId} template` : project.sourceKind === 'sample' ? 'Sample project' : 'Imported folder';
  const kindLabel = project.kind === 'app' ? 'App' : project.kind === 'video' ? 'Video' : project.kind === 'mixed' ? 'Mixed' : 'Website';
  const others = recent.filter((r) => r.id !== project.id).slice(0, 5);

  return (
    <div className="home">
      <div className="workspace-bar">
        <h1 className="workspace-title" data-text="Home">
          Home
        </h1>
      </div>
      <div className="home-scroll">
        <section className="home-project" aria-labelledby="home-project-name">
          <div className="home-project-head">
            <h2 id="home-project-name">{project.name}</h2>
            <span className="kind-chip">{kindLabel}</span>
          </div>
          <p className="muted">
            {origin} · {plural(project.alternatives.length, 'alternative')} · updated {relativeTime(project.updatedAt)}
          </p>
          <div className="home-jumps">
            <Jump icon="code" title="Build" body={project.kind === 'app' ? 'Code, terminal and the running app' : 'Code with a live preview'} to="build" />
            {project.kind !== 'app' && <Jump icon="brush" title="Design" body="Edit pages visually; the source stays the truth" to="design" />}
            <Jump icon="film" title="Video" body="Cut footage on a timeline and export" to="video" />
            <Jump icon="multiverse" title="Multiverse" body="Try directions side by side and combine them" to="explore" />
          </div>
        </section>

        <section className="home-section" aria-labelledby="home-tasks">
          <div className="home-section-head">
            <h2 id="home-tasks">Recent AI tasks</h2>
          </div>
          {tasks.length === 0 ? (
            <p className="muted">Ask the Assistant (in the right panel) to explain, plan or build something. Its tasks appear here.</p>
          ) : (
            <ul className="home-list">
              {tasks.slice(0, 5).map((t) => (
                <li key={t.id}>
                  <button type="button" className="home-row" onClick={() => void openTask(t.id)}>
                    <span className="home-row-title">{t.title}</span>
                    <span className={cx('ai-state', `tone-${stateTone(t.state)}`)}>{STATE_LABEL[t.state]}</span>
                    <span className="muted small">{relativeTime(t.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="home-section" aria-labelledby="home-new">
          <div className="home-section-head">
            <h2 id="home-new">Start something new</h2>
            <span className="bar-spacer" />
            <Button size="sm" variant="quiet" icon="folder" onClick={() => void importProject()}>
              Open folder…
            </Button>
          </div>
          <TemplateGallery />
        </section>

        {others.length > 0 && (
          <section className="home-section" aria-labelledby="home-recent">
            <div className="home-section-head">
              <h2 id="home-recent">Other projects</h2>
            </div>
            <ul className="home-list">
              {others.map((r) => (
                <li key={r.id}>
                  <button type="button" className="home-row" disabled={!r.available} onClick={() => void openProject(r.id)}>
                    <span className="home-row-title">{r.name}</span>
                    <span className="muted small">{r.available ? `opened ${relativeTime(r.lastOpenedAt)}` : r.problem}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="muted small home-foot">
          <button type="button" className="link-btn" onClick={() => openDialog({ kind: 'project-info' })}>
            Project details
          </button>
        </p>
      </div>
    </div>
  );
}
