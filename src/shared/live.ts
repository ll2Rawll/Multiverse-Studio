/**
 * Live AI activity: structured events from the command engine, operations, tasks and story runs
 * that drive the on-screen activity layer (pointer, target highlight, activity pill). Targets are
 * identities (a clip id, a section's data-mv-id, a file's line range), never screen coordinates;
 * the interface resolves them to geometry, and shows nothing on screen when it cannot.
 */
import type { Locator } from './stories';

export type LivePhase = 'planning' | 'reading' | 'editing' | 'executing' | 'testing' | 'recording' | 'rendering' | 'waiting' | 'paused' | 'failed' | 'completed' | 'cancelled';

export type LiveTarget =
  /** A website component or element in a page (data-mv-id, or the design element path). */
  | { kind: 'element'; page: string; id: string | null; path: string | null; property: string | null }
  /** An element a browser step acted on, found by the story locator. */
  | { kind: 'locator'; page: string; locator: Locator; assertion: boolean }
  /** Changed lines of a file (1-based, inclusive). */
  | { kind: 'code'; path: string; ranges: { start: number; end: number }[]; created: boolean }
  | { kind: 'clip'; sequenceId: string; clipId: string }
  | { kind: 'track'; sequenceId: string; trackId: string }
  | { kind: 'asset'; assetId: string }
  | { kind: 'object'; objectId: string }
  | { kind: 'universe'; lineId: string }
  /** A story step that ran in the isolated test browser (with the element it acted on or checked, when it has one). */
  | { kind: 'story-step'; storyId: string; stepId: string; page: string; locator: Locator | null; assertion: boolean; ok: boolean | null };

export type LiveEventKind =
  | 'task.started'
  | 'operation.started'
  | 'operation.progress'
  | 'operation.completed'
  | 'operation.failed'
  | 'task.paused'
  | 'task.resumed'
  | 'task.cancelled'
  | 'task.completed'
  | 'task.failed';

export interface LiveEvent {
  kind: LiveEventKind;
  /** `task:<id>` for the built-in AI, `app:<name>` for a connected AI app. */
  taskId: string;
  /** Who is working: “AI task” titles or the app’s name. */
  taskLabel: string;
  actor: 'ai-task' | 'ai-app';
  operationId: string | null;
  projectId: string;
  universeId: string | null;
  universeName: string | null;
  /** The main resource (file path, sequence, story, asset…). */
  resourceId: string | null;
  target: LiveTarget | null;
  /** How many objects the operation affects (the target is the principal one). */
  scope: number;
  /** Command, operation or tool name. */
  operation: string | null;
  phase: LivePhase;
  at: string;
  /** Short, accurate description: “Trimming a clip”, “Testing Create a first task”. */
  description: string;
  /** Measured progress 0–1, or null when it cannot be measured. */
  progress: number | null;
  /** True only when a genuine pointer-style interaction happened (a browser click, fill or key press). */
  pointer: boolean;
  /** The step that ran, for stories and checks: `click`, `fill`, `verify`… */
  action: string | null;
  canPause: boolean;
  /** Error text or outcome detail. */
  detail: string | null;
}
