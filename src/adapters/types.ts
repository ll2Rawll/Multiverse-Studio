/**
 * Project adapters describe one kind of project (static web today; presentations or
 * video later). The revision engine is format-agnostic: it stores trees of files and
 * merges text. Adapters add format knowledge on top: what a valid project looks like,
 * what to preview, how to diagnose files, which references must travel with an export,
 * and — optionally — structural combining of parts of a document.
 */
import type { Diagnostic, SectionAnalysis, SectionInfo, SectionStep, SectionTarget, CombineWarning } from '../shared/types';
import type { TreeReader } from './web/sections';
import type { LocalReference } from './web/refs';

export type { TreeReader };

export interface StructuralCombine {
  listSections(path: string, text: string): SectionInfo[];
  analyze(input: {
    source: TreeReader;
    sourcePath: string;
    sectionKey: string;
    dest: TreeReader;
    destPath: string;
    target?: SectionTarget;
  }): Promise<SectionAnalysis>;
  transplant(source: TreeReader, dest: TreeReader, step: SectionStep): Promise<{ files: Map<string, string>; copyAssets: string[]; warnings: CombineWarning[] }>;
}

export interface ProjectAdapter {
  id: string;
  displayName: string;
  /** Decide whether a set of files is a valid project of this kind; returns the entry file. */
  validate(paths: readonly string[]): { ok: true; entry: string } | { ok: false; message: string };
  entryFile(paths: Iterable<string>): string | null;
  diagnostics(path: string, text: string): Diagnostic[];
  references(path: string, text: string): LocalReference[];
  /** Files that can hold structural sections (e.g. HTML documents). */
  structuralFiles(paths: readonly string[]): string[];
  structural: StructuralCombine | null;
}
