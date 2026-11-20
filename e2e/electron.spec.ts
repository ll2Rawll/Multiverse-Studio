/**
 * Desktop end-to-end test: launches the built Electron app and walks the main journey
 * through the real window, preload bridge, IPC validation, engine worker and mvpreview:
 * protocol. Native dialogs are replaced in the main process so the test runs unattended.
 *
 *   npm run build && npx playwright test -c e2e/playwright.config.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function invoke<T>(page: Page, channel: string, input: unknown): Promise<T> {
  const result = await page.evaluate(([c, i]) => (window as unknown as { multiverse: { invoke(c: string, i: unknown): Promise<unknown> } }).multiverse.invoke(c as string, i), [channel, input] as const);
  const r = result as { ok: boolean; value?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message);
  return r.value as T;
}

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), 'mv-electron-'));
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, MULTIVERSE_USER_DATA: userData } });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
});

test('sample → shared change → conflict → export', async () => {
  await page.getByRole('button', { name: /Create manually/ }).click();
  await page.getByRole('button', { name: 'create the sample project' }).click();
  await expect(page.locator('.line-item', { hasText: 'Bold' })).toBeVisible();
  await page.getByRole('button', { name: 'Close tour' }).click();

  // Previews are served from mvpreview:// inside sandboxed frames.
  const frame = page.frameLocator('iframe[title="Bold — live preview"]');
  await expect(frame.getByText('Try it free')).toBeVisible();
  expect(await page.locator('iframe[title="Bold — live preview"]').getAttribute('src')).toMatch(/^mvpreview:\/\/t[0-9a-f]{20}\//);
  expect(await page.locator('iframe[title="Bold — live preview"]').getAttribute('sandbox')).toBe('allow-scripts allow-forms');

  // The preview cannot reach the bridge.
  const frameHandle = page.frames().find((f) => f.url().startsWith('mvpreview://'));
  expect(await frameHandle!.evaluate(() => typeof (window as unknown as { multiverse?: unknown }).multiverse)).toBe('undefined');

  // A shared change through the real IPC path, then the UI's Save button.
  const project = await invoke<{ id: string }>(page, 'projects.view', { projectId: (await invoke<{ id: string }[]>(page, 'projects.recent', {}))[0]!.id });
  await page.locator('.line-item.is-shared .line-main').click();
  const shared = await invoke<{ text: string }>(page, 'files.read', { projectId: project.id, ref: { kind: 'line', lineId: 'shared' }, path: 'index.html' });
  await invoke(page, 'files.write', { projectId: project.id, lineId: 'shared', path: 'index.html', text: shared.text.split('Kiln').join('Kilnworks') });
  await page.getByRole('button', { name: /Save shared change/ }).first().click();
  await expect(page.getByText(/Applied to Minimal, Editorial, Bold/)).toBeVisible();
  await expect(frame.getByText('Kilnworks').first()).toBeVisible();

  // A genuine conflict.
  const s2 = await invoke<{ text: string }>(page, 'files.read', { projectId: project.id, ref: { kind: 'line', lineId: 'shared' }, path: 'index.html' });
  await invoke(page, 'files.write', { projectId: project.id, lineId: 'shared', path: 'index.html', text: s2.text.replace('Plan work that ships.', 'Built for growing teams.') });
  await page.getByRole('button', { name: /Save shared change/ }).first().click();
  await page.getByRole('button', { name: 'Review conflict' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Resolve conflicts in Editorial' });
  await dialog.getByRole('button', { name: 'Use Shared’s version' }).click();
  await dialog.getByRole('button', { name: 'Finish and apply' }).click();
  await expect(page.getByText('Editorial is up to date')).toBeVisible();

  // Export with the folder dialog replaced in the main process.
  const exportParent = await mkdtemp(path.join(os.tmpdir(), 'mv-export-'));
  await app.evaluate(({ dialog: d }, dir) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof d.showOpenDialog;
  }, exportParent);
  await page.locator('.line-item', { hasText: 'Bold' }).locator('.line-main').click();
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.getByRole('menuitem', { name: /Export Bold/ }).click();
  await page.getByRole('dialog', { name: /Export/ }).getByRole('button', { name: 'Export…' }).click();
  await expect(page.getByText('Exported Bold')).toBeVisible();
  const [folder] = await readdir(exportParent);
  const html = await readFile(path.join(exportParent, folder!, 'index.html'), 'utf8');
  expect(html).toContain('Kilnworks');
  expect(html).toContain('Built for growing teams.');
});

test('the project is still there after a restart', async () => {
  await app.close();
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, MULTIVERSE_USER_DATA: userData } });
  page = await app.firstWindow();
  await page.locator('.recent-open').first().click();
  await expect(page.locator('.line-item', { hasText: 'Editorial' })).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.timeline-entry', { hasText: 'Conflicts resolved' }).first()).toBeVisible();
});
