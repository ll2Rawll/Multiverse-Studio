/**
 * Measured validation kept per universe: each test run records the exact files it ran on, so a
 * result is shown as current only while those files are unchanged.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TestRunView } from '../shared/outcomes';

const FILE = path.join('validation', 'tests.json');
const KEEP = 200;

/** Files a test run depends on: everything except dependencies, timelines and stories. */
export function codeHash(tree: ReadonlyMap<string, string>): string {
  const h = createHash('sha256');
  for (const [p, b] of [...tree].sort(([a], [c]) => a.localeCompare(c))) if (!/^(node_modules|sequences|stories)\//.test(p)) h.update(`${p}\u0000${b}\n`);
  return h.digest('hex').slice(0, 20);
}

export async function readTestRuns(projectDir: string): Promise<TestRunView[]> {
  try {
    const list = JSON.parse(await fs.readFile(path.join(projectDir, FILE), 'utf8')) as TestRunView[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const chains = new Map<string, Promise<unknown>>();

export function addTestRun(projectDir: string, run: TestRunView): Promise<void> {
  const next = (chains.get(projectDir) ?? Promise.resolve()).then(async () => {
    const list = [run, ...(await readTestRuns(projectDir))].slice(0, KEEP);
    const file = path.join(projectDir, FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(list, null, 2));
    await fs.rename(`${file}.tmp`, file);
  });
  chains.set(projectDir, next.catch(() => undefined));
  return next;
}
