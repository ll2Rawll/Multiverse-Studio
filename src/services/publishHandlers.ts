/** IPC handlers for publishing (targets, plans, deploy jobs). */
import path from 'node:path';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import type { StudioEvent } from '../shared/types';
import type { StudioService } from './studio';
import type { SecretVault } from '../ai/vault';
import { PublishService } from '../publish/service';
import { StudioError } from '../engine/errors';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

export function createPublishRuntime(
  studio: StudioService,
  emit: (event: StudioEvent) => void,
  options: { vault: SecretVault | null; settingsFile: string; fetch?: typeof fetch; pollMs?: number },
): { service: PublishService; handlers: Handlers } {
  const service = new PublishService({
    settingsFile: options.settingsFile,
    vault: options.vault,
    fetch: options.fetch,
    pollMs: options.pollMs,
    emit,
    projectDir: async (projectId) => (await studio.engine(projectId)).dir,
    files: async (projectId, lineId, revision) => {
      const engine = await studio.engine(projectId);
      const line = engine.line(lineId);
      const tree = revision ? await engine.treeOfRevision(revision) : await engine.effectiveTree(lineId);
      return { tree, read: (h) => engine.readBlob(h), lineName: line.kind === 'shared' ? 'Shared' : line.name, revision: revision ?? line.head, draft: !revision && Boolean(line.draftTree) };
    },
  });
  const folder = (f: string | undefined): string => {
    const v = (f ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (v && (v.includes('..') || path.posix.isAbsolute(v) || !/^[A-Za-z0-9._/-]+$/.test(v))) throw new StudioError('invalid', 'Choose a folder inside the version.');
    return v;
  };
  const handlers: Handlers = {
    'publish.targets.list': async () => service.listTargets(),
    'publish.targets.save': async (input) => service.saveTarget(input),
    'publish.targets.remove': async ({ id }) => {
      await service.removeTarget(id);
      return true;
    },
    'publish.plan': async ({ projectId, lineId, targetId, folder: f }) => service.plan(projectId, lineId, targetId, folder(f)),
    'publish.start': async ({ projectId, lineId, targetId, folder: f }) => service.start(projectId, lineId, targetId, folder(f)),
    'publish.list': async ({ projectId }) => service.list(projectId),
    'publish.cancel': async ({ projectId, jobId }) => service.cancel(projectId, jobId),
    'publish.check': async ({ projectId, jobId }) => service.check(projectId, jobId),
    'publish.retry': async ({ projectId, jobId, confirmUncertain }) => service.retry(projectId, jobId, confirmUncertain),
  };
  return { service, handlers };
}
