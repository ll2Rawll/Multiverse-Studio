/**
 * stories.* file commands (undoable, shared by the interface and the director): create and edit a
 * story, and put a recorded run into a timeline with editable chapter titles, captions and
 * narration lines.
 */
import { z } from 'zod';
import { CommandError, type CommandDefinition, type CommandRegistry, type FileChanges } from '../commands/commands';
import { storyPath, type Story } from '../shared/stories';
import { applyVideoCommand, parseSequence, sequencePath } from '../video/sequence';
import { TICKS_PER_SECOND } from '../shared/video';
import { walkthroughCommand } from './walkthrough';
import { DEFAULT_TIMING, fixturesSchema, parseStory, serializeStory, stepSchema, storyId, timingSchema, viewportSchema } from './model';

const S = TICKS_PER_SECOND;
const seqId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const def = <A>(d: CommandDefinition<A>): CommandDefinition<A> => d;

const fields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  page: z.string().min(1).max(400),
  viewport: viewportSchema,
  fixtures: fixturesSchema,
  steps: z.array(stepSchema).max(300),
  timing: timingSchema,
  dependsOn: z.array(z.string().min(1).max(400)).max(500).nullable(),
};

const marker = z.object({ kind: z.enum(['chapter', 'annotate', 'narrate']), atMs: z.number().int().min(0), text: z.string().min(1).max(500), subtitle: z.string().max(300).optional(), seconds: z.number().min(0.5).max(30).optional() });

export const storyCommands = [
  def({
    name: 'stories.create',
    schema: z.object({ story: storyId, name: fields.name, page: fields.page, description: fields.description.optional(), viewport: fields.viewport.optional(), fixtures: fields.fixtures.optional(), steps: fields.steps.optional(), timing: fields.timing.optional() }),
    scope: (a) => `story:${a.story}`,
    label: (a) => `Create story “${a.name}”`,
    files: (a) => [storyPath(a.story)],
    apply: (files, a) => {
      if (files.get(storyPath(a.story)) != null) throw new CommandError(`A story with the id “${a.story}” already exists.`);
      const story: Story = { format: 'multiverse-story', version: 1, id: a.story, name: a.name, description: a.description ?? '', page: a.page, viewport: a.viewport ?? { width: 1280, height: 720 }, fixtures: a.fixtures ?? {}, steps: (a.steps ?? []) as Story['steps'], timing: a.timing ?? DEFAULT_TIMING, dependsOn: null };
      const text = serializeStory(story);
      parseStory(text, storyPath(a.story));
      return new Map([[storyPath(a.story), text]]);
    },
  }),
  def({
    name: 'stories.update',
    schema: z.object({ story: storyId, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) }) as unknown as z.ZodType<{ story: string } & Partial<Omit<Story, 'id' | 'format' | 'version'>>>,
    scope: (a) => `story:${a.story}`,
    label: () => 'Edit story',
    files: (a) => [storyPath(a.story)],
    apply: (files, a) => {
      const text = files.get(storyPath(a.story));
      if (text == null) throw new CommandError(`There is no story “${a.story}” in this version.`);
      let story: Story;
      try {
        story = parseStory(text, storyPath(a.story));
      } catch (error) {
        throw new CommandError((error as Error).message);
      }
      const { story: _id, ...patch } = a;
      const next = { ...story, ...patch } as Story;
      const out = serializeStory(next);
      try {
        parseStory(out, storyPath(a.story));
      } catch (error) {
        throw new CommandError((error as Error).message);
      }
      return new Map([[storyPath(a.story), out]]);
    },
  }),
  def({
    name: 'stories.addToSequence',
    schema: z.object({
      sequence: seqId,
      assetId: z.string().min(1).max(128),
      /** Length of the recording in seconds (from the media library). */
      assetSeconds: z.number().min(0.1).max(3600),
      start: z.number().int().min(0),
      markers: z.array(marker).max(200),
    }),
    scope: (a) => `video:${a.sequence}`,
    label: () => 'Add story recording to the timeline',
    files: (a) => [sequencePath(a.sequence)],
    apply: (files, a) => {
      const p = sequencePath(a.sequence);
      let current = new Map<string, string | null>([[p, files.get(p) ?? null]]);
      if (current.get(p) == null) throw new CommandError('That sequence does not exist in this version.');
      const step = (name: string, args: Record<string, unknown>): void => {
        current = applyVideoCommand(current, name, { sequence: a.sequence, ...args }).files as Map<string, string | null>;
      };
      const dur = Math.round(a.assetSeconds * S);
      const seq = () => parseSequence(current.get(p)!);
      if (!seq().tracks.some((t) => t.kind === 'video')) step('video.addTrack', { kind: 'video' });
      step('video.addClip', { assetId: a.assetId, media: { kind: 'video', duration: dur }, start: a.start, in: 0, out: dur });
      // Titles and captions go on their own tracks so they never collide with existing titles.
      const tracks = (): Set<string> => new Set(seq().tracks.map((t) => t.id));
      const addTextTrack = (name: string): string => {
        const before = tracks();
        step('video.addTrack', { kind: 'text' });
        const id = [...tracks()].find((t) => !before.has(t))!;
        step('video.setTrack', { trackId: id, patch: { name } });
        return id;
      };
      const titles = a.markers.filter((m) => m.kind !== 'narrate').sort((x, y) => x.atMs - y.atMs);
      const captions = a.markers.filter((m) => m.kind === 'narrate').sort((x, y) => x.atMs - y.atMs);
      const place = (list: typeof titles, trackId: string): void => {
        list.forEach((m, i) => {
          const at = a.start + Math.round((m.atMs / 1000) * S);
          const want = Math.round((m.seconds ?? (m.kind === 'chapter' ? 1.6 : Math.max(1.2, Math.min(8, m.text.split(/\s+/).length / 2.6)))) * S);
          const next = list[i + 1] ? a.start + Math.round((list[i + 1]!.atMs / 1000) * S) : a.start + dur;
          const duration = Math.max(S / 4, Math.min(want, next - at, a.start + dur - at));
          if (duration <= 0) return;
          step('video.addText', { trackId, start: at, duration, text: m.text, ...(m.subtitle ? { subtitle: m.subtitle } : {}), template: m.kind === 'chapter' ? 'title-card' : m.kind === 'annotate' ? 'lower-third' : 'plain' });
        });
      };
      if (titles.length) place(titles, addTextTrack('Story titles'));
      if (captions.length) place(captions, addTextTrack('Story narration'));
      const out: FileChanges = new Map([[p, current.get(p)!]]);
      return out;
    },
  }),
];

export function registerStoryCommands(registry: CommandRegistry): void {
  for (const d of storyCommands) registry.register(d as CommandDefinition<unknown>);
  registry.register(walkthroughCommand as CommandDefinition<unknown>);
}
