/**
 * ProjectEngine: the revision engine for one project.
 *
 * Model
 * - Every file version is a content-addressed blob; a tree maps paths to blobs.
 * - Revisions are immutable records (tree + parents + kind + message).
 * - A "line" is the Shared version or an alternative. It points at a head revision.
 * - The Shared version keeps an unsaved draft until the user saves it; saving is a
 *   shared change that is reconciled into every alternative that follows shared changes.
 * - Alternatives save automatically (rapid edits are coalesced into one revision).
 * - Each alternative remembers the shared revision it has incorporated. Propagation is
 *   a three-way merge: base = incorporated shared revision, ours = the alternative,
 *   theirs = the new shared revision.
 * - Conflicts are stored with both sides and block nothing else: compatible changes are
 *   applied, conflicted files keep the alternative's last coherent version and are
 *   locked until resolved, and later shared changes queue behind the resolution.
 *
 * All mutations are serialized and committed through one atomic manifest write that
 * happens after every new object and revision is safely on disk.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ObjectStore, type Hash } from './store/objects';
import { RevisionStore } from './store/revisions';
import { loadManifest, readManifest, writeManifest, ProjectDamagedError, MANIFEST_BACKUP, MANIFEST_FILE } from './store/manifestFile';
import { CURRENT_PROJECT_VERSION, UnsupportedProjectVersionError } from './store/migrations';
import { exists as fileExists, writeFileAtomic } from './store/atomic';
import {
  PROJECT_FORMAT,
  manifestSchema,
  type CheckpointRecord,
  type FileConflictRecord,
  type LineRecord,
  type OperationRecord,
  type ProjectManifest,
  type RevisionKind,
  type RevisionRecord,
} from './store/records';
import { diffTrees, mergeTrees, treesEqual, type TreeChange } from './merge/treeMerge';
import { mergeSequences, type MergeNames } from '../video/merge';
import { parseSequence, serializeSequence } from '../video/sequence';
import { applyResolutions, diff3Lines, mergeText, type MergeChunk } from './merge/diff3';
import { splitLines } from './merge/text';
import { StudioError, notFound } from './errors';
import { describeChanges, newId, nowIso } from './util';
import { normalizeProjectPath } from '../shared/paths';
import {
  SHARED_LINE_ID,
  type AlternativeColor,
  type ChunkResolution,
  type ContentRef,
  type FileResolutionInput,
  type PropagationLineReport,
  type PropagationReport,
} from '../shared/types';

const COALESCE_WINDOW_MS = 5 * 60 * 1000;
const MAX_CHECKPOINTS = 400;
const MAX_OPERATIONS = 400;

export type Mutation = (m: ProjectManifest) => void;

export interface ResolvedRef {
  tree: Map<string, Hash>;
  revisionId: string | null;
  lineId: string | null;
}

export interface ProgressInfo {
  phase: 'propagating';
  lineName: string;
  index: number;
  total: number;
}

export interface ProposalRecord {
  tree: Map<string, Hash>;
  createdAt: number;
  label: string;
}

interface PropagationPlan {
  mutations: Mutation[];
  report: PropagationLineReport[];
}

export class ProjectEngine {
  readonly objects: ObjectStore;
  readonly revisions: RevisionStore;
  recovered = false;
  /** The format version this project had on disk when it was opened, if it was upgraded. */
  migratedFrom: number | null = null;
  private manifest!: ProjectManifest;
  private manifestJson: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly proposals = new Map<string, ProposalRecord>();

  private constructor(readonly dir: string) {
    this.objects = new ObjectStore(dir);
    this.revisions = new RevisionStore(dir);
  }

  /* ------------------------------------------------------------------ */
  /* Creation and opening                                                */
  /* ------------------------------------------------------------------ */

  static async create(
    dir: string,
    init: {
      id: string;
      name: string;
      files: ReadonlyMap<string, Uint8Array | string>;
      source: { kind: 'import' | 'sample' | 'template'; originalPath: string | null; templateId?: string | null };
      adapter: string;
      kind?: 'website' | 'app' | 'video' | 'mixed';
    },
  ): Promise<ProjectEngine> {
    await fs.mkdir(dir, { recursive: true });
    const engine = new ProjectEngine(dir);
    const tree = new Map<string, Hash>();
    for (const [rawPath, data] of init.files) {
      tree.set(normalizeProjectPath(rawPath), await engine.objects.putBlob(data));
    }
    const createdAt = nowIso();
    const rev = await engine.makeRevision({
      tree,
      parents: [],
      line: SHARED_LINE_ID,
      kind: 'import',
      message: init.source.kind === 'sample' ? 'Sample project created' : init.source.kind === 'template' ? 'Project created from a template' : 'Project imported',
      compareTo: new Map(),
    });
    const shared: LineRecord = {
      id: SHARED_LINE_ID,
      kind: 'shared',
      name: 'Shared version',
      color: 'shared',
      description: 'Changes saved here flow into every alternative that follows shared changes.',
      head: rev.id,
      draftTree: null,
      following: true,
      incorporatedShared: rev.id,
      createdAt,
      updatedAt: createdAt,
      createdFrom: { kind: 'import', revisionId: rev.id },
      pending: null,
    };
    const manifest: ProjectManifest = {
      format: PROJECT_FORMAT,
      version: CURRENT_PROJECT_VERSION as 2,
      id: init.id,
      name: init.name,
      createdAt,
      updatedAt: createdAt,
      kind: init.kind ?? 'website',
      brand: { colors: [], fonts: [], textStyles: [], logoAssetId: null },
      adapter: init.adapter,
      source: init.source,
      lines: { [SHARED_LINE_ID]: shared },
      order: [],
      sharedLog: [rev.id],
      checkpoints: [],
      operations: [],
      pins: [],
      sequence: 0,
    };
    manifest.checkpoints.push(engine.checkpointRecord(manifest, init.source.kind === 'sample' ? 'Sample created' : init.source.kind === 'template' ? 'Created' : 'Imported', '', true, 'import'));
    engine.manifestJson = await writeManifest(dir, manifestSchema.parse(manifest), null);
    engine.manifest = manifest;
    return engine;
  }

  static async open(dir: string): Promise<ProjectEngine> {
    const engine = new ProjectEngine(dir);
    const problems: string[] = [];
    try {
      const loaded = await loadManifest(path.join(dir, MANIFEST_FILE));
      engine.manifest = loaded.manifest;
      await engine.validateReferences();
      const onDisk = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8');
      if (loaded.applied.length > 0) {
        // Keep the untouched original once, then commit the upgraded manifest atomically.
        const original = path.join(dir, `project.v${loaded.fromVersion}.json`);
        if (!(await fileExists(original))) await writeFileAtomic(original, onDisk);
        engine.manifestJson = await writeManifest(dir, engine.manifest, onDisk);
        engine.migratedFrom = loaded.fromVersion;
      } else {
        engine.manifestJson = onDisk;
      }
      return engine;
    } catch (error) {
      if (error instanceof UnsupportedProjectVersionError) throw error;
      problems.push(`Current metadata: ${(error as Error).message}`);
      if (error instanceof ProjectDamagedError) problems.push(...error.details.map((d) => `  ${d}`));
    }
    try {
      engine.manifest = await readManifest(path.join(dir, MANIFEST_BACKUP));
      await engine.validateReferences();
      const json = await fs.readFile(path.join(dir, MANIFEST_BACKUP), 'utf8');
      await writeFileAtomic(path.join(dir, MANIFEST_FILE), json);
      engine.manifestJson = json;
      engine.recovered = true;
      return engine;
    } catch (error) {
      problems.push(`Backup metadata: ${(error as Error).message}`);
    }
    throw new ProjectDamagedError('This project’s metadata is damaged and could not be recovered automatically.', problems);
  }

  /** Check that everything the manifest points at exists and is readable. */
  private async validateReferences(): Promise<void> {
    const m = this.manifest;
    const missing: string[] = [];
    const checkedBlobs = new Set<Hash>();
    const checkTree = async (treeHash: Hash, label: string): Promise<void> => {
      let tree: Map<string, Hash>;
      try {
        tree = await this.objects.getTree(treeHash);
      } catch (error) {
        missing.push(`${label}: ${(error as Error).message}`);
        return;
      }
      for (const [file, hash] of tree) {
        if (checkedBlobs.has(hash)) continue;
        checkedBlobs.add(hash);
        if (!(await this.objects.has(hash))) missing.push(`${label}: content for ${file} is missing`);
      }
    };
    const checkRevision = async (id: Hash, label: string, deep: boolean): Promise<void> => {
      try {
        const rev = await this.revisions.get(id);
        if (deep) await checkTree(rev.tree, label);
        else if (!(await this.objects.has(rev.tree))) missing.push(`${label}: tree is missing`);
      } catch (error) {
        missing.push(`${label}: ${(error as Error).message}`);
      }
    };
    if (!m.lines[SHARED_LINE_ID]) missing.push('The Shared version is missing');
    for (const id of m.order) if (!m.lines[id]) missing.push(`Alternative ${id} is listed but missing`);
    for (const line of Object.values(m.lines)) {
      await checkRevision(line.head, line.name, true);
      await checkRevision(line.incorporatedShared, `${line.name} (shared base)`, false);
      if (line.draftTree) await checkTree(line.draftTree, `${line.name} (draft)`);
      if (line.pending) {
        for (const id of [line.pending.from, line.pending.to, line.pending.oursRevision]) {
          await checkRevision(id, `${line.name} (conflict)`, false);
        }
        for (const [file, record] of Object.entries(line.pending.files)) {
          for (const hash of [record.base, record.ours, record.theirs, record.manual]) {
            if (hash && !(await this.objects.has(hash))) missing.push(`${line.name}: conflict content for ${file} is missing`);
          }
        }
      }
    }
    for (const cp of m.checkpoints) {
      for (const entry of Object.values(cp.lines)) {
        if (!(await this.revisions.has(entry.revision))) missing.push(`Checkpoint “${cp.name}” refers to a missing revision`);
      }
    }
    if (missing.length > 0) throw new ProjectDamagedError('Project content is incomplete', missing);
  }

  /* ------------------------------------------------------------------ */
  /* Basic access                                                         */
  /* ------------------------------------------------------------------ */

  get data(): Readonly<ProjectManifest> {
    return this.manifest;
  }

  get id(): string {
    return this.manifest.id;
  }

  /** Serialize work on this project so every mutation sees a consistent manifest. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  line(lineId: string): LineRecord {
    const line = this.manifest.lines[lineId];
    if (!line) throw notFound('That alternative');
    return line;
  }

  get shared(): LineRecord {
    return this.line(SHARED_LINE_ID);
  }

  alternatives(): LineRecord[] {
    return this.manifest.order.map((id) => this.manifest.lines[id]).filter((l): l is LineRecord => Boolean(l));
  }

  async revision(id: Hash): Promise<RevisionRecord> {
    return this.revisions.get(id);
  }

  async treeOfRevision(id: Hash): Promise<Map<string, Hash>> {
    const rev = await this.revisions.get(id);
    return this.objects.getTree(rev.tree);
  }

  async effectiveTree(lineId: string): Promise<Map<string, Hash>> {
    const line = this.line(lineId);
    if (line.draftTree) return this.objects.getTree(line.draftTree);
    return this.treeOfRevision(line.head);
  }

  checkpoint(checkpointId: string): CheckpointRecord {
    const cp = this.manifest.checkpoints.find((c) => c.id === checkpointId);
    if (!cp) throw notFound('That checkpoint');
    return cp;
  }

  async resolveRef(ref: ContentRef): Promise<ResolvedRef> {
    switch (ref.kind) {
      case 'line': {
        const line = this.line(ref.lineId);
        return { tree: await this.effectiveTree(ref.lineId), revisionId: line.draftTree ? null : line.head, lineId: line.id };
      }
      case 'checkpoint': {
        const entry = this.checkpoint(ref.checkpointId).lines[ref.lineId];
        if (!entry) throw notFound('That version in the checkpoint');
        return { tree: await this.treeOfRevision(entry.revision), revisionId: entry.revision, lineId: ref.lineId };
      }
      case 'revision':
        return { tree: await this.treeOfRevision(ref.revisionId), revisionId: ref.revisionId, lineId: null };
      case 'proposal': {
        const proposal = this.proposals.get(ref.proposalId);
        if (!proposal) throw new StudioError('proposal-expired', 'This proposed combination has expired. Review it again to continue.');
        return { tree: proposal.tree, revisionId: null, lineId: null };
      }
    }
  }

  async readBlob(hash: Hash): Promise<Buffer> {
    return this.objects.getBlob(hash);
  }

  /** The Shared revision a line has incorporated, seeing through a draft snapshot. */
  sharedBaseOf(line: LineRecord): Hash {
    return line.draftBase && line.incorporatedShared === line.draftBase.snapshot ? line.draftBase.savedHead : line.incorporatedShared;
  }

  sharedChangesBetween(fromRev: Hash, toRev: Hash): number {
    const log = this.manifest.sharedLog;
    const a = log.lastIndexOf(fromRev);
    const b = log.lastIndexOf(toRev);
    if (a < 0 || b < 0) return fromRev === toRev ? 0 : 1;
    return Math.max(0, b - a);
  }

  /* ------------------------------------------------------------------ */
  /* Proposals (combine previews)                                         */
  /* ------------------------------------------------------------------ */

  storeProposal(tree: Map<string, Hash>, label: string): string {
    const id = newId('prop');
    this.proposals.set(id, { tree, createdAt: Date.now(), label });
    while (this.proposals.size > 24) {
      const oldest = this.proposals.keys().next();
      if (oldest.done) break;
      this.proposals.delete(oldest.value);
    }
    return id;
  }

  proposal(id: string): ProposalRecord | undefined {
    return this.proposals.get(id);
  }

  /* ------------------------------------------------------------------ */
  /* Low-level commit helpers                                             */
  /* ------------------------------------------------------------------ */

  async makeRevision(input: {
    tree: ReadonlyMap<string, Hash>;
    parents: Hash[];
    line: string;
    kind: RevisionKind;
    message: string;
    compareTo?: ReadonlyMap<string, Hash>;
    meta?: Record<string, string | number | boolean>;
  }): Promise<RevisionRecord> {
    const treeHash = await this.objects.putTree(input.tree);
    const previous = input.compareTo ?? (input.parents[0] ? await this.treeOfRevision(input.parents[0]) : new Map<string, Hash>());
    const changes = diffTrees(previous, input.tree);
    return this.revisions.put({
      tree: treeHash,
      parents: input.parents,
      line: input.line,
      kind: input.kind,
      message: input.message.slice(0, 2000),
      createdAt: nowIso(),
      changes: changes.slice(0, 500),
      changesTruncated: changes.length > 500,
      meta: input.meta ?? {},
    });
  }

  /** Apply mutations to a copy of the manifest, validate it, and write it atomically. */
  async commit(mutations: Mutation | Mutation[]): Promise<void> {
    const next = structuredClone(this.manifest);
    for (const mutate of Array.isArray(mutations) ? mutations : [mutations]) mutate(next);
    next.updatedAt = nowIso();
    next.sequence += 1;
    if (next.checkpoints.length > MAX_CHECKPOINTS) next.checkpoints = next.checkpoints.slice(-MAX_CHECKPOINTS);
    if (next.operations.length > MAX_OPERATIONS) next.operations = next.operations.slice(-MAX_OPERATIONS);
    const validated = manifestSchema.parse(next);
    this.manifestJson = await writeManifest(this.dir, validated, this.manifestJson);
    this.manifest = validated;
  }

  isPinned(revisionId: Hash, m: Readonly<ProjectManifest> = this.manifest): boolean {
    if (m.pins.includes(revisionId) || m.sharedLog.includes(revisionId)) return true;
    for (const line of Object.values(m.lines)) {
      if (line.createdFrom.revisionId === revisionId || line.incorporatedShared === revisionId) return true;
      if (line.pending && [line.pending.oursRevision, line.pending.partialRevision, line.pending.from, line.pending.to].includes(revisionId)) return true;
    }
    for (const cp of m.checkpoints) for (const e of Object.values(cp.lines)) if (e.revision === revisionId) return true;
    for (const op of m.operations) if (op.before === revisionId || op.after === revisionId) return true;
    return false;
  }

  checkpointRecord(
    m: Readonly<ProjectManifest>,
    name: string,
    description: string,
    auto: boolean,
    reason: CheckpointRecord['reason'],
  ): CheckpointRecord {
    const lines: CheckpointRecord['lines'] = {};
    for (const line of Object.values(m.lines)) {
      lines[line.id] = {
        revision: line.head,
        incorporatedShared: line.kind === 'shared' ? line.head : line.incorporatedShared,
        name: line.name,
        color: line.color,
        kind: line.kind,
        following: line.following,
        description: line.description,
      };
    }
    return { id: newId('cp'), name: name.slice(0, 120), description: description.slice(0, 500), auto, reason, createdAt: nowIso(), lines };
  }

  private assertEditable(line: LineRecord, filePath: string): void {
    if (line.pending?.files[filePath]) {
      throw new StudioError(
        'conflict-locked',
        `${filePath} has an unresolved conflict in ${line.name}. Resolve it first so no work is lost.`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Editing                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Write one file. When `baseHash` is given (the version the editor started from) and
   * the file changed underneath — for example a shared change arrived while typing — the
   * edit is three-way merged instead of overwriting; overlapping edits are refused.
   */
  async writeFile(
    lineId: string,
    rawPath: string,
    data: string | Uint8Array,
    options: { mustNotExist?: boolean; baseHash?: Hash } = {},
  ): Promise<{ hash: Hash; changed: boolean; mergedText: string | null }> {
    return this.run(async () => {
      const filePath = normalizeProjectPath(rawPath);
      const line = this.line(lineId);
      this.assertEditable(line, filePath);
      const current = await this.effectiveTree(lineId);
      if (options.mustNotExist && current.has(filePath)) {
        throw new StudioError('file-exists', `${filePath} already exists.`);
      }
      let content = data;
      let mergedText: string | null = null;
      const currentHash = current.get(filePath);
      if (options.baseHash && currentHash && currentHash !== options.baseHash && typeof data === 'string') {
        const [base, theirs] = await Promise.all([this.objects.getText(options.baseHash).catch(() => null), this.objects.getText(currentHash)]);
        const merged = base === null ? null : mergeText(base, data, theirs);
        if (!merged || !merged.clean || merged.text === null) {
          throw new StudioError('stale-write', `${filePath} changed while you were editing and your edits overlap. Your text is still in the editor.`, { currentHash });
        }
        content = merged.text;
        mergedText = merged.text;
      }
      const hash = await this.objects.putBlob(content);
      if (currentHash === hash) return { hash, changed: false, mergedText };
      const tree = new Map(current);
      tree.set(filePath, hash);
      await this.applyEdit(lineId, tree);
      return { hash, changed: true, mergedText };
    });
  }

  /**
   * Apply several file changes as one edit (used by commands that touch more than one file, such
   * as a design change to a page and its stylesheet). `expected` lists the content hash each file
   * must still have (null = must not exist); if any differs, nothing is written.
   */
  async writeFiles(
    lineId: string,
    changes: ReadonlyMap<string, string | Uint8Array | null>,
    expected: ReadonlyMap<string, Hash | null> = new Map(),
    message?: string,
  ): Promise<Map<string, Hash | null>> {
    return this.run(async () => {
      const line = this.line(lineId);
      const current = await this.effectiveTree(lineId);
      for (const [rawPath, hash] of expected) {
        const filePath = normalizeProjectPath(rawPath);
        if ((current.get(filePath) ?? null) !== hash) {
          throw new StudioError('stale-command', `${filePath} changed since this action was prepared. Nothing was changed; try again.`, { path: filePath });
        }
      }
      const tree = new Map(current);
      const result = new Map<string, Hash | null>();
      for (const [rawPath, data] of changes) {
        const filePath = normalizeProjectPath(rawPath);
        this.assertEditable(line, filePath);
        if (data === null) {
          tree.delete(filePath);
          result.set(filePath, null);
        } else {
          const hash = await this.objects.putBlob(data);
          tree.set(filePath, hash);
          result.set(filePath, hash);
        }
      }
      if (!treesEqual(tree, current)) await this.applyEdit(lineId, tree, 'edit', message);
      return result;
    });
  }

  async deleteFile(lineId: string, rawPath: string): Promise<void> {
    return this.run(async () => {
      const filePath = normalizeProjectPath(rawPath);
      const line = this.line(lineId);
      this.assertEditable(line, filePath);
      const current = await this.effectiveTree(lineId);
      if (!current.has(filePath)) throw notFound(filePath);
      const tree = new Map(current);
      tree.delete(filePath);
      await this.applyEdit(lineId, tree);
    });
  }

  /** Reset one file: alternatives back to the shared version they build on; the Shared draft back to its last save. */
  async resetFile(lineId: string, rawPath: string, to: 'shared' | 'saved'): Promise<Hash | null> {
    return this.run(async () => {
      const filePath = normalizeProjectPath(rawPath);
      const line = this.line(lineId);
      this.assertEditable(line, filePath);
      const sourceTree =
        to === 'shared' && line.kind === 'alternative'
          ? await this.treeOfRevision(line.incorporatedShared)
          : await this.treeOfRevision(line.head);
      const target = sourceTree.get(filePath) ?? null;
      const tree = new Map(await this.effectiveTree(lineId));
      if (target === null) tree.delete(filePath);
      else tree.set(filePath, target);
      await this.applyEdit(lineId, tree, line.kind === 'alternative' ? 'reset' : 'edit', `Reset ${filePath} to the shared version`);
      return target;
    });
  }

  private async applyEdit(lineId: string, tree: Map<string, Hash>, kind: RevisionKind = 'edit', message?: string): Promise<void> {
    const line = this.line(lineId);
    if (line.kind === 'shared') {
      const headTree = await this.treeOfRevision(line.head);
      const draft = treesEqual(tree, headTree) ? null : await this.objects.putTree(tree);
      await this.commit((m) => {
        const shared = m.lines[SHARED_LINE_ID]!;
        shared.draftTree = draft;
        shared.updatedAt = nowIso();
      });
      return;
    }
    await this.commitAlternativeTree(lineId, tree, kind, message);
  }

  /** Save an alternative's new content, coalescing rapid edits into a single revision. */
  private async commitAlternativeTree(lineId: string, tree: Map<string, Hash>, kind: RevisionKind, message?: string): Promise<void> {
    const line = this.line(lineId);
    const head = await this.revision(line.head);
    const coalesceStart = String(head.meta.coalesceStart ?? head.createdAt);
    const coalesce =
      kind === 'edit' &&
      head.line === lineId &&
      head.kind === 'edit' &&
      head.meta.sealed !== true &&
      head.parents.length === 1 &&
      !this.isPinned(head.id) &&
      Date.now() - Date.parse(coalesceStart) < COALESCE_WINDOW_MS;
    const parents = coalesce ? head.parents : [line.head];
    const baseTree = await this.treeOfRevision(parents[0]!);
    const changes = diffTrees(baseTree, tree);

    if (coalesce && changes.length === 0) {
      // The edits were undone; step back to the previous revision.
      await this.commit((m) => {
        const target = m.lines[lineId]!;
        target.head = parents[0]!;
        target.updatedAt = nowIso();
      });
      return;
    }
    if (!coalesce && changes.length === 0) return;

    const rev = await this.makeRevision({
      tree,
      parents,
      line: lineId,
      kind,
      message: message ?? describeChanges('Edited', changes),
      compareTo: baseTree,
      meta: coalesce ? { coalesceStart } : kind === 'edit' ? { coalesceStart: nowIso() } : {},
    });
    await this.commit((m) => {
      const target = m.lines[lineId]!;
      target.head = rev.id;
      target.updatedAt = nowIso();
    });
  }

  /** Replace an alternative's whole content as one revision (used to seed the sample). */
  async setAlternativeContent(lineId: string, files: ReadonlyMap<string, Uint8Array | string>, message: string): Promise<void> {
    return this.run(async () => {
      const line = this.line(lineId);
      if (line.kind !== 'alternative') throw new StudioError('unsupported', 'Only alternatives can be replaced this way.');
      const tree = new Map<string, Hash>();
      for (const [rawPath, data] of files) tree.set(normalizeProjectPath(rawPath), await this.objects.putBlob(data));
      const current = await this.effectiveTree(lineId);
      const rev = await this.makeRevision({ tree, parents: [line.head], line: lineId, kind: 'edit', message, compareTo: current, meta: { sealed: true } });
      await this.commit((m) => {
        m.lines[lineId]!.head = rev.id;
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Shared version                                                       */
  /* ------------------------------------------------------------------ */

  async draftChanges(): Promise<TreeChange[]> {
    const shared = this.shared;
    if (!shared.draftTree) return [];
    return diffTrees(await this.treeOfRevision(shared.head), await this.objects.getTree(shared.draftTree));
  }

  async discardSharedDraft(): Promise<void> {
    return this.run(async () => {
      await this.commit((m) => {
        m.lines[SHARED_LINE_ID]!.draftTree = null;
        // Alternatives started from the discarded draft keep those changes as their own.
        for (const l of Object.values(m.lines)) {
          if (l.draftBase && l.incorporatedShared === l.draftBase.snapshot) l.incorporatedShared = l.draftBase.savedHead;
          delete l.draftBase;
        }
      });
    });
  }

  /**
   * Save the Shared draft as a shared change and reconcile it into every alternative
   * that follows shared changes — in one atomic commit.
   */
  async saveShared(message: string | undefined, onProgress?: (info: ProgressInfo) => void): Promise<PropagationReport | null> {
    return this.run(async () => {
      const shared = this.shared;
      if (!shared.draftTree) return null;
      const tree = await this.objects.getTree(shared.draftTree);
      const headTree = await this.treeOfRevision(shared.head);
      const changes = diffTrees(headTree, tree);
      const text = message?.trim() || describeChanges('Changed', changes);
      const rev = await this.makeRevision({ tree, parents: [shared.head], line: SHARED_LINE_ID, kind: 'shared-save', message: text, compareTo: headTree });
      const plan = await this.preparePropagation(rev.id, text, this.manifest.order, { onProgress });
      await this.commit([
        (m) => {
          const s = m.lines[SHARED_LINE_ID]!;
          s.head = rev.id;
          s.incorporatedShared = rev.id;
          s.draftTree = null;
          s.updatedAt = nowIso();
          m.sharedLog.push(rev.id);
        },
        ...plan.mutations,
      ]);
      return this.buildReport(rev.id, changes, plan.report);
    });
  }

  private buildReport(sharedRevisionId: Hash, changes: TreeChange[], lines: PropagationLineReport[]): PropagationReport {
    return {
      sharedRevisionId,
      changedFiles: changes.map((c) => c.path),
      lines,
      appliedCount: lines.filter((l) => l.outcome === 'applied').length,
      conflictedCount: lines.filter((l) => l.outcome === 'conflicted').length,
      totalConflicts: lines.reduce((sum, l) => sum + l.conflictCount, 0),
    };
  }

  /**
   * Compute how each alternative takes in the shared revision `target`. Writes any new
   * revisions/objects and returns manifest mutations; nothing is committed here.
   */
  private async preparePropagation(
    target: Hash,
    sharedMessage: string,
    lineIds: readonly string[],
    options: { assumeFollowing?: boolean; onProgress?: (info: ProgressInfo) => void } = {},
  ): Promise<PropagationPlan> {
    const mutations: Mutation[] = [];
    const report: PropagationLineReport[] = [];
    const theirs = await this.treeOfRevision(target);
    let index = 0;
    for (const lineId of lineIds) {
      const line = this.manifest.lines[lineId];
      if (!line || line.kind !== 'alternative') continue;
      index++;
      options.onProgress?.({ phase: 'propagating', lineName: line.name, index, total: lineIds.length });
      const entry: PropagationLineReport = {
        lineId,
        name: line.name,
        outcome: 'unchanged',
        appliedFiles: [],
        conflictFiles: [],
        conflictCount: 0,
      };
      report.push(entry);
      if (!line.following && !options.assumeFollowing) {
        entry.outcome = 'paused';
        continue;
      }
      if (line.pending) {
        entry.outcome = 'queued';
        entry.conflictFiles = Object.keys(line.pending.files);
        continue;
      }
      // (A line started from Shared's draft has nothing to take until Shared saves past it.)
      if (line.incorporatedShared === target || this.sharedBaseOf(line) === target) continue;

      const base = await this.treeOfRevision(line.incorporatedShared);
      const ours = await this.effectiveTree(lineId);
      const merged = await mergeTrees(base, ours, theirs, this.objects);
      entry.appliedFiles = merged.applied.map((c) => c.path);

      if (merged.conflicts.length === 0) {
        if (merged.applied.length === 0) {
          mutations.push((m) => {
            m.lines[lineId]!.incorporatedShared = target;
          });
          continue;
        }
        const rev = await this.makeRevision({
          tree: merged.tree,
          parents: [line.head, target],
          line: lineId,
          kind: 'shared-apply',
          message: `Shared change applied: ${sharedMessage}`,
          compareTo: ours,
          meta: { shared: target },
        });
        entry.outcome = 'applied';
        mutations.push((m) => {
          const l = m.lines[lineId]!;
          l.head = rev.id;
          l.incorporatedShared = target;
          l.updatedAt = nowIso();
        });
        continue;
      }

      let head = line.head;
      if (merged.applied.length > 0) {
        const partial = await this.makeRevision({
          tree: merged.tree,
          parents: [line.head],
          line: lineId,
          kind: 'shared-partial',
          message: `Shared change partly applied: ${sharedMessage} (${merged.conflicts.length} ${merged.conflicts.length === 1 ? 'file needs' : 'files need'} a decision)`,
          compareTo: ours,
          meta: { shared: target },
        });
        head = partial.id;
      }
      const files: Record<string, FileConflictRecord> = {};
      for (const conflict of merged.conflicts) {
        files[conflict.path] = {
          type: conflict.type,
          base: conflict.base,
          ours: conflict.ours,
          theirs: conflict.theirs,
          deletedBy: conflict.deletedBy,
          conflictCount: conflict.conflictCount,
          resolutions: {},
          manual: null,
          choice: null,
          ...(conflict.type === 'timeline' ? { items: conflict.items ?? [], timelineChoices: {} } : {}),
        };
      }
      entry.outcome = 'conflicted';
      entry.conflictFiles = merged.conflicts.map((c) => c.path);
      entry.conflictCount = merged.conflicts.reduce((sum, c) => sum + c.conflictCount, 0);
      const pending = {
        id: newId('merge'),
        from: line.incorporatedShared,
        to: target,
        oursRevision: line.head,
        partialRevision: head,
        sharedMessage,
        createdAt: nowIso(),
        files,
      };
      mutations.push((m) => {
        const l = m.lines[lineId]!;
        l.head = head;
        l.pending = pending;
        l.updatedAt = nowIso();
      });
    }
    return { mutations, report };
  }

  /* ------------------------------------------------------------------ */
  /* Alternatives                                                         */
  /* ------------------------------------------------------------------ */

  async createAlternative(input: {
    from: ContentRef;
    name: string;
    color: AlternativeColor;
    description: string;
    following: boolean;
    /** Start from the version as it is now, including Shared's unsaved draft (used by edits applied as a new alternative). */
    includeDraft?: boolean;
  }): Promise<LineRecord> {
    return this.run(async () => {
      const source = await this.creationSource(input.from);
      const id = newId('alt');
      const saved = await this.treeOfRevision(source.revision);
      const tree = input.includeDraft && input.from.kind === 'line' ? await this.effectiveTree(input.from.lineId) : saved;
      const withDraft = !treesEqual(tree, saved);
      // Starting from Shared's unsaved draft: snapshot the draft as a revision and merge later shared
      // changes against it, so edits made to the draft afterwards arrive as ordinary changes.
      const fromSharedDraft = withDraft && input.from.kind === 'line' && this.line(input.from.lineId).kind === 'shared';
      const snapshot = fromSharedDraft
        ? await this.makeRevision({ tree, parents: [source.revision], line: SHARED_LINE_ID, kind: 'edit', message: `Unsaved Shared draft used to start “${input.name.trim()}”`, compareTo: saved, meta: { draftSnapshot: true } })
        : null;
      const rev = await this.makeRevision({
        tree,
        parents: [snapshot?.id ?? source.revision],
        line: id,
        kind: 'create',
        message: `Created from ${source.label}${withDraft ? ' (with its unsaved changes)' : ''}`,
        compareTo: snapshot ? tree : saved,
      });
      const createdAt = nowIso();
      const record: LineRecord = {
        id,
        kind: 'alternative',
        name: input.name.trim(),
        color: input.color,
        description: input.description.trim(),
        head: rev.id,
        draftTree: null,
        following: input.following,
        incorporatedShared: snapshot?.id ?? source.incorporated,
        createdAt,
        updatedAt: createdAt,
        createdFrom: source.creation,
        pending: null,
        ...(snapshot ? { draftBase: { snapshot: snapshot.id, savedHead: source.revision } } : {}),
      };
      await this.commit((m) => {
        m.lines[id] = record;
        m.order.push(id);
        if (!m.pins.includes(source.revision)) m.pins.push(source.revision);
        if (snapshot && !m.pins.includes(snapshot.id)) m.pins.push(snapshot.id);
      });
      return record;
    });
  }

  private async creationSource(ref: ContentRef): Promise<{
    revision: Hash;
    incorporated: Hash;
    label: string;
    creation: LineRecord['createdFrom'];
  }> {
    if (ref.kind === 'line') {
      const line = this.line(ref.lineId);
      if (line.kind === 'shared') {
        return {
          revision: line.head,
          incorporated: line.head,
          label: 'the Shared version',
          creation: { kind: 'shared', lineId: line.id, lineName: line.name, revisionId: line.head },
        };
      }
      return {
        revision: line.head,
        incorporated: line.incorporatedShared,
        label: line.name,
        creation: { kind: 'alternative', lineId: line.id, lineName: line.name, revisionId: line.head },
      };
    }
    if (ref.kind === 'checkpoint') {
      const cp = this.checkpoint(ref.checkpointId);
      const entry = cp.lines[ref.lineId];
      if (!entry) throw notFound('That version in the checkpoint');
      return {
        revision: entry.revision,
        incorporated: entry.kind === 'shared' ? entry.revision : entry.incorporatedShared,
        label: `${entry.name} at checkpoint “${cp.name}”`,
        creation: {
          kind: 'checkpoint',
          lineId: ref.lineId,
          lineName: entry.name,
          checkpointId: cp.id,
          checkpointName: cp.name,
          revisionId: entry.revision,
        },
      };
    }
    throw new StudioError('unsupported', 'Alternatives can be created from the Shared version, an alternative, or a checkpoint.');
  }

  /** Create an alternative directly from a tree (used by combine). Caller holds the lock. */
  async createAlternativeFromTree(input: {
    tree: Map<string, Hash>;
    parents: Hash[];
    name: string;
    color: AlternativeColor;
    description: string;
    following: boolean;
    incorporatedShared: Hash;
    message: string;
    createdFrom?: LineRecord['createdFrom'];
    extraMutations?: (record: LineRecord, revision: RevisionRecord) => Mutation[];
  }): Promise<{ record: LineRecord; revision: RevisionRecord }> {
    const id = newId('alt');
    const rev = await this.makeRevision({
      tree: input.tree,
      parents: input.parents,
      line: id,
      kind: 'combine',
      message: input.message,
    });
    const createdAt = nowIso();
    const record: LineRecord = {
      id,
      kind: 'alternative',
      name: input.name.trim(),
      color: input.color,
      description: input.description.trim(),
      head: rev.id,
      draftTree: null,
      following: input.following,
      incorporatedShared: input.incorporatedShared,
      createdAt,
      updatedAt: createdAt,
      createdFrom: input.createdFrom ?? { kind: 'combine', revisionId: input.parents[0]! },
      pending: null,
    };
    await this.commit([
      (m) => {
        m.lines[id] = record;
        m.order.push(id);
        for (const p of input.parents) if (!m.pins.includes(p)) m.pins.push(p);
      },
      ...(input.extraMutations?.(record, rev) ?? []),
    ]);
    return { record, revision: rev };
  }

  async updateAlternative(lineId: string, patch: { name?: string; color?: AlternativeColor; description?: string }): Promise<void> {
    return this.run(async () => {
      const line = this.line(lineId);
      if (line.kind !== 'alternative') throw new StudioError('unsupported', 'The Shared version cannot be renamed.');
      await this.commit((m) => {
        const l = m.lines[lineId]!;
        if (patch.name !== undefined) l.name = patch.name.trim();
        if (patch.color !== undefined) l.color = patch.color;
        if (patch.description !== undefined) l.description = patch.description.trim();
        l.updatedAt = nowIso();
      });
    });
  }

  async deleteAlternative(lineId: string): Promise<void> {
    return this.run(async () => {
      const line = this.line(lineId);
      if (line.kind !== 'alternative') throw new StudioError('unsupported', 'The Shared version cannot be deleted.');
      const cp = this.checkpointRecord(this.manifest, `Before deleting ${line.name}`, 'Created automatically so the alternative can be recovered.', true, 'before-undo');
      await this.commit((m) => {
        m.checkpoints.push(cp);
        delete m.lines[lineId];
        m.order = m.order.filter((id) => id !== lineId);
      });
    });
  }

  async reorderAlternatives(order: string[]): Promise<void> {
    return this.run(async () => {
      const current = new Set(this.manifest.order);
      if (order.length !== current.size || !order.every((id) => current.has(id))) {
        throw new StudioError('invalid', 'The new order must contain every alternative exactly once.');
      }
      await this.commit((m) => {
        m.order = [...order];
      });
    });
  }

  /**
   * Pause or resume following shared changes. Resuming (or calling with true while
   * already following) reconciles every missed shared change against the shared
   * revision this alternative last incorporated.
   */
  async setFollowing(lineId: string, following: boolean): Promise<PropagationReport | null> {
    return this.run(async () => {
      const line = this.line(lineId);
      if (line.kind !== 'alternative') throw new StudioError('unsupported', 'Only alternatives follow shared changes.');
      if (!following) {
        if (!line.following) return null;
        await this.commit((m) => {
          m.lines[lineId]!.following = false;
        });
        return null;
      }
      const sharedHead = this.shared.head;
      const sharedRev = await this.revision(sharedHead);
      const plan =
        this.sharedBaseOf(line) === sharedHead || line.pending
          ? { mutations: [], report: [] }
          : await this.preparePropagation(sharedHead, sharedRev.message, [lineId], { assumeFollowing: true });
      await this.commit([
        (m) => {
          m.lines[lineId]!.following = true;
        },
        ...plan.mutations,
      ]);
      if (plan.report.length === 0) return null;
      return this.buildReport(sharedHead, [], plan.report);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Conflicts                                                            */
  /* ------------------------------------------------------------------ */

  async conflictChunks(record: FileConflictRecord): Promise<MergeChunk[]> {
    const text = async (hash: Hash | null): Promise<string> => (hash ? (await this.objects.getBlob(hash)).toString('utf8') : '');
    const [b, o, t] = await Promise.all([text(record.base), text(record.ours), text(record.theirs)]);
    return diff3Lines(splitLines(b), splitLines(o), splitLines(t));
  }

  unresolvedCount(record: FileConflictRecord): number {
    if (record.type === 'timeline') {
      if (record.choice) return 0;
      const chosen = record.timelineChoices ?? {};
      return (record.items ?? []).filter((k) => !chosen[k]).length;
    }
    if (record.type !== 'text') return record.choice ? 0 : 1;
    if (record.manual) return 0;
    let unresolved = 0;
    for (let i = 0; i < record.conflictCount; i++) if (!record.resolutions[String(i)]) unresolved++;
    return unresolved;
  }

  async saveResolution(lineId: string, input: FileResolutionInput): Promise<void> {
    return this.run(async () => {
      const line = this.line(lineId);
      const filePath = normalizeProjectPath(input.path);
      const record = line.pending?.files[filePath];
      if (!line.pending || !record) throw notFound('That conflict');
      let update: Partial<FileConflictRecord> = {};
      if (input.type === 'chunks') {
        if (record.type !== 'text') throw new StudioError('invalid', 'This conflict needs a whole-file choice.');
        const resolutions: Record<string, ChunkResolution> = { ...record.resolutions };
        for (const [key, value] of Object.entries(input.resolutions)) {
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index >= record.conflictCount) {
            throw new StudioError('invalid', 'That conflict region does not exist.');
          }
          resolutions[key] = value.choice === 'custom' ? { choice: 'custom', text: value.text ?? '' } : { choice: value.choice };
        }
        update = { resolutions, manual: null };
      } else if (input.type === 'manual') {
        if (record.type !== 'text') throw new StudioError('invalid', 'This conflict needs a whole-file choice.');
        update = { manual: await this.objects.putBlob(input.text) };
      } else if (input.type === 'timeline') {
        if (record.type !== 'timeline') throw new StudioError('invalid', 'This file is not a timeline.');
        const choices = { ...(record.timelineChoices ?? {}), ...input.choices };
        // Decisions can reveal new ones (taking their trim can make two clips overlap), so recompute.
        const merged = await this.timelineMerge(record, choices);
        const keys = new Set(merged.conflicts.map((c) => c.key));
        for (const k of Object.keys(choices)) if (!keys.has(k)) delete choices[k];
        update = { timelineChoices: choices, items: [...keys], conflictCount: keys.size, choice: null };
      } else {
        update = { choice: input.choice };
      }
      await this.commit((m) => {
        const files = m.lines[lineId]!.pending!.files;
        files[filePath] = { ...files[filePath]!, ...update };
      });
    });
  }

  /** Recompute a timeline merge with the decisions made so far. */
  async timelineMerge(record: FileConflictRecord, choices: Record<string, 'ours' | 'theirs' | 'both'> = record.timelineChoices ?? {}, names?: MergeNames): Promise<ReturnType<typeof mergeSequences>> {
    const read = async (h: Hash | null) => (h ? parseSequence((await this.objects.getBlob(h)).toString('utf8')) : null);
    const [b, o, t] = await Promise.all([read(record.base), read(record.ours), read(record.theirs)]);
    if (!o || !t) throw new StudioError('invalid', 'This timeline conflict is missing one side.');
    return mergeSequences(b, o, t, choices, names);
  }

  private async resolvedContent(record: FileConflictRecord): Promise<Hash | null | undefined> {
    if (record.type === 'timeline') {
      if (record.choice) return record.choice === 'ours' ? record.ours : record.theirs;
      if (this.unresolvedCount(record) > 0) return undefined;
      const merged = await this.timelineMerge(record);
      const chosen = record.timelineChoices ?? {};
      if (merged.conflicts.some((c) => !chosen[c.key])) return undefined;
      return this.objects.putBlob(serializeSequence(merged.sequence));
    }
    if (record.type === 'text') {
      if (record.manual) return record.manual;
      const text = applyResolutions(await this.conflictChunks(record), record.resolutions);
      if (text === null) return undefined;
      return this.objects.putBlob(text);
    }
    if (!record.choice) return undefined;
    return record.choice === 'ours' ? record.ours : record.theirs;
  }

  /**
   * Apply every conflict decision, mark the shared change as incorporated, and then
   * reconcile any shared changes that queued up while the conflict was open.
   */
  async completeResolution(lineId: string): Promise<PropagationReport | null> {
    return this.run(async () => {
      const line = this.line(lineId);
      const pending = line.pending;
      if (!pending) throw new StudioError('no-conflicts', `${line.name} has no conflicts waiting.`);
      const tree = new Map(await this.effectiveTree(lineId));
      for (const [filePath, record] of Object.entries(pending.files)) {
        const content = await this.resolvedContent(record);
        if (content === undefined) {
          throw new StudioError('conflicts-unresolved', `Choose how to resolve every conflict in ${filePath} first.`);
        }
        if (content === null) tree.delete(filePath);
        else tree.set(filePath, content);
      }
      const rev = await this.makeRevision({
        tree,
        parents: [line.head, pending.to],
        line: lineId,
        kind: 'resolution',
        message: `Resolved conflicts with shared change: ${pending.sharedMessage}`,
        meta: { shared: pending.to },
      });
      await this.commit((m) => {
        const l = m.lines[lineId]!;
        l.head = rev.id;
        l.incorporatedShared = pending.to;
        l.pending = null;
        l.updatedAt = nowIso();
      });

      const current = this.line(lineId);
      const sharedHead = this.shared.head;
      if (!current.following || this.sharedBaseOf(current) === sharedHead) return null;
      const sharedRev = await this.revision(sharedHead);
      const plan = await this.preparePropagation(sharedHead, sharedRev.message, [lineId]);
      await this.commit(plan.mutations);
      return this.buildReport(sharedHead, [], plan.report);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Checkpoints, restore and undo                                        */
  /* ------------------------------------------------------------------ */

  async createCheckpoint(name: string, description: string): Promise<CheckpointRecord> {
    return this.run(async () => {
      const cp = this.checkpointRecord(this.manifest, name, description, false, 'manual');
      await this.commit((m) => {
        m.checkpoints.push(cp);
      });
      return cp;
    });
  }

  async renameCheckpoint(checkpointId: string, name: string, description: string): Promise<void> {
    return this.run(async () => {
      this.checkpoint(checkpointId);
      await this.commit((m) => {
        const cp = m.checkpoints.find((c) => c.id === checkpointId)!;
        cp.name = name.trim().slice(0, 120);
        cp.description = description.trim().slice(0, 500);
      });
    });
  }

  restoreBlockers(checkpointId: string, lineIds: readonly string[]): Map<string, string> {
    const cp = this.checkpoint(checkpointId);
    const blocked = new Map<string, string>();
    for (const lineId of lineIds) {
      const entry = cp.lines[lineId];
      const line = this.manifest.lines[lineId];
      if (!entry) blocked.set(lineId, 'This version is not part of the checkpoint.');
      else if (!line) blocked.set(lineId, `${entry.name} no longer exists. Create an alternative from this checkpoint instead.`);
      else if (line.pending) blocked.set(lineId, `Resolve ${line.name}’s conflicts before restoring it.`);
      else if (line.kind === 'shared' && line.draftTree) blocked.set(lineId, 'Save or discard the Shared draft before restoring it.');
    }
    return blocked;
  }

  /**
   * Restore lines to their state at a checkpoint. Restoring is a new revision on top of
   * the current one, so later history stays intact. Restoring the Shared version is a
   * shared change and is reconciled into following alternatives.
   */
  async restoreCheckpoint(checkpointId: string, lineIds: readonly string[]): Promise<{ report: PropagationReport | null; checkpointId: string }> {
    return this.run(() => this.restoreLocked(checkpointId, lineIds, null));
  }

  private async restoreLocked(
    checkpointId: string,
    lineIds: readonly string[],
    undoOf: string | null,
  ): Promise<{ report: PropagationReport | null; checkpointId: string }> {
    const cp = this.checkpoint(checkpointId);
    const blocked = this.restoreBlockers(checkpointId, lineIds);
    if (blocked.size > 0) throw new StudioError('restore-blocked', [...blocked.values()].join(' '));

    const safety = this.checkpointRecord(this.manifest, `Before restoring “${cp.name}”`, 'Created automatically so this restore can be reversed.', true, 'before-restore');
    const mutations: Mutation[] = [(m) => void m.checkpoints.push(safety)];
    let sharedTarget: Hash | null = null;
    const ordered = [...lineIds].sort((a, b) => (a === SHARED_LINE_ID ? -1 : b === SHARED_LINE_ID ? 1 : 0));
    const restoredNames: string[] = [];

    for (const lineId of ordered) {
      const entry = cp.lines[lineId]!;
      const line = this.line(lineId);
      const targetTree = await this.treeOfRevision(entry.revision);
      const current = await this.effectiveTree(lineId);
      restoredNames.push(line.name);
      if (treesEqual(current, targetTree)) {
        if (line.kind === 'alternative') {
          mutations.push((m) => {
            m.lines[lineId]!.incorporatedShared = entry.incorporatedShared;
          });
        }
        continue;
      }
      const rev = await this.makeRevision({
        tree: targetTree,
        parents: [line.head, entry.revision],
        line: lineId,
        kind: undoOf ? 'undo' : 'restore',
        message: `Restored ${line.name} from checkpoint “${cp.name}”`,
        compareTo: current,
      });
      if (line.kind === 'shared') {
        sharedTarget = rev.id;
        mutations.push((m) => {
          const s = m.lines[SHARED_LINE_ID]!;
          s.head = rev.id;
          s.incorporatedShared = rev.id;
          s.updatedAt = nowIso();
          m.sharedLog.push(rev.id);
        });
      } else {
        mutations.push((m) => {
          const l = m.lines[lineId]!;
          l.head = rev.id;
          l.incorporatedShared = entry.incorporatedShared;
          l.updatedAt = nowIso();
        });
      }
    }

    const op: OperationRecord = {
      id: newId('op'),
      kind: undoOf ? 'undo' : 'restore',
      createdAt: nowIso(),
      summary: `Restored ${restoredNames.join(', ')} from “${cp.name}”`,
      lineId: ordered[0]!,
      lineIds: [...ordered],
      checkpointId: safety.id,
      before: null,
      beforeIncorporated: null,
      after: null,
      createdLine: false,
      undone: false,
      undoOf,
    };
    mutations.push((m) => {
      m.operations.push(op);
      if (undoOf) {
        const original = m.operations.find((o) => o.id === undoOf);
        if (original) original.undone = true;
      }
    });
    await this.commit(mutations);

    let report: PropagationReport | null = null;
    if (sharedTarget) {
      const message = `Restored Shared version from “${cp.name}”`;
      const plan = await this.preparePropagation(sharedTarget, message, this.manifest.order);
      await this.commit(plan.mutations);
      report = this.buildReport(sharedTarget, [], plan.report);
    }
    return { report, checkpointId: safety.id };
  }

  /** Record a combine operation (called by the combine module inside the lock). */
  operationRecord(input: Omit<OperationRecord, 'id' | 'createdAt' | 'undone' | 'undoOf'>): OperationRecord {
    return { id: newId('op'), createdAt: nowIso(), undone: false, undoOf: null, ...input };
  }

  canUndo(op: OperationRecord): boolean {
    if (op.undone || op.kind === 'undo') return false;
    if (op.kind === 'restore') return op.checkpointId !== null && this.manifest.checkpoints.some((c) => c.id === op.checkpointId);
    const line = this.manifest.lines[op.lineId];
    if (!line) return false;
    return !line.pending;
  }

  async undoOperation(operationId: string): Promise<PropagationReport | null> {
    return this.run(async () => {
      const op = this.manifest.operations.find((o) => o.id === operationId);
      if (!op) throw notFound('That action');
      if (!this.canUndo(op)) throw new StudioError('cannot-undo', 'This action can no longer be undone. You can still restore an earlier checkpoint from History.');

      if (op.kind === 'restore') {
        const result = await this.restoreLocked(op.checkpointId!, op.lineIds.filter((id) => this.manifest.lines[id]), op.id);
        return result.report;
      }

      const line = this.line(op.lineId);
      const safety = this.checkpointRecord(this.manifest, `Before undoing: ${op.summary}`, 'Created automatically before undoing.', true, 'before-undo');
      const undo: OperationRecord = {
        id: newId('op'),
        kind: 'undo',
        createdAt: nowIso(),
        summary: `Undid: ${op.summary}`,
        lineId: op.lineId,
        lineIds: [op.lineId],
        checkpointId: safety.id,
        before: line.head,
        beforeIncorporated: line.incorporatedShared,
        after: null,
        createdLine: false,
        undone: false,
        undoOf: op.id,
      };
      if (op.createdLine) {
        await this.commit((m) => {
          m.checkpoints.push(safety);
          delete m.lines[op.lineId];
          m.order = m.order.filter((id) => id !== op.lineId);
          m.operations.find((o) => o.id === op.id)!.undone = true;
          m.operations.push(undo);
        });
        return null;
      }
      const beforeTree = await this.treeOfRevision(op.before!);
      const rev = await this.makeRevision({
        tree: beforeTree,
        parents: [line.head, op.before!],
        line: op.lineId,
        kind: 'undo',
        message: `Undid: ${op.summary}`,
        compareTo: await this.effectiveTree(op.lineId),
      });
      await this.commit((m) => {
        m.checkpoints.push(safety);
        const l = m.lines[op.lineId]!;
        l.head = rev.id;
        if (op.beforeIncorporated) l.incorporatedShared = op.beforeIncorporated;
        l.updatedAt = nowIso();
        m.operations.find((o) => o.id === op.id)!.undone = true;
        m.operations.push({ ...undo, after: rev.id });
      });
      return null;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ancestry                                                             */
  /* ------------------------------------------------------------------ */

  private async ancestors(start: Hash, limit = 20000): Promise<Map<Hash, number>> {
    const seen = new Map<Hash, number>();
    const queue: [Hash, number][] = [[start, 0]];
    while (queue.length > 0 && seen.size < limit) {
      const [id, depth] = queue.shift()!;
      if (seen.has(id)) continue;
      seen.set(id, depth);
      let rev: RevisionRecord;
      try {
        rev = await this.revision(id);
      } catch {
        continue;
      }
      for (const parent of rev.parents) if (!seen.has(parent)) queue.push([parent, depth + 1]);
    }
    return seen;
  }

  /**
   * The best common ancestor of two revisions: a common ancestor that is not itself an
   * ancestor of another common ancestor (most recent when there are several).
   */
  async commonAncestor(a: Hash, b: Hash): Promise<Hash | null> {
    if (a === b) return a;
    const fromA = await this.ancestors(a);
    if (fromA.has(b)) return b;
    const fromB = await this.ancestors(b);
    if (fromB.has(a)) return a;
    const common = [...fromB.keys()].filter((id) => fromA.has(id));
    if (common.length === 0) return null;
    if (common.length === 1) return common[0]!;
    const commonSet = new Set(common);
    const dominated = new Set<Hash>();
    // Only inspect the closest candidates; distant ones are almost always dominated.
    const candidates = common
      .sort((x, y) => (fromA.get(x)! + fromB.get(x)!) - (fromA.get(y)! + fromB.get(y)!))
      .slice(0, 8);
    for (const candidate of candidates) {
      const rev = await this.revision(candidate);
      for (const parent of rev.parents) {
        const anc = await this.ancestors(parent, 5000);
        for (const id of anc.keys()) if (commonSet.has(id)) dominated.add(id);
      }
    }
    const best = candidates.filter((id) => !dominated.has(id));
    const pool = best.length > 0 ? best : candidates;
    let winner = pool[0]!;
    let winnerTime = (await this.revision(winner)).createdAt;
    for (const id of pool.slice(1)) {
      const t = (await this.revision(id)).createdAt;
      if (t > winnerTime) {
        winner = id;
        winnerTime = t;
      }
    }
    return winner;
  }

  /** First-parent history of a line, newest first, stopping where the line was created. */
  async lineHistory(lineId: string, limit: number): Promise<RevisionRecord[]> {
    const line = this.line(lineId);
    const out: RevisionRecord[] = [];
    let current: Hash | undefined = line.head;
    while (current && out.length < limit) {
      const rev = await this.revision(current);
      out.push(rev);
      if (rev.kind === 'create' || rev.kind === 'import' || (rev.line !== lineId && lineId !== SHARED_LINE_ID)) break;
      current = rev.parents[0];
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Maintenance                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Remove objects and revisions that nothing references any more (left behind by
   * coalesced edits). Anything referenced by the backup manifest is kept too, and
   * nothing younger than ten minutes is touched.
   */
  async collectGarbage(): Promise<{ revisions: number; objects: number }> {
    return this.run(async () => {
      if (this.recovered) return { revisions: 0, objects: 0 };
      const manifests: ProjectManifest[] = [this.manifest];
      try {
        manifests.push(await readManifest(path.join(this.dir, MANIFEST_BACKUP)));
      } catch {
        // no usable backup; only the current manifest counts
      }
      const roots = new Set<Hash>();
      const liveObjects = new Set<Hash>();
      for (const m of manifests) {
        m.sharedLog.forEach((id) => roots.add(id));
        m.pins.forEach((id) => roots.add(id));
        for (const line of Object.values(m.lines)) {
          roots.add(line.head);
          roots.add(line.incorporatedShared);
          roots.add(line.createdFrom.revisionId);
          if (line.draftTree) liveObjects.add(line.draftTree);
          if (line.pending) {
            [line.pending.from, line.pending.to, line.pending.oursRevision, line.pending.partialRevision].forEach((id) => roots.add(id));
            for (const f of Object.values(line.pending.files)) {
              for (const h of [f.base, f.ours, f.theirs, f.manual]) if (h) liveObjects.add(h);
            }
          }
        }
        for (const cp of m.checkpoints) for (const e of Object.values(cp.lines)) roots.add(e.revision);
        for (const op of m.operations) for (const h of [op.before, op.after]) if (h) roots.add(h);
      }
      const liveRevisions = new Set<Hash>();
      const stack = [...roots];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (liveRevisions.has(id)) continue;
        liveRevisions.add(id);
        try {
          const rev = await this.revision(id);
          liveObjects.add(rev.tree);
          stack.push(...rev.parents);
        } catch {
          // missing revisions were reported at open time
        }
      }
      const trees = [...liveObjects];
      for (const hash of trees) {
        try {
          const tree = await this.objects.getTree(hash);
          for (const blob of tree.values()) liveObjects.add(blob);
        } catch {
          // a blob, not a tree
        }
      }
      for (const proposal of this.proposals.values()) for (const blob of proposal.tree.values()) liveObjects.add(blob);

      const cutoff = Date.now() - 10 * 60 * 1000;
      let removedRevisions = 0;
      let removedObjects = 0;
      for (const id of await this.revisions.listAll()) {
        if (liveRevisions.has(id)) continue;
        try {
          const rev = await this.revision(id);
          if (Date.parse(rev.createdAt) > cutoff) continue;
        } catch {
          continue;
        }
        await this.revisions.remove(id);
        removedRevisions++;
      }
      for (const hash of await this.objects.listAll()) {
        if (liveObjects.has(hash)) continue;
        try {
          const stat = await fs.stat(this.objects.objectPath(hash));
          if (stat.mtimeMs > cutoff) continue;
        } catch {
          continue;
        }
        await this.objects.remove(hash);
        removedObjects++;
      }
      return { revisions: removedRevisions, objects: removedObjects };
    });
  }

  /** Replace the project's shared brand settings (validated with the manifest). */
  async setBrand(brand: ProjectManifest['brand']): Promise<void> {
    return this.run(async () => {
      await this.commit((m) => {
        m.brand = structuredClone(brand);
      });
    });
  }

  async rename(name: string): Promise<void> {
    return this.run(async () => {
      await this.commit((m) => {
        m.name = name.trim().slice(0, 120);
      });
    });
  }
}
