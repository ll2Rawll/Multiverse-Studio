/**
 * Types that cross the IPC boundary. These are plain JSON view models; the engine's
 * internal storage records live in src/engine and are never sent to the renderer as-is.
 */

export const SHARED_LINE_ID = 'shared';

export const ALTERNATIVE_COLORS = ['sky', 'amber', 'rose', 'teal', 'violet', 'lime', 'coral', 'mint'] as const;
export type AlternativeColor = (typeof ALTERNATIVE_COLORS)[number];
export type LineColor = AlternativeColor | 'shared';

export type LineKind = 'shared' | 'alternative';

/** What a preview, comparison, export or combine step reads from. */
export type ContentRef =
  | { kind: 'line'; lineId: string }
  | { kind: 'checkpoint'; checkpointId: string; lineId: string }
  | { kind: 'revision'; revisionId: string }
  | { kind: 'proposal'; proposalId: string };

export type LineStatus =
  | 'up-to-date'
  | 'updating'
  | 'conflicted'
  | 'paused'
  | 'behind'
  | 'independent';

export interface CreationSource {
  kind: 'shared' | 'alternative' | 'checkpoint' | 'combine' | 'import';
  lineId?: string;
  lineName?: string;
  checkpointId?: string;
  checkpointName?: string;
  revisionId: string;
}

export interface LineView {
  id: string;
  kind: LineKind;
  name: string;
  color: LineColor;
  description: string;
  following: boolean;
  status: LineStatus;
  /** Number of unresolved conflict regions/files waiting for a decision. */
  conflictCount: number;
  conflictFiles: string[];
  /** Shared changes saved since this alternative last incorporated the shared version. */
  sharedChangesBehind: number;
  /** True when shared updates arrived while conflicts were pending and are waiting. */
  hasQueuedSharedChanges: boolean;
  /** Files whose content differs from the shared version this alternative builds on. */
  differsFromShared: number;
  hasDraft: boolean;
  draftFiles: string[];
  head: string;
  incorporatedShared: string;
  createdAt: string;
  updatedAt: string;
  createdFrom: CreationSource;
  fileCount: number;
}

export interface CheckpointView {
  id: string;
  name: string;
  description: string;
  auto: boolean;
  reason: 'manual' | 'before-combine' | 'before-restore' | 'import' | 'before-undo';
  createdAt: string;
  lines: { lineId: string; name: string; color: LineColor; kind: LineKind; revisionId: string }[];
}

export interface OperationView {
  id: string;
  kind: 'combine' | 'restore' | 'undo';
  createdAt: string;
  summary: string;
  checkpointId: string | null;
  lineId: string;
  undone: boolean;
  canUndo: boolean;
}

/** A starting point offered on Home. Files live in the app's templates folder. */
export interface TemplateInfo {
  id: string;
  name: string;
  kind: 'website' | 'app' | 'video';
  stack: string;
  /** Apps need `npm install` before they run; static websites preview immediately. */
  needsInstall: boolean;
  description: string;
}

export interface ProjectView {
  id: string;
  name: string;
  storagePath: string;
  originalPath: string | null;
  sourceKind: 'import' | 'sample' | 'template';
  templateId?: string | null;
  adapter: string;
  createdAt: string;
  updatedAt: string;
  shared: LineView;
  alternatives: LineView[];
  checkpoints: CheckpointView[];
  operations: OperationView[];
  sharedRevisionCount: number;
  recoveredFromBackup: boolean;
  /** Set when the project was saved in an older format and upgraded on open. */
  migratedFromVersion: number | null;
  kind: 'website' | 'app' | 'video' | 'mixed';
}

export interface RecentProject {
  id: string;
  name: string;
  storagePath: string;
  originalPath: string | null;
  lastOpenedAt: string;
  available: boolean;
  problem: string | null;
  alternativeCount: number;
}

export type FileKind = 'text' | 'binary';

export interface FileEntry {
  path: string;
  size: number;
  hash: string;
  kind: FileKind;
  language: string;
  /** Differs from the shared version this content builds on (alternatives only). */
  differsFromShared: boolean;
  /** Changed in the unsaved draft relative to the last saved revision. */
  inDraft: boolean;
  conflicted: boolean;
  locked: boolean;
}

