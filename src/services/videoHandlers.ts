import path from 'node:path';
import { VideoService, type MediaVariant } from '../video/service';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import type { StudioService } from './studio';
import type { StudioEvent } from '../shared/types';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

export function createVideoRuntime(
  studio: StudioService,
  emit: (event: StudioEvent) => void,
  options: { cacheRoot: string; resourcesRoot: string; mediaUrl?: (projectId: string, assetId: string, variant: MediaVariant, version: string) => string },
): { video: VideoService; handlers: Handlers } {
  const video = new VideoService(
    {
      engine: (id) => studio.engine(id),
      emit,
      mediaUrl: options.mediaUrl ?? ((projectId, assetId, variant, version) => `mvmedia://${projectId}/${assetId}/${variant}?v=${version}`),
    },
    { cacheRoot: options.cacheRoot, resourcesRoot: options.resourcesRoot },
  );
  const handlers: Handlers = {
    'video.tools': async () => video.toolsView(),
    'media.list': async ({ projectId, lineId }) => video.listMedia(projectId, lineId ?? null),
    'media.import': async ({ projectId, paths }) => (paths && paths.length ? video.importMedia(projectId, paths.map((p) => path.resolve(p))) : null),
    'media.relink': async ({ projectId, assetId, path: file }) => (file ? video.relink(projectId, assetId, path.resolve(file)) : null),
    'media.waveform': async ({ projectId, assetId }) => video.waveform(projectId, assetId),
    'sequences.list': async ({ projectId, lineId }) => (await video.sequences(projectId, lineId)).map((s) => s.summary),
    'sequences.get': async ({ projectId, lineId, sequenceId }) => video.sequence(projectId, lineId, sequenceId),
    'video.export.start': async ({ projectId, lineId, sequenceId, settings, destination }) => (destination === null ? null : video.startExport(projectId, lineId, sequenceId, settings, destination ?? null)),
    'video.export.list': async ({ projectId }) => video.listExports(projectId),
    'video.export.cancel': async ({ projectId, jobId }) => video.cancelExport(projectId, jobId),
    // Opening a folder needs the desktop shell, which handles this channel itself.
    'video.export.reveal': async () => false,
  };
  return { video, handlers };
}
