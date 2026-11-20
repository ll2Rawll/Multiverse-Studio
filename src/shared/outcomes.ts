/**
 * Comparing universes by what they produce, not only by files. Everything here is either read
 * from the files (pages, objects, timelines) or measured (story runs, test runs, renders, deploys),
 * and measured results say what they were measured on. There are no scores or predictions.
 */
import type { ContentRef } from './types';
import type { StoryStatus } from './stories';

export interface OutcomeSide {
  ref: ContentRef;
  label: string;
  lineId: string | null;
  revision: string | null;
  /** True when the side is a current version with unsaved changes. */
  draft: boolean;
  /** Files added, deleted and modified relative to the first side (null for the first side). */
  files: { added: number; deleted: number; modified: number } | null;
}

export interface PageOutcome {
  path: string;
  sides: ({ hash: string; title: string; heading: string } | null)[];
}

export interface ObjectOutcome {
  id: string;
  sides: ({ name: string; type: string; properties: Record<string, string>; placements: number } | null)[];
  /** Properties whose values differ between the sides that have the object. */
  differs: string[];
}

export interface StoryOutcome {
  id: string;
  name: string;
  sides: ({ status: StoryStatus; detail: string; at: string | null; revision: string | null; steps: number } | null)[];
}

export interface TimelineOutcome {
  id: string;
  sides: ({ name: string; seconds: number; clips: number; tracks: number; hash: string } | null)[];
}

export interface RenderOutcome {
  sequenceId: string;
  sides: ({ sequenceName: string; at: string; format: string; seconds: number | null; outdated: string | null; revision: string | null } | null)[];
}

export interface ReleaseOutcome {
  targetId: string;
  targetName: string;
  sides: ({ at: string; url: string | null; revision: string | null; current: boolean | null; detail: string } | null)[];
}

export interface TestRunView {
  id: string;
  lineId: string;
  lineName: string;
  revision: string | null;
  draft: boolean;
  /** Hash of the code files the run used (see codeHash). */
  sourceHash: string;
  at: string;
  passed: boolean;
  exitCode: number | null;
  output: string;
  actor: string;
}

export interface TestOutcome {
  sides: ({ at: string; passed: boolean; exitCode: number | null; current: boolean; revision: string | null } | null)[];
}

export interface UniverseOutcomes {
  sides: OutcomeSide[];
  pages: PageOutcome[];
  objects: ObjectOutcome[];
  stories: StoryOutcome[];
  timelines: TimelineOutcome[];
  renders: RenderOutcome[];
  releases: ReleaseOutcome[];
  tests: TestOutcome;
}

/** One destination of a release: deploys and exports are separate jobs and finish separately. */
export interface ReleaseDestinationView {
  key: string;
  kind: 'website' | 'video';
  name: string;
  /** The newest attempt, whatever its state. */
  latest: { jobId: string; state: string; at: string; lineId: string; lineName: string; revision: string | null; draft: boolean; detail: string } | null;
  /** The newest confirmed result: a deploy the host confirmed, or an export whose file was checked. */
  live: { jobId: string; at: string; lineId: string; lineName: string; revision: string | null; draft: boolean; sourceHash: string | null; url: string | null; output: string | null } | null;
  /** Whether the live result still matches its version's current files (null when that can’t be told). */
  current: boolean | null;
  currentDetail: string;
}