export interface FileContent {
  path: string;
  hash: string;
  kind: FileKind;
  language: string;
  size: number;
  text: string | null;
  /** data: URL for small images so the UI can show binary previews without privileges. */
  dataUrl: string | null;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
  source: 'html' | 'css' | 'javascript';
}

export interface WriteResult {
  path: string;
  hash: string;
  savedAt: string;
  diagnostics: Diagnostic[];
  line: LineView;
  /** Set when the edit was merged with a change that arrived while typing. */
  mergedText: string | null;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchLength: number;
}

export type PropagationOutcome =
  | 'applied'
  | 'conflicted'
  | 'queued'
  | 'paused'
  | 'unchanged'
  | 'independent';

export interface PropagationLineReport {
  lineId: string;
  name: string;
  outcome: PropagationOutcome;
  appliedFiles: string[];
  conflictFiles: string[];
  conflictCount: number;
}

export interface PropagationReport {
  sharedRevisionId: string;
  changedFiles: string[];
  lines: PropagationLineReport[];
  appliedCount: number;
  conflictedCount: number;
  totalConflicts: number;
}

export interface SaveSharedResult {
  saved: boolean;
  report: PropagationReport | null;
  project: ProjectView;
}

/* ---------- Conflicts ---------- */

export type ChunkChoice = 'ours' | 'theirs' | 'ours-then-theirs' | 'theirs-then-ours' | 'custom';

export interface ChunkResolution {
  choice: ChunkChoice;
  text?: string;
}

export type ConflictChunkView =
  | { kind: 'stable'; text: string; startLine: number; lineCount: number }
  | {
      kind: 'conflict';
      index: number;
      base: string;
      ours: string;
      theirs: string;
      resolution: ChunkResolution | null;
    };

export type FileConflictView =
  | {
      type: 'text';
      path: string;
      chunks: ConflictChunkView[];
      conflictCount: number;
      resolvedCount: number;
      manualText: string | null;
      addedOnBothSides: boolean;
    }
  | {
      type: 'timeline';
      path: string;
      sequenceName: string;
      /** Each decision the merge needs; unresolved ones take this version's side until decided. */
      items: (import('./media').TimelineConflictItemView & { choice: 'ours' | 'theirs' | 'both' | null })[];
      /** Changes from the incoming side that merged without a decision. */
      taken: string[];
      conflictCount: number;
      resolvedCount: number;
      /** Whole-timeline choice, when made. */
      choice: 'ours' | 'theirs' | null;
    }
  | {
      type: 'binary' | 'modify-delete';
      path: string;
      oursExists: boolean;
      theirsExists: boolean;
      deletedBy: 'ours' | 'theirs' | null;
      choice: 'ours' | 'theirs' | null;
      oursSize: number;
      theirsSize: number;
    };

export interface ConflictSetView {
  lineId: string;
  lineName: string;
  sharedFrom: string;
  sharedTo: string;
  sharedMessage: string;
  createdAt: string;
  files: FileConflictView[];
  totalConflicts: number;
  unresolved: number;
  queuedSharedChanges: boolean;
}

export type FileResolutionInput =
  | { path: string; type: 'chunks'; resolutions: Record<string, ChunkResolution> }
  | { path: string; type: 'manual'; text: string }
  | { path: string; type: 'choice'; choice: 'ours' | 'theirs' }
  | { path: string; type: 'timeline'; choices: Record<string, 'ours' | 'theirs' | 'both'> };

/* ---------- Compare ---------- */

export type FileChangeStatus = 'added' | 'deleted' | 'modified' | 'unchanged';

export interface FileComparison {
  path: string;
  status: FileChangeStatus;
  kind: FileKind;
  leftHash: string | null;
  rightHash: string | null;
  linesAdded: number;
  linesRemoved: number;
}

export interface ComparisonView {
  left: RefLabel;
  right: RefLabel;
  files: FileComparison[];
  counts: { added: number; deleted: number; modified: number; unchanged: number };
  commonRevision: { id: string; label: string } | null;
}

export interface RefLabel {
  ref: ContentRef;
  label: string;
  color: LineColor;
  detail: string;
}

/* ---------- Combine ---------- */

export interface DiffHunkView {
  index: number;
  destStartLine: number;
  destLineCount: number;
  sourceStartLine: number;
  sourceLineCount: number;
  removed: string;
  added: string;
  contextBefore: string;
  contextAfter: string;
}

