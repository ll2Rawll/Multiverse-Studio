/**
 * Task-level execution permissions. Routine actions the user granted for a task run without asking
 * again; anything else pauses the task and asks. The agent has no tools at all for publishing,
 * purchases, credentials or files outside the project, so those can never be performed by a task.
 */
export interface TaskPermissions {
  /** Read the selected project (always on: needed for any task). */
  readProject: true;
  /** Edit the task's working alternative (Build mode). */
  editAlternative: boolean;
  /** Run the project's own build, test and dev scripts. */
  runBuildAndTests: boolean;
  /** Install the dependencies the project declares or the task requests. */
  installDependencies: boolean;
  /** Start and inspect the isolated preview (dev server and browser checks). */
  operatePreview: boolean;
}

export const DEFAULT_PERMISSIONS: TaskPermissions = { readProject: true, editAlternative: true, runBuildAndTests: true, installDependencies: false, operatePreview: true };
/** Autopilot: every routine permission. Commands outside them, and anything external, still ask. */
export const AUTOPILOT_PERMISSIONS: TaskPermissions = { readProject: true, editAlternative: true, runBuildAndTests: true, installDependencies: true, operatePreview: true };
export const READ_ONLY_PERMISSIONS: TaskPermissions = { readProject: true, editAlternative: false, runBuildAndTests: false, installDependencies: false, operatePreview: false };

export type CommandClass =
  | { kind: 'script'; script: string; permission: 'runBuildAndTests' }
  | { kind: 'install'; packages: string[]; permission: 'installDependencies' }
  | { kind: 'node-file'; file: string; permission: 'runBuildAndTests' }
  | { kind: 'other'; permission: 'approval'; reason: string };

const PM = new Set(['npm', 'pnpm', 'yarn']);
const SAFE_SCRIPT = /^[A-Za-z0-9:_.-]{1,60}$/;

/** Classify a command against the project's package.json scripts. */
export function classifyCommand(program: string, args: string[], scripts: Record<string, string>): CommandClass {
  const name = program.toLowerCase().replace(/\.(exe|cmd)$/, '');
  if (PM.has(name)) {
    const [verb, ...rest] = args;
    if ((verb === 'test' || verb === 't') && scripts.test) return { kind: 'script', script: 'test', permission: 'runBuildAndTests' };
    if ((verb === 'run' || verb === 'run-script') && rest[0] && SAFE_SCRIPT.test(rest[0]) && scripts[rest[0]]) return { kind: 'script', script: rest[0], permission: 'runBuildAndTests' };
    if (name !== 'npm' && verb && SAFE_SCRIPT.test(verb) && scripts[verb]) return { kind: 'script', script: verb, permission: 'runBuildAndTests' };
    if (verb === 'install' || verb === 'i' || verb === 'ci' || verb === 'add') {
      const packages = rest.filter((a) => !a.startsWith('-'));
      const flagsOk = rest.filter((a) => a.startsWith('-')).every((f) => /^(--save-dev|-D|--save|-S|--no-audit|--no-fund|--save-exact|-E)$/.test(f));
      const namesOk = packages.every((p) => /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[A-Za-z0-9^~<>=.*-]+)?$/.test(p));
      if (flagsOk && namesOk) return { kind: 'install', packages, permission: 'installDependencies' };
      return { kind: 'other', permission: 'approval', reason: 'This install uses package sources or options outside the routine permission (only registry package names are covered).' };
    }
    return { kind: 'other', permission: 'approval', reason: `“${[program, ...args].join(' ')}” is not one of this project’s scripts.` };
  }
  if (name === 'node' && args[0] && !args[0].startsWith('-') && !args[0].includes('..') && !/^([a-zA-Z]:|\/)/.test(args[0])) {
    return { kind: 'node-file', file: args[0], permission: 'runBuildAndTests' };
  }
  return { kind: 'other', permission: 'approval', reason: `Running ${program} is outside the routine permissions for this task.` };
}

export function describePermissions(p: TaskPermissions): string[] {
  const out = ['Read this project'];
  if (p.editAlternative) out.push('Edit its task alternative');
  if (p.runBuildAndTests) out.push('Run the project’s build, tests and scripts');
  if (p.installDependencies) out.push('Install dependencies');
  if (p.operatePreview) out.push('Run and inspect the preview');
  return out;
}
