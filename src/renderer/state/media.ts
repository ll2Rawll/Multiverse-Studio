/** AI media jobs, transcripts, brand settings and shared-media status for the open project. */
import { create } from 'zustand';
import { call, errorMessage, ApiError } from '../lib/api';
import { toast, openDialog } from './store';
import { refreshMedia } from './video';
import type { BrandSettingsView, MediaJobKind, MediaJobPlan, MediaJobView } from '../../shared/media';
import type { ChannelInput } from '../../shared/ipc';
import type { StudioEvent } from '../../shared/types';

export type JobInput = ChannelInput<'media.jobs.start'>['job'];

interface MediaUiState {
  projectId: string | null;
  jobs: MediaJobView[];
  brand: BrandSettingsView | null;
  /** Bumped when media or brand-related state changes, so panels can refetch. */
  revision: number;
}

export const useMedia = create<MediaUiState>(() => ({ projectId: null, jobs: [], brand: null, revision: 0 }));
const setM = useMedia.setState;
const getM = useMedia.getState;

export const ACTIVE_JOB = new Set(['queued', 'submitting', 'running', 'downloading', 'cancelling']);

export const JOB_STATE_LABEL: Record<MediaJobView['state'], string> = {
  queued: 'Waiting',
  submitting: 'Sending',
  running: 'Working',
  downloading: 'Saving',
  cancelling: 'Stopping',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  uncertain: 'Check usage',
};

export const KIND_LABEL: Record<MediaJobKind, string> = { image: 'Image', video: 'Video', speech: 'Voice-over', transcription: 'Transcript', recording: 'Recording' };

export async function loadMediaJobs(projectId: string): Promise<void> {
  if (getM().projectId !== projectId) setM({ projectId, jobs: [], brand: null });
  try {
    const jobs = await call('media.jobs.list', { projectId });
    if (getM().projectId === projectId) setM({ jobs });
  } catch {
    // shown as an empty list
  }
}

export async function loadBrand(projectId: string): Promise<BrandSettingsView | null> {
  try {
    const brand = await call('brand.get', { projectId });
    if (getM().projectId === projectId || !getM().projectId) setM({ projectId, brand });
    return brand;
  } catch {
    return null;
  }
}

export async function saveBrand(projectId: string, brand: BrandSettingsView): Promise<boolean> {
  try {
    setM({ brand: await call('brand.set', { projectId, brand }) });
    return true;
  } catch (error) {
    toast({ tone: 'error', title: 'Could not save the brand', body: errorMessage(error) });
    return false;
  }
}

export async function planJob(projectId: string, job: JobInput): Promise<MediaJobPlan | string> {
  try {
    return await call('media.jobs.plan', { projectId, job });
  } catch (error) {
    return errorMessage(error);
  }
}

export async function startJob(projectId: string, job: JobInput): Promise<MediaJobView | null> {
  try {
    const view = await call('media.jobs.start', { projectId, job });
    upsert(view);
    return view;
  } catch (error) {
    toast({ tone: 'error', title: 'Could not start', body: errorMessage(error) });
    return null;
  }
}

export async function cancelJob(projectId: string, jobId: string): Promise<void> {
  try {
    upsert(await call('media.jobs.cancel', { projectId, jobId }));
  } catch (error) {
    toast({ tone: 'error', title: 'Could not stop the job', body: errorMessage(error) });
  }
}

/** Retrying an uncertain paid request asks the user to confirm they checked their provider first. */
export function retryJob(projectId: string, job: MediaJobView): void {
  const go = async (confirmUncertain: boolean): Promise<void> => {
    try {
      upsert(await call('media.jobs.retry', { projectId, jobId: job.id, confirmUncertain }));
      await loadMediaJobs(projectId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'confirm-needed') return;
      toast({ tone: 'error', title: 'Could not try again', body: errorMessage(error) });
    }
  };
  if (job.state === 'uncertain') {
    openDialog({
      kind: 'confirm',
      title: 'Send this request again?',
      body: `Multiverse Studio closed (or lost the connection) while ${job.connectionName ?? 'the provider'} was working on this request, and it gave no job id to check. It may already have finished and been charged. Check your provider’s usage page first. Sending again may create and bill a second result.`,
      confirmLabel: 'I checked — send again',
      destructive: true,
      onConfirm: () => go(true),
    });
  } else void go(false);
}

function upsert(job: MediaJobView): void {
  setM((s) => ({ jobs: s.jobs.some((j) => j.id === job.id) ? s.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...s.jobs] }));
}

export function handleMediaEvent(event: StudioEvent): void {
  if (event.type === 'media-job' && event.projectId === getM().projectId) {
    const before = getM().jobs.find((j) => j.id === event.job.id)?.state;
    upsert(event.job);
    const j = event.job;
    if (before !== j.state && j.state === 'completed') {
      toast({ tone: 'success', title: `${KIND_LABEL[j.kind]} ready`, body: j.detail });
      void refreshMedia();
      setM((s) => ({ revision: s.revision + 1 }));
    }
    if (before !== j.state && j.state === 'failed') toast({ tone: 'error', title: `${KIND_LABEL[j.kind]} failed`, body: j.error?.split('\n')[0] });
    if (before !== j.state && j.state === 'uncertain') toast({ tone: 'warning', title: 'Result unknown', body: j.error ?? undefined });
  }
  if ((event.type === 'media' || event.type === 'project-changed') && event.projectId === getM().projectId) setM((s) => ({ revision: s.revision + 1 }));
}
