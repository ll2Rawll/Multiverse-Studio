/** IPC for Settings → AI apps. */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { StudioService } from '../services/studio';
import { StudioError } from '../engine/errors';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };
import { buildExtension } from './extension';

export const APP_VERSION = '0.2.0';

export function createConnectorHandlers(studio: StudioService, resourcesRoot: string): Handlers {
  const c = () => {
    if (!studio.connector) throw new StudioError('unsupported', 'Connecting AI apps is not available here.');
    return studio.connector;
  };
  return {
    'connector.state': async () => c().state(),
    'connector.setEnabled': async ({ enabled }) => c().setEnabled(enabled),
    'connector.setPublicUrl': async ({ url }) => c().setPublicUrl(url),
    'connector.tunnel.start': async () => c().startTunnel(),
    'connector.tunnel.stop': async () => c().stopTunnel(),
    'connector.decide': async ({ id, allow }) => c().decide(id, allow),
    'connector.revoke': async ({ appId }) => c().revoke(appId),
    'connector.hold': async ({ app, held, projectId }) => c().hold(app, held, projectId ?? null),
    'connector.extension.save': async ({ destination }) => {
      c();
      const file = destination ?? path.join(os.homedir(), 'Downloads', 'Multiverse Studio.mcpb');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, await buildExtension(resourcesRoot, APP_VERSION));
      // A copy of the bridge outside the app bundle, for apps configured with a command instead.
      const bridge = path.join(os.homedir(), '.multiverse-studio', 'bridge.mjs');
      await fs.mkdir(path.dirname(bridge), { recursive: true, mode: 0o700 });
      await fs.copyFile(path.join(resourcesRoot, 'connector', 'bridge.mjs'), bridge);
      return { file, bridge, config: JSON.stringify({ mcpServers: { 'multiverse-studio': { command: 'node', args: [bridge] } } }, null, 2) };
    },
  };
}
