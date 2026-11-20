/**
 * Persistent task records (one JSON file per task under `<project>/ai/tasks/`). Tasks are state
 * machines; anything that was active when the app stopped is marked `interrupted` on reopen so
 * the user can retry deliberately. Records are redacted before they are written.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ACTIVE_TASK_STATES, type TaskSummary, type TaskView } from '../shared/ai';
import { writeFileAtomic } from '../engine/store/atomic';
import { redactor } from './redact';

const ID = /^task-[a-z0-9-]{6,64}$/;

export function summarize(task: TaskView): TaskSummary {
  const { id, projectId, title, mode, job, state, createdAt, updatedAt, route, usage, error } = task;
  return { id, projectId, title, mode, job, state, createdAt, updatedAt, route, usage, error };
}

export class TaskStore {
  constructor(readonly dir: string) {}

  private file(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid task id');
    return path.join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<TaskView | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as TaskView;
    } catch {
      return null;
    }
  }

  async save(task: TaskView): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.file(task.id), JSON.stringify(redactor.redactValue(task)));
  }

  async list(limit = 200): Promise<TaskSummary[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json') && ID.test(n.slice(0, -5)));
    } catch {
      return [];
    }
    const out: TaskSummary[] = [];
    for (const name of names) {
      const task = await this.get(name.slice(0, -5));
      if (task) out.push(summarize(task));
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  /** Mark tasks that were active when the app stopped as interrupted. Returns their ids. */
  async recover(isRunningHere: (id: string) => boolean): Promise<string[]> {
    const changed: string[] = [];
    for (const summary of await this.list(10_000)) {
      if (!ACTIVE_TASK_STATES.includes(summary.state) || isRunningHere(summary.id)) continue;
      const task = await this.get(summary.id);
      if (!task) continue;
      const now = new Date().toISOString();
      task.state = 'interrupted';
      task.updatedAt = now;
      task.error = { kind: 'internal', message: 'Multiverse Studio stopped while this task was running. Nothing was resubmitted automatically.' };
      for (const step of task.steps) if (step.status === 'running' || step.status === 'waiting') Object.assign(step, { status: 'cancelled', endedAt: now, detail: `${step.detail} (interrupted)`.trim() });
      for (const m of task.messages) if (m.partial) m.partial = false;
      await this.save(task);
      changed.push(task.id);
    }
    return changed;
  }
}
