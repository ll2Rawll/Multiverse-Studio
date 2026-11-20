/**
 * The Claude Desktop extension (.mcpb): a zip with a manifest and the zero-dependency bridge, which
 * Claude Desktop installs with one click. The bridge talks to this app's local endpoint; nothing
 * secret is inside the file (the token is read from the user's own folder at run time).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { connectorTools } from './tools';

export async function buildExtension(resourcesRoot: string, version: string): Promise<Buffer> {
  const zip = new JSZip();
  const manifest = {
    manifest_version: '0.3',
    name: 'multiverse-studio',
    display_name: 'Multiverse Studio',
    version,
    description: 'Use Multiverse Studio on this computer: create and edit websites, web apps and videos, and compare alternative versions.',
    long_description: 'Lets Claude use the Multiverse Studio desktop app with the same undoable commands as its buttons. Multiverse Studio must be installed; turn on Settings → AI apps there. Each app is approved in Multiverse Studio the first time, and risky actions ask there.',
    author: { name: 'Multiverse Studio' },
    icon: 'icon.png',
    server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } },
    tools: connectorTools().map((t) => ({ name: t.name, description: t.description })),
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=18.0.0' } },
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('server/index.js', await fs.readFile(path.join(resourcesRoot, 'connector', 'bridge.mjs')));
  zip.file('server/package.json', JSON.stringify({ type: 'module', private: true }, null, 2));
  const icon = await fs.readFile(path.join(resourcesRoot, 'icons', 'icon.png')).catch(() => null);
  if (icon) zip.file('icon.png', icon);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
