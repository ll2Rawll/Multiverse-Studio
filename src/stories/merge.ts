/**
 * Three-way merge of story files by step: steps are matched by id, so two universes that each add,
 * edit or remove different steps combine without a line merge of JSON. Returns null when the same
 * thing was changed differently on both sides (the file is then chosen as a whole).
 */
import { STORY_DIR, type Story, type StoryStep } from '../shared/stories';
import { parseStory, serializeStory } from './model';

export const isStoryPath = (path: string): boolean => path.startsWith(`${STORY_DIR}/`) && path.endsWith('.mvstory.json');

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const CONFLICT = Symbol('conflict');

function pick<T>(base: T | undefined, ours: T | undefined, theirs: T | undefined): T | undefined | typeof CONFLICT {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  return CONFLICT;
}

function mergeSteps(base: StoryStep[], ours: StoryStep[], theirs: StoryStep[]): StoryStep[] | null {
  const b = new Map(base.map((s) => [s.id, s]));
  const o = new Map(ours.map((s) => [s.id, s]));
  const t = new Map(theirs.map((s) => [s.id, s]));
  const result = new Map<string, StoryStep>();
  for (const id of new Set([...o.keys(), ...t.keys(), ...b.keys()])) {
    const v = pick(b.get(id), o.get(id), t.get(id));
    if (v === CONFLICT) return null;
    if (v) result.set(id, v);
  }
  // Order: ours, with steps only theirs added placed after the step they follow there.
  const order = ours.map((s) => s.id).filter((id) => result.has(id));
  theirs.forEach((s, i) => {
    if (!result.has(s.id) || order.includes(s.id)) return;
    let after = -1;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(theirs[j]!.id);
      if (k >= 0) {
        after = k;
        break;
      }
    }
    order.splice(after + 1, 0, s.id);
  });
  return order.map((id) => result.get(id)!);
}

export function mergeStoryTexts(base: string | null, ours: string, theirs: string): string | null {
  let b: Story | null;
  let o: Story;
  let t: Story;
  try {
    o = parseStory(ours);
    t = parseStory(theirs);
    b = base ? parseStory(base) : null;
  } catch {
    return null;
  }
  const bb: Story = b ?? { ...o, steps: [], fixtures: {} };
  const merged: Story = { ...o };
  for (const key of ['name', 'description', 'page', 'viewport', 'timing', 'dependsOn'] as const) {
    const v = pick(bb[key], o[key], t[key]);
    if (v === CONFLICT) return null;
    (merged as unknown as Record<string, unknown>)[key] = v;
  }
  const fixtures: Record<string, string> = {};
  for (const k of new Set([...Object.keys(bb.fixtures), ...Object.keys(o.fixtures), ...Object.keys(t.fixtures)])) {
    const v = pick(bb.fixtures[k], o.fixtures[k], t.fixtures[k]);
    if (v === CONFLICT) return null;
    if (v !== undefined) fixtures[k] = v;
  }
  merged.fixtures = fixtures;
  const steps = mergeSteps(bb.steps, o.steps, t.steps);
  if (!steps) return null;
  merged.steps = steps;
  return serializeStory(merged);
}
