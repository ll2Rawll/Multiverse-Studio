/**
 * UI state (zustand). Project content and history live in the engine; this store only
 * holds the current view model plus interface state such as selection, workspace,
 * panel sizes and preview settings — which is why switching workspaces is instant.
 */
import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  SHARED_LINE_ID,
  type CombineDestination,
  type CombineResult,
  type FileAction,
  type SectionStep,
  type AppInfo,
  type AppSettings,
  type ContentRef,
  type ProjectView,
  type PropagationReport,
  type RecentProject,
  type TemplateInfo,
} from '../../shared/types';
import type { Viewport } from '../lib/util';

/** Workspaces in the rail. Explore and Compare & Combine are the two views of Multiverse. */
export type Workspace = 'home' | 'build' | 'design' | 'video' | 'assets' | 'explore' | 'compare' | 'history' | 'stories';
export type RailItem = 'home' | 'build' | 'design' | 'video' | 'assets' | 'multiverse' | 'history' | 'stories';
export type SettingsTab = 'appearance' | 'providers' | 'models' | 'tasks' | 'usage' | 'apps' | 'publishing' | 'media' | 'storage';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  sticky?: boolean;
}

export type DialogState =
  | { kind: 'create-alternative'; from: ContentRef; suggestedName?: string }
  | { kind: 'rename-alternative'; lineId: string }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'conflicts'; lineId: string }
  | { kind: 'restore'; checkpointId: string; lineIds: string[] }
  | { kind: 'checkpoint' }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'import-report'; skipped: { path: string; reason: string }[]; storagePath: string; originalPath: string; fileCount: number }
  | { kind: 'export'; ref: ContentRef; label: string }
  | { kind: 'publish'; ref: ContentRef }
  | { kind: 'recovery' }
  | { kind: 'project-info' }
  | { kind: 'damaged'; projectId: string; message: string; details: string[] }
  | { kind: 'quick-open' }
  | { kind: 'new-file'; lineId: string }
  | { kind: 'new-from-template'; templateId: string };

export interface SaveState {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message: string | null;
  at: number;
}

export interface CompareState {
  mode: 'compare' | 'combine';
  left: ContentRef;
  right: ContentRef;
  view: 'previews' | 'source' | 'outcomes';
  file: string | null;
}

export interface CombineDraft {
  destination: CombineDestination;
  source: ContentRef;
  files: Record<string, FileAction>;
  sections: SectionStep[];
  edits: Record<string, string>;
  description: string;
  stage: 'pick' | 'review' | 'done';
  tab: 'sections' | 'files';
  result: CombineResult | null;
}

export interface StudioState {
  ready: boolean;
  info: AppInfo | null;
  settings: AppSettings;
  recent: RecentProject[];
  templates: TemplateInfo[];
  project: ProjectView | null;
  workspace: Workspace;
  exploreView: 'grid' | 'graph' | 'updates';
  selectedLineId: string;
  selectedFile: Record<string, string>;
  viewport: Viewport;
  cardViewports: Record<string, Viewport>;
  syncScroll: boolean;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  narrow: boolean;
  compareSelection: string[];
  compare: CompareState;
  combine: CombineDraft | null;
  historySelection: string | null;
  previewVersions: Record<string, number>;
  highlights: Record<string, number>;
  livePriority: string[];
  toasts: Toast[];
  dialog: DialogState | null;
  tour: { open: boolean; step: number; done: string[]; minimized?: boolean };
  save: SaveState;
  lastReport: PropagationReport | null;
  busy: string | null;
  editorReveal: { path: string; line: number; column: number; at: number } | null;
}

export const useStudio = create<StudioState>(() => ({
  ready: false,
  info: null,
  settings: DEFAULT_SETTINGS,
  recent: [],
  templates: [],
  project: null,
  workspace: 'explore',
  exploreView: 'grid',
  selectedLineId: SHARED_LINE_ID,
  selectedFile: {},
  viewport: 'desktop',
  cardViewports: {},
  syncScroll: false,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  narrow: false,
  compareSelection: [],
  compare: { mode: 'compare', left: { kind: 'line', lineId: SHARED_LINE_ID }, right: { kind: 'line', lineId: SHARED_LINE_ID }, view: 'previews', file: null },
  combine: null,
  historySelection: null,
  previewVersions: {},
  highlights: {},
  livePriority: [],
  toasts: [],
  dialog: null,
  tour: { open: false, step: 0, done: [] },
  save: { status: 'idle', message: null, at: 0 },
  lastReport: null,
  busy: null,
  editorReveal: null,
}));

export const set = useStudio.setState;
export const get = useStudio.getState;

let toastId = 1;
export function toast(t: Omit<Toast, 'id'>): number {
  const id = toastId++;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
  if (!t.sticky) setTimeout(() => dismissToast(id), t.action ? 9000 : 5000);
  return id;
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function openDialog(dialog: DialogState): void {
  set({ dialog });
}

export function closeDialog(): void {
  set({ dialog: null });
}

export function bumpPreviews(lineIds: string[]): void {
  if (lineIds.length === 0) return;
  set((s) => {
    const next = { ...s.previewVersions };
    for (const id of lineIds) next[id] = (next[id] ?? 0) + 1;
    return { previewVersions: next };
  });
}

export function highlightLines(lineIds: string[]): void {
  const now = Date.now();
  set((s) => {
    const next = { ...s.highlights };
    for (const id of lineIds) next[id] = now;
    return { highlights: next };
  });
}