export type FileAction =
  | { kind: 'keep' }
  | { kind: 'take'; source: ContentRef }
  | { kind: 'merge'; source: ContentRef; resolutions?: Record<string, ChunkResolution>; timelineChoices?: Record<string, 'ours' | 'theirs' | 'both'> }
  | { kind: 'hunks'; source: ContentRef; hunks: number[] }
  /** Timelines: take whole tracks and individual clips from the source, keeping their times. */
  | { kind: 'timeline'; source: ContentRef; tracks: string[]; clips: string[] };

export type SectionTarget =
  | { mode: 'replace'; key: string }
  | { mode: 'insert'; anchorKey: string; position: 'before' | 'after' }
  | { mode: 'append' };

export interface SectionStep {
  source: ContentRef;
  sourcePath: string;
  sectionKey: string;
  destPath: string;
  target: SectionTarget;
  cssRuleIds: string[];
  includeVariables: boolean;
  assets: { path: string; action: 'copy' | 'skip' }[];
  destCssPath: string | null;
}

export type CombineDestination =
  | { kind: 'existing'; lineId: string }
  | {
      kind: 'new';
      base: ContentRef;
      name: string;
      color: AlternativeColor;
      description: string;
      following: boolean;
    };

export interface CombinePlan {
  destination: CombineDestination;
  files: Record<string, FileAction>;
  sections: SectionStep[];
  edits: Record<string, string>;
  description: string;
}

export interface ProposedFile {
  path: string;
  status: FileChangeStatus;
  kind: FileKind;
  origin: string;
  hasConflicts: boolean;
}

export interface CombineProposal {
  proposalId: string;
  files: ProposedFile[];
  changedCount: number;
  conflicts: { path: string; count: number }[];
  warnings: CombineWarning[];
  ready: boolean;
}

export interface CombineWarning {
  severity: 'info' | 'warning' | 'blocking';
  kind:
    | 'duplicate-id'
    | 'missing-asset'
    | 'asset-differs'
    | 'css-scope'
    | 'css-uncertain'
    | 'javascript'
    | 'ambiguous'
    | 'conflict'
    | 'variables'
    | 'behaviour'
    | 'dependency'
    | 'story';
  message: string;
  path?: string;
  /** A file the picked parts rely on, and a version being combined that has it. */
  include?: { path: string; source: ContentRef };
}

export interface CombineResult {
  operationId: string;
  checkpointId: string;
  lineId: string;
  createdLine: boolean;
  changedFiles: { path: string; status: FileChangeStatus }[];
  summary: string;
  project: ProjectView;
}

export interface CombineCandidateFile {
  path: string;
  status: FileChangeStatus;
  kind: FileKind;
  sourceChangedSinceCommon: boolean;
  destChangedSinceCommon: boolean;
  mergeable: boolean;
  /** A timeline (sequence) file: combined by tracks and clips, not by lines. */
  timeline?: boolean;
}

export interface CombineCandidates {
  source: RefLabel;
  destination: RefLabel;
  commonRevision: { id: string; label: string } | null;
  files: CombineCandidateFile[];
}

/* ---------- HTML sections ---------- */

export interface SectionInfo {
  key: string;
  label: string;
  tag: string;
  id: string | null;
  classes: string[];
  depth: number;
  startLine: number;
  endLine: number;
  ambiguous: boolean;
  reason: string | null;
}

export interface CssRuleCandidate {
  id: string;
  path: string;
  selector: string;
  media: string | null;
  text: string;
  relation: 'specific' | 'shared' | 'dependency';
  dependencyKind: 'font-face' | 'keyframes' | null;
  warning: string | null;
  defaultSelected: boolean;
}

export interface AssetDependency {
  path: string;
  referencedFrom: string;
  status: 'present-identical' | 'missing' | 'differs' | 'unavailable';
  defaultAction: 'copy' | 'skip';
}

export interface SectionAnalysis {
  section: SectionInfo;
  sourceLabel: string;
  destinationLabel: string;
  sourcePath: string;
  destPath: string;
  html: string;
  suggestedTarget: SectionTarget;
  destinationSections: SectionInfo[];
  cssRules: CssRuleCandidate[];
  variables: { name: string; value: string; destValue: string | null }[];
  assets: AssetDependency[];
  scripts: { path: string; line: number; detail: string }[];
  warnings: CombineWarning[];
  destCssPath: string | null;
}

