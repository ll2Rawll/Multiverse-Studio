import { BuildService } from '../build/service';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import type { StudioService } from './studio';
import type { StudioEvent } from '../shared/types';
import { StudioError } from '../engine/errors';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

export function createBuildRuntime(studio: StudioService, emit: (event: StudioEvent) => void, cacheRoot: string | null): { build: BuildService | null; handlers: Handlers } {
  const build = cacheRoot ? new BuildService({ engine: (id) => studio.engine(id), emit, changed: (engine, reason, lineIds) => studio.changed(engine, reason, lineIds) }, cacheRoot) : null;
  const need = (): BuildService => {
    if (!build) throw new StudioError('unavailable', 'Running commands is not available in this window.');
    return build;
  };
  const handlers: Handlers = {
    'build.state': async ({ projectId, lineId }) => need().state(projectId, lineId),
    'build.run': async ({ projectId, lineId, command }) => need().run(projectId, lineId, command),
    'build.script': async ({ projectId, lineId, script }) => need().runScript(projectId, lineId, script),
    'build.install': async ({ projectId, lineId }) => need().install(projectId, lineId),
    'build.devServer': async ({ projectId, lineId }) => need().startDevServer(projectId, lineId),
    'build.stop': async ({ projectId, processId }) => need().stop(projectId, processId),
    'build.output': async ({ projectId, processId }) => need().output(projectId, processId),
    'build.collect': async ({ projectId, lineId }) => need().collect(projectId, lineId),
  };
  return { build, handlers };
}
