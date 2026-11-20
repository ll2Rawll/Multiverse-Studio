/**
 * On-disk record formats for projects, with validation used whenever a project is reopened.
 */
import { z } from 'zod';
import { ALTERNATIVE_COLORS } from '../../shared/types';

const hash = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid content id');
const ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const iso = z.string().min(10).max(40);

export const REVISION_KINDS = [
  'import',
  'edit',
  'shared-save',
  'shared-apply',
  'shared-partial',
  'resolution',
  'create',
  'combine',
  'restore',
  'reset',
  'undo',
] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export const revisionRecordSchema = z.object({
  id: hash,
  tree: hash,
  parents: z.array(hash).max(16),
  line: ident,
  kind: z.enum(REVISION_KINDS),
  message: z.string().max(2000),
  createdAt: iso,
  changes: z.array(z.object({ path: z.string(), status: z.enum(['added', 'deleted', 'modified']) })).max(500),
  changesTruncated: z.boolean(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type RevisionRecord = z.infer<typeof revisionRecordSchema>;

const chunkResolution = z.object({
  choice: z.enum(['ours', 'theirs', 'ours-then-theirs', 'theirs-then-ours', 'custom']),
  text: z.string().optional(),
});

export const fileConflictRecordSchema = z.object({
  type: z.enum(['text', 'binary', 'modify-delete', 'timeline']),
  base: hash.nullable(),
  ours: hash.nullable(),
  theirs: hash.nullable(),
  deletedBy: z.enum(['ours', 'theirs']).nullable(),
  conflictCount: z.number().int().min(0),
  resolutions: z.record(z.string(), chunkResolution),
  manual: hash.nullable(),
  choice: z.enum(['ours', 'theirs']).nullable(),
  /** Timelines: the keys of the decisions this merge needs, and the decisions made so far. */
  items: z.array(z.string().max(300)).max(5000).optional(),
  timelineChoices: z.record(z.string(), z.enum(['ours', 'theirs', 'both'])).optional(),
});
export type FileConflictRecord = z.infer<typeof fileConflictRecordSchema>;

export const pendingMergeSchema = z.object({
  id: ident,
  from: hash,
  to: hash,
  oursRevision: hash,
  partialRevision: hash,
  sharedMessage: z.string(),
  createdAt: iso,
  files: z.record(z.string(), fileConflictRecordSchema),
});
export type PendingMerge = z.infer<typeof pendingMergeSchema>;

export const creationSchema = z.object({
  kind: z.enum(['shared', 'alternative', 'checkpoint', 'combine', 'import']),
  lineId: z.string().optional(),
  lineName: z.string().optional(),
  checkpointId: z.string().optional(),
  checkpointName: z.string().optional(),
  revisionId: hash,
});

export const lineRecordSchema = z.object({
  id: ident,
  kind: z.enum(['shared', 'alternative']),
  name: z.string().min(1).max(80),
  color: z.union([z.enum(ALTERNATIVE_COLORS), z.literal('shared')]),
  description: z.string().max(500),
  head: hash,
  draftTree: hash.nullable(),
  following: z.boolean(),
  incorporatedShared: hash,
  createdAt: iso,
  updatedAt: iso,
  createdFrom: creationSchema,
  pending: pendingMergeSchema.nullable(),
  /**
   * Set when the alternative started from Shared's unsaved draft: `snapshot` is a revision of that
   * draft (used as the merge base, so later shared changes merge as changes since the draft) and
   * `savedHead` the Shared revision the draft was on.
   */
  draftBase: z.object({ snapshot: hash, savedHead: hash }).optional(),
});
export type LineRecord = z.infer<typeof lineRecordSchema>;

export const checkpointRecordSchema = z.object({
  id: ident,
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  auto: z.boolean(),
  reason: z.enum(['manual', 'before-combine', 'before-restore', 'import', 'before-undo']),
  createdAt: iso,
  lines: z.record(
    z.string(),
    z.object({
      revision: hash,
      incorporatedShared: hash,
      name: z.string(),
      color: z.union([z.enum(ALTERNATIVE_COLORS), z.literal('shared')]),
      kind: z.enum(['shared', 'alternative']),
      following: z.boolean(),
      description: z.string(),
    }),
  ),
});
export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;

export const operationRecordSchema = z.object({
  id: ident,
  kind: z.enum(['combine', 'restore', 'undo']),
  createdAt: iso,
  summary: z.string().max(2000),
  lineId: ident,
  lineIds: z.array(ident),
  checkpointId: ident.nullable(),
  before: hash.nullable(),
  beforeIncorporated: hash.nullable(),
  after: hash.nullable(),
  createdLine: z.boolean(),
  undone: z.boolean(),
  undoOf: ident.nullable(),
});
export type OperationRecord = z.infer<typeof operationRecordSchema>;

export const PROJECT_FORMAT = 'multiverse-studio/project';

export const PROJECT_KINDS = ['website', 'app', 'video', 'mixed'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const brandSchema = z.object({
  colors: z.array(z.object({ id: ident, name: z.string().min(1).max(60), value: hexColor })).max(64),
  fonts: z.array(z.object({ id: ident, name: z.string().min(1).max(60), family: z.string().min(1).max(200), assetId: z.string().max(128).nullable() })).max(32),
  textStyles: z
    .array(
      z.object({
        id: ident,
        name: z.string().min(1).max(60),
        fontId: ident.nullable(),
        size: z.number().min(4).max(400),
        weight: z.number().int().min(100).max(1000),
        lineHeight: z.number().min(0.5).max(4),
        colorId: ident.nullable(),
      }),
    )
    .max(64),
  logoAssetId: z.string().max(128).nullable(),
});
export type BrandSettings = z.infer<typeof brandSchema>;

export const manifestSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  version: z.literal(2),
  id: ident,
  name: z.string().min(1).max(120),
  createdAt: iso,
  updatedAt: iso,
  kind: z.enum(PROJECT_KINDS),
  brand: brandSchema,
  adapter: z.string().min(1).max(40),
  source: z.object({ kind: z.enum(['import', 'sample', 'template']), originalPath: z.string().nullable(), templateId: z.string().max(64).nullable().optional() }),
  lines: z.record(z.string(), lineRecordSchema),
  order: z.array(ident),
  sharedLog: z.array(hash).min(1),
  checkpoints: z.array(checkpointRecordSchema),
  operations: z.array(operationRecordSchema),
  pins: z.array(hash),
  sequence: z.number().int().min(0),
});
export type ProjectManifest = z.infer<typeof manifestSchema>;
