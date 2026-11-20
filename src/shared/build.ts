/** Build workspace: terminal commands, scripts and dev servers run in a version's run folder. */
export interface BuildProcessView {
  id: string;
  kind: 'command' | 'dev-server';
  label: string;
  lineId: string;
  startedAt: number;
  status: 'running' | 'starting' | 'ready' | 'exited' | 'failed';
  exitCode: number | null;
  /** Dev servers: the local address once it is listening. */
  url: string | null;
  port: number | null;
}

export interface BuildStateView {
  projectId: string;
  lineId: string;
  /** Folder on disk where commands run (a copy of the version, synced before each command). */
  runFolder: string;
  hasPackageJson: boolean;
  scripts: Record<string, string>;
  dependenciesInstalled: boolean;
  /** Which script the dev server uses, or null when there is none (static sites use the built-in preview). */
  devScript: string | null;
  processes: BuildProcessView[];
}

export interface BuildOutputView {
  output: string;
  truncated: boolean;
  process: BuildProcessView;
}

export interface BuildCollectView {
  changed: string[];
  added: string[];
  deleted: string[];
  skipped: { path: string; reason: string }[];
  conflicts: { path: string; reason: string }[];
}
