/**
 * Executable stories: a product journey recorded once and used as a repeatable demonstration, a
 * browser test, an interactive walkthrough, a recorded clip and a timeline with editable overlays.
 *
 * A story is a file in the universe (`stories/<id>.mvstory.json`). Its steps keep functional
 * actions, assertions, presentation timing, framing, narration and captions apart, so a test run
 * uses only actions and assertions, while a recording also honours the presentation steps.
 */

export const STORY_DIR = 'stories';
export const storyPath = (id: string): string => `${STORY_DIR}/${id}.mvstory.json`;

/** How a step finds its element, most robust first: test ids and stable ids, then role and name. */
export type Locator =
  | { by: 'testid'; value: string }
  | { by: 'mv-id'; value: string }
  | { by: 'role'; role: string; name: string }
  | { by: 'label'; name: string }
  | { by: 'placeholder'; value: string }
  | { by: 'text'; text: string }
  | { by: 'css'; value: string };

export type StoryStep =
  | { id: string; kind: 'open'; path: string }
  | { id: string; kind: 'click'; target: Locator }
  | { id: string; kind: 'fill'; target: Locator; text: string }
  | { id: string; kind: 'press'; target: Locator; key: string }
  | { id: string; kind: 'wait'; target: Locator }
  | { id: string; kind: 'verify'; target: Locator | null; expect: { text?: string; visible?: boolean; count?: number; checked?: boolean; value?: string; absent?: boolean } }
  | { id: string; kind: 'chapter'; title: string; subtitle?: string }
  | { id: string; kind: 'annotate'; text: string; seconds?: number }
  | { id: string; kind: 'narrate'; text: string }
  | { id: string; kind: 'hold'; ms: number };

export type StepKind = StoryStep['kind'];
export type StepGroup = 'action' | 'assertion' | 'timing' | 'narration' | 'caption' | 'chapter';

export const STEP_GROUP: Record<StepKind, StepGroup> = { open: 'action', click: 'action', fill: 'action', press: 'action', wait: 'action', verify: 'assertion', hold: 'timing', narrate: 'narration', annotate: 'caption', chapter: 'chapter' };
/** Steps a test run executes; the rest only shape recordings and timelines. */
export const isFunctional = (s: StoryStep): boolean => STEP_GROUP[s.kind] === 'action' || STEP_GROUP[s.kind] === 'assertion';

export interface Story {
  format: 'multiverse-story';
  version: 1;
  id: string;
  name: string;
  description: string;
  /** Start page (project path) or `dev-server` for an app's dev server. */
  page: string;
  /** Camera and framing: the browser viewport the story runs and records at. */
  viewport: { width: number; height: number };
  /** Fixture data; `{{name}}` in fill text is replaced with it. Never production data. */
  fixtures: Record<string, string>;
  steps: StoryStep[];
  /** Presentation timing for recordings. */
  timing: { stepDelayMs: number; typingMsPerChar: number; endHoldMs: number };
  /** Files the story depends on; null means worked out automatically. */
  dependsOn: string[] | null;
}

export interface StoryStepResult {
  id: string;
  kind: StepKind;
  /** null: presentation step, not part of the test. */
  ok: boolean | null;
  detail: string;
  /** Milliseconds from the start of the recording (or run). */
  atMs: number;
}

export interface StoryRunView {
  id: string;
  storyId: string;
  storyName: string;
  lineId: string;
  lineName: string;
  /** The universe's head revision and a hash of the exact files the run used. */
  revision: string | null;
  sourceHash: string;
  storyHash: string;
  mode: 'test' | 'recording';
  at: string;
  ok: boolean;
  durationMs: number;
  steps: StoryStepResult[];
  /** Files the run depended on, with their content hashes then. */
  deps: Record<string, string>;
  depsCertain: boolean;
  /** The recorded clip in the media library (recordings only). */
  assetId: string | null;
  error: string | null;
  console: string[];
  /** The run was still going when the app closed; nothing from it was kept. */
  interrupted?: boolean;
}

export type StoryStatus = 'never-run' | 'passing' | 'failing' | 'needs-check' | 'may-need-check';

export interface StoryView extends Story {
  path: string;
  status: StoryStatus;
  statusDetail: string;
  lastRun: StoryRunView | null;
  /** The previous successful run is kept when later runs fail or the product changes. */
  lastPassing: StoryRunView | null;
  changedDeps: string[];
}

export const STATUS_LABEL: Record<StoryStatus, string> = { 'never-run': 'Not run yet', passing: 'Passing', failing: 'Failing', 'needs-check': 'Needs a new run', 'may-need-check': 'May need a new run' };

export function describeLocator(l: Locator): string {
  switch (l.by) {
    case 'testid':
      return `[data-testid=${l.value}]`;
    case 'mv-id':
      return `#${l.value}`;
    case 'role':
      return `${l.role} “${l.name}”`;
    case 'label':
      return `field “${l.name}”`;
    case 'placeholder':
      return `field “${l.value}”`;
    case 'text':
      return `“${l.text}”`;
    case 'css':
      return l.value;
  }
}

export function describeStep(s: StoryStep): string {
  switch (s.kind) {
    case 'open':
      return `Open ${s.path}`;
    case 'click':
      return `Click ${describeLocator(s.target)}`;
    case 'fill':
      return `Type “${s.text}” into ${describeLocator(s.target)}`;
    case 'press':
      return `Press ${s.key} in ${describeLocator(s.target)}`;
    case 'wait':
      return `Wait for ${describeLocator(s.target)}`;
    case 'verify': {
      const e = s.expect;
      const what = e.absent ? 'is gone' : e.text !== undefined ? `shows “${e.text}”` : e.count !== undefined ? `appears ${e.count} time${e.count === 1 ? '' : 's'}` : e.checked !== undefined ? (e.checked ? 'is checked' : 'is not checked') : e.value !== undefined ? `has the value “${e.value}”` : 'is visible';
      return `Check ${s.target ? describeLocator(s.target) : 'the page'} ${what}`;
    }
    case 'chapter':
      return `Chapter: ${s.title}`;
    case 'annotate':
      return `Caption: ${s.text}`;
    case 'narrate':
      return `Narration: ${s.text}`;
    case 'hold':
      return `Hold ${(s.ms / 1000).toFixed(1)} s`;
  }
}