/* ---------- History ---------- */

export interface HistoryEntry {
  id: string;
  type: 'revision' | 'checkpoint';
  lineId: string | null;
  lineName: string;
  color: LineColor;
  kind: string;
  title: string;
  detail: string;
  createdAt: string;
  files: { path: string; status: FileChangeStatus }[];
  checkpointId: string | null;
  revisionId: string | null;
}

export interface CheckpointDetails {
  checkpoint: CheckpointView;
  lines: {
    lineId: string;
    name: string;
    color: LineColor;
    kind: LineKind;
    revisionId: string;
    exists: boolean;
    changedSincePrevious: { path: string; status: FileChangeStatus }[];
    differsFromCurrent: { path: string; status: FileChangeStatus }[];
  }[];
}

export interface RestorePreview {
  checkpointId: string;
  lines: {
    lineId: string;
    name: string;
    changes: { path: string; status: FileChangeStatus }[];
    note: string | null;
    blocked: string | null;
  }[];
}

/* ---------- Import / export ---------- */

export interface ImportReport {
  project: ProjectView;
  fileCount: number;
  totalBytes: number;
  skipped: { path: string; reason: string }[];
  storagePath: string;
  originalPath: string;
}

export interface ExportReport {
  destination: string;
  format: 'folder' | 'zip';
  fileCount: number;
  totalBytes: number;
  missingReferences: { file: string; reference: string }[];
}

/* ---------- Preview ---------- */

export interface PreviewHandle {
  token: string;
  url: string;
}

/* ---------- Events ---------- */

export type StudioEvent =
  | { type: 'connector'; state: import('./connector').ConnectorStateView }
  | { type: 'connector-show'; projectId: string; lineId: string | null; app: string }
  | { type: 'live'; event: import('./live').LiveEvent }
  | {
      type: 'project-changed';
      projectId: string;
      reason: string;
      lineIds: string[];
      project: ProjectView;
    }
  | { type: 'propagation'; projectId: string; report: PropagationReport }
  | { type: 'notice'; level: 'info' | 'error'; message: string }
  | { type: 'ai-task'; projectId: string; taskId: string; update: import('./ai').TaskUpdate }
  | { type: 'build'; projectId: string; lineId: string; process: import('./build').BuildProcessView; chunk?: string }
  | { type: 'media'; projectId: string }
  | { type: 'video-job'; projectId: string; job: import('./video').ExportJobView }
  | { type: 'media-job'; projectId: string; job: import('./media').MediaJobView }
  | { type: 'publish-job'; projectId: string; job: import('./publish').DeployJobView }
  | { type: 'activity'; projectId: string; record: import('./activity').ActivityRecord }
  | { type: 'story-run'; projectId: string; run: import('./stories').StoryRunView }
  | { type: 'menu'; command: string };

export interface AppSettings {
  appearance: 'system' | 'dystopia' | 'dark' | 'light';
  transparency: 'system' | 'reduced' | 'full';
  motion: 'system' | 'reduced' | 'full';
  livePreviewLimit: number;
  sidebarWidth: number;
  inspectorWidth: number;
  editorSplit: number;
  /** Default mode and routine permissions for new AI tasks (each task can still change them). */
  taskMode: 'ask' | 'plan' | 'build';
  taskPermissions: { editAlternative: boolean; runBuildAndTests: boolean; installDependencies: boolean; operatePreview: boolean };
  /** Live AI activity: pointer and target highlights (the activity pill is always available). */
  activityVisuals: 'off' | 'minimal' | 'detailed';
  /** Follow AI: open the workspace and resource the focused task is working on. */
  followAi: boolean;
  /** Show the “AI” label next to the AI pointer. */
  activityLabels: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: 'dystopia',
  transparency: 'system',
  motion: 'system',
  livePreviewLimit: 4,
  sidebarWidth: 248,
  inspectorWidth: 300,
  editorSplit: 0.52,
  taskMode: 'ask',
  taskPermissions: { editAlternative: true, runBuildAndTests: true, installDependencies: false, operatePreview: true },
  activityVisuals: 'minimal',
  followAi: false,
  activityLabels: true,
};

export interface AppInfo {
  version: string;
  platform: string;
  workspacePath: string;
  previewBase: string;
  host: 'electron' | 'browser-harness';
}
