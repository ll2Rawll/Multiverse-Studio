/** Publishing: destinations (no tokens ever reach the renderer) and deploy jobs per project. */
import { create } from 'zustand';
import { call, errorMessage } from '../lib/api';
import { toast } from './store';
import type { DeployJobView, PublishTargetView } from '../../shared/publish';
import type { StudioEvent } from '../../shared/types';

export interface PublishUi {
  targets: PublishTargetView[] | null;
  /** projectId → jobs, newest first. */
  jobs: Record<string, DeployJobView[]>;
}

export const usePublish = create<PublishUi>(() => ({ targets: null, jobs: {} }));
const setP = usePublish.setState;

export const ACTIVE_DEPLOY = new Set(['queued', 'packaging', 'uploading', 'processing', 'cancelling']);

export async function loadTargets(): Promise<void> {
  try {
    setP({ targets: await call('publish.targets.list', {}) });
  } catch (error) {
    setP({ targets: [] });
    toast({ tone: 'error', title: 'Couldn’t load publishing destinations', body: errorMessage(error) });
  }
}

export async function loadJobs(projectId: string): Promise<void> {
  try {
    const list = await call('publish.list', { projectId });
    setP((s) => ({ jobs: { ...s.jobs, [projectId]: list } }));
  } catch {
    /* the dialog shows an empty list */
  }
}

function upsert(projectId: string, job: DeployJobView): void {
  setP((s) => {
    const list = s.jobs[projectId] ?? [];
    const next = list.some((j) => j.id === job.id) ? list.map((j) => (j.id === job.id ? job : j)) : [job, ...list];
    return { jobs: { ...s.jobs, [projectId]: next } };
  });
}

const announced = new Set<string>();

export function openUrl(url: string): void {
  void call('shell.openUrl', { url }).catch((error) => toast({ tone: 'error', title: 'Couldn’t open the address', body: errorMessage(error) }));
}

export function handlePublishEvent(event: StudioEvent): void {
  if (event.type !== 'publish-job') return;
  const { job } = event;
  upsert(event.projectId, job);
  const key = `${job.id}:${job.state}`;
  if (announced.has(key)) return;
  announced.add(key);
  if (job.state === 'completed' && job.url) {
    const url = job.url;
    toast({ tone: 'success', title: `Published ${job.lineName}`, body: `${job.targetName} confirmed the deploy: ${url}`, action: { label: 'Open site', run: () => openUrl(url) }, sticky: true });
  } else if (job.state === 'failed') {
    toast({ tone: 'error', title: `Publishing ${job.lineName} failed`, body: job.error ?? job.detail, sticky: true });
  } else if (job.state === 'uncertain') {
    toast({ tone: 'warning', title: 'Publish result unknown', body: job.detail, sticky: true });
  }
}

export async function jobAction(projectId: string, jobId: string, action: 'cancel' | 'check' | 'retry', confirmUncertain = false): Promise<void> {
  try {
    const job =
      action === 'cancel'
        ? await call('publish.cancel', { projectId, jobId })
        : action === 'check'
          ? await call('publish.check', { projectId, jobId })
          : await call('publish.retry', { projectId, jobId, confirmUncertain });
    upsert(projectId, job);
  } catch (error) {
    toast({ tone: 'error', title: action === 'retry' ? 'Couldn’t publish again' : action === 'cancel' ? 'Couldn’t stop it' : 'Couldn’t check', body: errorMessage(error) });
  }
}
