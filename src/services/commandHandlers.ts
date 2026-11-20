/**
 * IPC handlers for the unified command layer and the Design workspace.
 * The renderer always acts as `user`; AI tasks call the same commands with actor `ai-task`.
 */
import { z } from 'zod';
import type { ChannelInput, ChannelName, ChannelOutput } from '../shared/ipc';
import { SHARED_LINE_ID } from '../shared/types';
import type { DesignPageView } from '../shared/design';
import { CommandRegistry, CommandService } from '../commands/commands';
import { registerDesignCommands, DESIGN_CSS } from '../design/commands';
import { registerVideoCommands } from '../video/sequence';
import { registerBrandCommands } from '../video/brand';
import { registerAssetCommands } from '../video/links';
import { registerDependencyCommands } from './dependencies';
import { registerCodeCommands } from '../commands/patch';
import { registerObjectCommands } from '../objects/commands';
import { registerStoryCommands } from '../stories/commands';
import { outline } from '../design/markup';
import { readDesignCss, readTheme } from '../design/styles';
import { SECTION_LIBRARY } from '../design/library';
import type { StudioService } from './studio';
import type { ProjectEngine } from '../engine/project';

type Handlers = { [C in ChannelName]?: (input: ChannelInput<C>) => Promise<ChannelOutput<C>> };

export function createCommandLayer(): { registry: CommandRegistry; commands: CommandService } {
  const registry = new CommandRegistry();
  registerDesignCommands(registry);
  registerVideoCommands(registry);
  registerBrandCommands(registry);
  registerAssetCommands(registry);
  registerDependencyCommands(registry);
  registerCodeCommands(registry);
  registerObjectCommands(registry);
  registerStoryCommands(registry);
  return { registry, commands: new CommandService(registry) };
}

async function text(engine: ProjectEngine, tree: Map<string, string>, p: string): Promise<string | null> {
  const h = tree.get(p);
  return h ? (await engine.readBlob(h)).toString('utf8') : null;
}

export function createCommandHandlers(studio: StudioService, commands: CommandService): Handlers {
  const describe = async (projectId: string, lineId: string, page: string): Promise<DesignPageView> => {
    const engine = await studio.engine(projectId);
    const tree = await engine.effectiveTree(lineId);
    const pages = [...tree.keys()].filter((p) => /\.html?$/i.test(p) && !p.startsWith('components/')).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
    const images = [...tree.keys()].filter((p) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(p)).sort();
    const components = [...tree.keys()].filter((p) => /^components\/[a-z0-9-]+\.html$/.test(p)).map((p) => p.slice(11, -5));
    const source = await text(engine, tree, page);
    const css = await text(engine, tree, DESIGN_CSS);
    let themeSheet: string | null = null;
    let tokens: { name: string; value: string }[] = [];
    const cssFiles = [...tree.keys()].filter((p) => p.endsWith('.css')).sort((a, b) => (a.endsWith('theme.css') ? -1 : b.endsWith('theme.css') ? 1 : a.localeCompare(b)));
    for (const f of cssFiles) {
      const t = readTheme(await text(engine, tree, f));
      if (t.length) {
        themeSheet = f;
        tokens = t;
        break;
      }
    }
    const view = source === null ? { title: '', supported: false, reason: `${page} does not exist in this version.`, sections: [] } : outline(source);
    const state = await commands.state(engine, lineId, `design:${page}`);
    return {
      page,
      ...view,
      pages,
      components,
      images,
      styles: readDesignCss(css).styles,
      theme: { stylesheet: themeSheet, tokens },
      library: SECTION_LIBRARY.map(({ kind, label, description }) => ({ kind, label, description })),
      hashes: { [page]: tree.get(page) ?? null, [DESIGN_CSS]: tree.get(DESIGN_CSS) ?? null, ...(themeSheet ? { [themeSheet]: tree.get(themeSheet) ?? null } : {}) },
      undo: state.undo,
      redo: state.redo,
    };
  };

  return {
    'design.describe': async ({ projectId, lineId, page }) => describe(projectId, lineId, page),
    'commands.run': async ({ projectId, lineId, name, args, expected }) => {
      const engine = await studio.engine(projectId);
      const result = await commands.run(engine, lineId, name, args, { actor: 'user', expected });
      await studio.changed(engine, 'command', [lineId === SHARED_LINE_ID ? SHARED_LINE_ID : lineId]);
      const state = await commands.state(engine, lineId, result.record.scope);
      return { label: result.record.label, hashes: result.hashes, undo: state.undo, redo: state.redo };
    },
    'commands.state': async ({ projectId, lineId, scope }) => commands.state(await studio.engine(projectId), lineId, scope),
    'commands.step': async ({ projectId, lineId, scope, direction }) => {
      const engine = await studio.engine(projectId);
      const record = await commands.step(engine, lineId, scope, direction);
      if (record) await studio.changed(engine, direction, [lineId]);
      const state = await commands.state(engine, lineId, scope);
      return { label: record?.label ?? null, undo: state.undo, redo: state.redo };
    },
  };
}

export const commandSchemas = {
  'design.describe': z.object({ projectId: z.string().min(1).max(128), lineId: z.string().min(1).max(128), page: z.string().min(1).max(400) }),
};
