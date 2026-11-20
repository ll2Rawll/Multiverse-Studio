import { useEffect } from 'react';
import { openTask, refreshTasks, useAi } from '../state/ai';
import { cx, relativeTime } from '../lib/util';
import { STATE_LABEL, costText, stateTone } from './format';

export function TasksPanel() {
  const tasks = useAi((s) => s.tasks);
  const openId = useAi((s) => s.openTaskId);
  useEffect(() => {
    void refreshTasks();
  }, []);
  return (
    <div className="ai-tasks">
      <header className="ai-head">
        <h2>Tasks</h2>
      </header>
      {tasks.length === 0 ? (
        <p className="ai-empty muted">AI tasks for this project appear here, with their status, model and usage. They are saved with the project.</p>
      ) : (
        <ul className="ai-task-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className={cx('ai-task-row', t.id === openId && 'is-open')} onClick={() => void openTask(t.id)}>
                <span className="ai-task-title">{t.title}</span>
                <span className="ai-task-meta">
                  <span className={cx('ai-state', `tone-${stateTone(t.state)}`)}>{STATE_LABEL[t.state]}</span>
                  <span>{t.mode === 'ask' ? 'Ask' : t.mode === 'plan' ? 'Plan' : 'Build'}</span>
                  <span>{relativeTime(t.updatedAt)}</span>
                </span>
                <span className="ai-task-meta muted">{costText(t.usage)}</span>
                {t.error && <span className="ai-task-error">{t.error.message}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
