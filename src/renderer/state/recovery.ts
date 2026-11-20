/**
 * After a project opens: collect work that stopped when the app last closed (AI tasks, media jobs,
 * video exports, publishes) so it can be reviewed and retried. Nothing is restarted automatically.
 */
import { create } from 'zustand';
import { call } from '../lib/api';
import { openDialog, toast } from './store';

export interface RecoveryItem {
  id: string;
  type: 'task' | 'media' | 'export' | 'deploy' | 'story';
  title: string;
  state: string;
  detail: string;
  /** Paid request whose result is unknown: retrying needs an explicit confirmation. */
  uncertain: boolean;
  lineId?: string;
}

export const useRecovery = create<{ projectId: string | null; items: RecoveryItem[] }>(() => ({ projectId: null, items: [] }));

const reviewed = new Set<string>();

export async function checkRecovery(projectId: string): Promise<void> {
  const safe = <T,>(p: Promise<T[]>): Promise<T[]> => p.catch(() => [] as T[]);
  const [tasks, media, exports, deploys, runs] = await Promise.all([safe(call('ai.tasks.list', { projectId })), safe(call('media.jobs.list', { projectId })), safe(call('video.export.list', { projectId })), safe(call('publish.list', { projectId })), safe(call('stories.runs', { projectId }))]);
  // Only the latest run of each story in each version matters: a later run supersedes an interrupted one.
  const latestRuns = runs.filter((r, i) => runs.findIndex((x) => x.storyId === r.storyId && x.lineId === r.lineId) === i);
  const items: RecoveryItem[] = [
    ...tasks.filter((t) => t.state === 'interrupted').map((t) => ({ id: t.id, type: 'task' as const, title: t.title, state: 'Interrupted', detail: 'The task stopped when the app closed. Changes it already made are kept in its alternative.', uncertain: false })),
    ...media
      .filter((j) => j.state === 'interrupted' || j.state === 'uncertain')
      .map((j) => ({ id: j.id, type: 'media' as const, title: j.title, state: j.state === 'uncertain' ? 'Result unknown' : 'Interrupted', detail: j.error ?? j.detail, uncertain: j.state === 'uncertain' })),
    ...exports.filter((e) => e.state === 'interrupted').map((e) => ({ id: e.id, type: 'export' as const, title: `Export of ${e.sequenceName}`, state: 'Interrupted', detail: 'The partial file was discarded. Export again from Video.', uncertain: false })),
    ...deploys
      .filter((d) => d.state === 'interrupted' || d.state === 'uncertain')
      .map((d) => ({ id: d.id, type: 'deploy' as const, title: `Publish ${d.lineName} to ${d.targetName}`, state: d.state === 'uncertain' ? 'Result unknown' : 'Interrupted', detail: d.error ?? d.detail, uncertain: d.state === 'uncertain', lineId: d.lineId })),
    ...latestRuns
      .filter((r) => r.interrupted)
      .map((r) => ({ id: r.id, type: 'story' as const, title: `${r.mode === 'recording' ? 'Recording' : 'Test run'} of “${r.storyName}”`, state: 'Interrupted', detail: `The browser run in ${r.lineName} stopped when the app closed. Nothing was recorded or marked as passing. Run it again from Stories.`, uncertain: false, lineId: r.lineId })),
  ];
  useRecovery.setState({ projectId, items });
  const fresh = items.filter((i) => !reviewed.has(`${i.type}:${i.id}`));
  if (fresh.length === 0) return;
  for (const i of fresh) reviewed.add(`${i.type}:${i.id}`);
  toast({
    tone: 'warning',
    title: fresh.length === 1 ? 'One job was interrupted' : `${fresh.length} jobs were interrupted`,
    body: 'The app closed while they were running. Your files and history are intact; nothing was restarted.',
    action: { label: 'Review', run: () => openDialog({ kind: 'recovery' }) },
    sticky: true,
  });
}

export function dismissRecovery(item: RecoveryItem): void {
  useRecovery.setState((s) => ({ items: s.items.filter((i) => !(i.id === item.id && i.type === item.type)) }));
}
