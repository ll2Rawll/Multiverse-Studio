// End-to-end journey through the real UI in Chromium, using the browser harness
// (the real StudioService behind HTTP instead of Electron IPC). Run:
//   npm run test:e2e:harness
// It covers: sample project, creating an alternative, editing the Shared version,
// clean propagation, a conflict and its resolution, combining into a new alternative,
// restart persistence, export (opened independently), importing a folder, keyboard
// navigation, reduced motion and reduced transparency.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { audit } from './a11y.mjs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright'));
}

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5299;
const PREVIEW_PORT = 5300;
// The workspace sits in its own temporary folder, so the harness's sibling folders (connector settings, cache) are fresh each run.
const workspace = path.join(await mkdtemp(path.join(os.tmpdir(), 'mv-e2e-')), 'ws');
await mkdir(workspace, { recursive: true });
const shots = process.env.E2E_SHOTS ?? null;
const results = [];

function startServer() {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'e2e', 'harness', 'server.ts')], {
    cwd: root,
    // A fixed mock-provider port keeps saved connections valid across the restarts below.
    env: { ...process.env, HARNESS_PORT: String(PORT), HARNESS_PREVIEW_PORT: String(PREVIEW_PORT), HARNESS_MOCK_PROVIDER_PORT: String(PREVIEW_PORT + 1), HARNESS_WORKSPACE: workspace },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('harness previews')) resolve(child);
    });
  });
}

// E2E_ONLY=<regex> runs only the matching self-contained steps (for working on one area); a full run has none.
const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;

async function step(name, fn) {
  if (only && !only.test(name)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    if (shots) await page.screenshot({ path: path.join(shots, `e2e-failure.png`) }).catch(() => undefined);
    console.log(`  ✗ ${name}\n    ${String(error?.message ?? error).split('\n').slice(0, 6).join('\n    ')}`);
    throw error;
  }
}

async function expectEventually(check, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

const frameText = async (page, title) => page.frameLocator(`iframe[title="${title}"]`).locator('body').innerText({ timeout: 15000 });

let server = await startServer();
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const context = await browser.newContext({ viewport: { width: 1480, height: 920 } });
let page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

console.log('Multiverse Studio — harness journey');
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);

  await step('1. Choose how to start (three paths), then open the sample project', async () => {
    for (const name of ['Start with AI', 'Create manually', 'Open existing work']) await page.getByRole('button', { name: new RegExp(name) }).waitFor();
    await page.getByRole('button', { name: /Start with AI/ }).click();
    // Provider setup can be skipped; the description is prepared, never sent automatically.
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await page.getByLabel('Describe the project').waitFor();
    await page.getByRole('button', { name: /Open existing work/ }).click();
    await page.getByRole('button', { name: 'Open a project folder…' }).waitFor();
    await page.getByRole('button', { name: 'New video from media files…' }).waitFor();
    await page.getByRole('button', { name: /Create manually/ }).click();
    for (const group of ['Websites', 'Apps', 'Video']) await page.getByRole('region', { name: group }).waitFor();
    await page.getByRole('region', { name: 'Video' }).getByRole('button', { name: /Launch video/ }).waitFor();
    await page.getByRole('button', { name: 'create the sample project' }).click();
    for (const name of ['Minimal', 'Editorial', 'Bold']) await page.locator('.line-item', { hasText: name }).first().waitFor();
    await page.getByRole('button', { name: 'Close tour' }).click();
    assert.match(await frameText(page, 'Bold — live preview'), /Plan work that ships/);
  });

  await step('2. Create another alternative', async () => {
    await page.locator('.line-item.is-shared .line-main').click();
    await page.getByRole('button', { name: 'Create alternative' }).click();
    const dialog = page.getByRole('dialog', { name: 'New alternative' });
    await dialog.getByLabel('Name').fill('Playground');
    await dialog.getByRole('button', { name: 'Create alternative' }).click();
    await page.locator('.line-item', { hasText: 'Playground' }).waitFor();
    await page.getByText('Created Playground').waitFor();
  });

  const editShared = async (from, to) => {
    await page.locator('.line-item.is-shared .line-main').click();
    await page.keyboard.press('Control+2');
    await page.locator('.tree-row', { hasText: 'index.html' }).click();
    const editor = page.getByTestId('code-editor');
    await editor.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="code-editor"]')?.value.length > 100);
    await editor.evaluate((el, [a, b]) => {
      if (!el.value.includes(a)) throw new Error(`"${a}" not found in shared index.html`);
      el.value = el.value.replace(a, b);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [from, to]);
    await page.locator('.edit-target').getByRole('button', { name: 'Save shared change' }).waitFor();
    await page.waitForTimeout(700);
  };

  await step('3. Edit the Shared version (kept as a draft until saved)', async () => {
    await editShared('Simple pricing for small teams.', 'Simple, fair pricing for small teams.');
    await page.getByText('Shared draft not saved yet').waitFor();
    await page.keyboard.press('Control+6');
    assert.doesNotMatch(await frameText(page, 'Minimal — live preview'), /Simple, fair pricing/);
  });

  await step('4. Save it and confirm clean propagation', async () => {
    await page.getByRole('button', { name: /Save shared change/ }).first().click();
    await page.getByText(/Applied to Minimal, Editorial, Bold, Playground/).waitFor();
    for (const name of ['Minimal', 'Editorial', 'Bold']) {
      await page.locator('.line-item', { hasText: name }).first().locator('.line-main').click();
      await page.waitForTimeout(400);
      const text = await frameText(page, `${name} — live preview`);
      assert.match(text, /Simple, fair pricing for small teams/, `${name} received the shared change`);
    }
    // Independent layouts remain intact.
    assert.match(await frameText(page, 'Bold — live preview'), /Try it free/);
    assert.match(await frameText(page, 'Editorial — live preview'), /Studio Notes/i);
    if (shots) await page.screenshot({ path: path.join(shots, 'e2e-propagated.png') });
  });

  await step('5. Create and resolve a conflict', async () => {
    await editShared('Plan work that ships.', 'Built for growing teams.');
    await page.getByRole('button', { name: /Save shared change/ }).first().click();
    await page.getByText(/Editorial needs a decision \(1 conflict\)/).waitFor();
    await page.locator('.line-item', { hasText: 'Editorial' }).locator('.status-badge', { hasText: '1 conflict' }).waitFor();
    // While unresolved, Editorial keeps its own coherent heading.
    await page.keyboard.press('Control+6');
    assert.match(await frameText(page, 'Editorial — live preview'), /Built for independent makers/);
    await page.getByRole('button', { name: 'Review conflict' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Resolve conflicts in Editorial' });
    await dialog.getByText('Built for independent makers.').first().waitFor();
    await dialog.getByText('Built for growing teams.').first().waitFor();
    await dialog.getByRole('button', { name: 'Keep both (Editorial first)' }).click();
    await dialog.getByText('Everything is decided.').waitFor();
    await dialog.getByRole('button', { name: 'Finish and apply' }).click();
    await page.getByText('Editorial is up to date').waitFor();
    const text = await frameText(page, 'Editorial — live preview');
    assert.match(text, /Built for independent makers/);
    assert.match(text, /Built for growing teams/);
  });

  await step('6. Combine Bold’s footer into a new alternative based on Minimal', async () => {
    await page.keyboard.press('Control+6');
    await page.getByRole('radio', { name: 'Compare & Combine' }).click();
    await page.getByRole('radio', { name: 'Combine', exact: true }).click();
    const left = page.locator('.combine-left');
    await left.getByRole('radio', { name: 'New alternative' }).click();
    await left.getByRole('button', { name: /Starting point/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Minimal', exact: true }).click();
    await left.getByLabel('Name').fill('Minimal + Bold footer');
    await left.getByRole('button', { name: /^Source/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Bold', exact: true }).click();
    await page.locator('.section-row', { hasText: '#site-footer' }).click();
    await page.getByText(/This section may rely on JavaScript/).waitFor();
    await page.getByText('fonts/poppins-bold.woff').first().waitFor();
    await page.getByRole('button', { name: 'Add to combination' }).click();
    await page.getByRole('button', { name: 'Review combination' }).click();
    await page.getByText(/3 files will change/).waitFor();
    assert.match(await frameText(page, 'Proposed result'), /Plan calmer, starting this week/);
    if (shots) await page.screenshot({ path: path.join(shots, 'e2e-combine-review.png') });
    await page.getByRole('button', { name: 'Apply combination' }).click();
    await page.getByRole('heading', { name: 'Created Minimal + Bold footer' }).waitFor();
    await page.locator('.line-item', { hasText: 'Minimal + Bold footer' }).waitFor();
    await page.getByRole('button', { name: 'Done' }).click();
  });

  await step('7. Restart and confirm persistence', async () => {
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
    server = await startServer();
    await page.reload();
    await page.locator('.recent-open').first().click();
    for (const name of ['Minimal', 'Editorial', 'Bold', 'Playground', 'Minimal + Bold footer']) await page.locator('.line-item', { hasText: name }).first().waitFor();
    await page.keyboard.press('Control+7');
    await page.locator('.timeline-entry', { hasText: 'Before combining into Minimal + Bold footer' }).waitFor();
    await page.locator('.timeline-entry', { hasText: 'Conflicts resolved' }).first().waitFor();
  });

  const exportDir = path.join(workspace, '..', `mv-export-${Date.now()}`);
  await step('8. Export and open the result independently', async () => {
    await page.locator('.line-item', { hasText: 'Minimal + Bold footer' }).locator('.line-main').click();
    await page.getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: /Export Minimal \+ Bold footer/ }).click();
    const dialog = page.getByRole('dialog', { name: /Export/ });
    await dialog.getByLabel('Destination path (test harness)').fill(exportDir);
    await dialog.getByRole('button', { name: 'Export…' }).click();
    await page.getByText('Exported Minimal + Bold footer').waitFor();
    const files = await readdir(exportDir, { recursive: true });
    assert.ok(files.includes('index.html'));
    assert.ok(!files.some((f) => /project\.json|objects|revisions/.test(f)), 'no app metadata exported');
    const viewer = await context.newPage();
    const failed = [];
    viewer.on('requestfailed', (r) => failed.push(r.url()));
    await viewer.goto(pathToFileURL(path.join(exportDir, 'index.html')).href);
    await viewer.waitForLoadState('load');
    assert.deepEqual(failed, [], 'every local asset loads from the exported folder');
    assert.match(await viewer.locator('footer.footer-bold').innerText(), /Plan calmer/);
    const font = await viewer.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
    });
    assert.ok(font.some((f) => /Poppins/.test(f)), `Poppins loaded (loaded: ${font.join(', ')})`);
    if (shots) await viewer.screenshot({ path: path.join(shots, 'e2e-exported-site.png'), fullPage: false });
    await viewer.close();
  });

  await step('Import a real folder (original left untouched)', async () => {
    const source = path.join(workspace, '..', `mv-import-${Date.now()}`);
    await cp(path.join(root, 'sample', 'shared'), source, { recursive: true });
    const before = await readFile(path.join(source, 'index.html'), 'utf8');
    await fetch(`http://127.0.0.1:${PORT}/api/harness/next-import`, { method: 'POST', body: JSON.stringify({ path: source }) });
    await page.locator('.project-switcher').click();
    await page.getByRole('menuitem', { name: 'Open project…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Project imported' });
    await dialog.getByText('Your original folder was not changed.').waitFor();
    await dialog.getByText(source).waitFor();
    await dialog.getByRole('button', { name: 'Start exploring' }).click();
    assert.equal(await readFile(path.join(source, 'index.html'), 'utf8'), before);
    await page.getByRole('button', { name: /Create your first|New alternative/ }).first().waitFor();
  });

  await step('Keyboard: workspace rail, Multiverse switch, menus and dialog focus', async () => {
    for (const [key, label] of [['1', 'Home'], ['2', 'Build'], ['3', 'Design'], ['7', 'History'], ['6', 'Multiverse']]) {
      await page.keyboard.press(`Control+${key}`);
      assert.equal(await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: label }).getAttribute('aria-current'), 'page', `Ctrl+${key} opens ${label}`);
    }
    const explore = page.getByRole('radio', { name: 'Explore' });
    await explore.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('radio', { name: 'Compare & Combine' }).getAttribute('aria-checked'), 'true');
    await page.keyboard.press('ArrowLeft');
    const settings = page.getByRole('button', { name: 'Settings' });
    await settings.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Settings' }).waitFor();
    // Focus stays trapped in the dialog.
    for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Settings', 'focus returns to the trigger');
    const more = page.getByRole('button', { name: 'More actions' }).first();
    await more.focus();
    await page.keyboard.press('ArrowDown');
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
  });

  await step('Reduced motion and reduced transparency', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Appearance', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Solid' }).click();
    await dialog.getByRole('radio', { name: 'Reduced', exact: true }).click();
    const styles = await page.evaluate(() => ({
      transparency: document.documentElement.dataset.transparency,
      motion: document.documentElement.dataset.motion,
      blur: getComputedStyle(document.querySelector('.sidebar')).backdropFilter,
      transition: getComputedStyle(document.querySelector('.segmented-thumb')).transitionDuration,
    }));
    assert.deepEqual(styles, { transparency: 'reduced', motion: 'reduced', blur: 'none', transition: '0s' });
    await dialog.getByRole('radio', { name: 'Glass' }).click();
    await page.keyboard.press('Escape');
  });

  // AI flows run against the harness's local scripted provider (mocked: no real model is called).
  const base = `http://127.0.0.1:${PORT}`;
  const invoke = async (channel, input) => (await (await fetch(`${base}/api/invoke`, { method: 'POST', body: JSON.stringify({ channel, input }) })).json());
  const script = (steps) => fetch(`${base}/api/harness/mock-script`, { method: 'POST', body: JSON.stringify(steps) });

  await step('AI: connect a provider in Settings, assign models and ask a question (mock provider)', async () => {
    const mock = await (await fetch(`${base}/api/harness/mock-provider`)).json();
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Providers' }).click();
    await dialog.getByText(/keys are kept for this session only/).waitFor();
    await dialog.getByRole('button', { name: /OpenAI-compatible endpoint/ }).click();
    await dialog.getByLabel('Display name').fill('Local mock');
    await dialog.getByLabel('Base URL').fill(mock.url);
    await dialog.getByRole('button', { name: 'Save and test' }).click();
    await dialog.getByText('Connected. 4 models available.').waitFor();
    await dialog.getByRole('button', { name: 'Models', exact: true }).click();
    await dialog.getByLabel('Model for Assistant').selectOption({ label: 'mock/assistant — Local mock (unverified)' });
    await dialog.getByLabel('Model for Coding agent').selectOption({ label: 'mock/coder — Local mock (unverified)' });
    await page.keyboard.press('Escape');
    await expectEventually(async () => {
      const routing = (await invoke('ai.state', {})).value.routing;
      assert.equal(routing.assistant?.modelId, 'mock/assistant', 'both quick assignments are kept');
      assert.equal(routing.coding?.modelId, 'mock/coder');
    });
    await script([{ text: 'Three alternatives restyle the same Shared page.' }]);
    await page.getByLabel('What do you want to create or change?').first().fill('How do the alternatives differ?');
    await page.keyboard.press('Enter');
    await page.locator('.ai-assistant').getByText('Three alternatives restyle the same Shared page.').waitFor({ timeout: 15000 });
    await page.locator('.ai-state', { hasText: 'Completed' }).first().waitFor();
    const state = await invoke('ai.state', {});
    assert.ok(!JSON.stringify(state).includes('sk-'), 'no key material in state');
  });

  await step('AI: a Build task edits a task alternative, checks it in a browser and asks before other commands', async () => {
    await script([
      { calls: [{ name: 'read_file', args: { path: 'index.html', start_line: 36, end_line: 44 } }] },
      { calls: [{ name: 'edit_file', args: { path: 'index.html', edits: [{ find: 'Plan work that ships.</h1>', replace: 'Plan work that ships sooner.</h1>' }] } }] },
      { calls: [{ name: 'run_browser_check', args: { page: '/', steps: [{ action: 'expect-text', selector: 'h1', text: 'ships sooner' }] } }] },
      { calls: [{ name: 'run_command', args: { program: 'git', args: ['status'] } }] },
      { text: 'Updated the headline and checked it in a browser.' },
    ]);
    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.getByRole('radio', { name: 'Build' }).click();
    await page.locator('#ai-prompt').fill('Change the headline to “ships sooner”');
    await page.getByRole('button', { name: 'Start task' }).click();
    const approval = page.getByRole('alertdialog', { name: 'Permission needed' });
    await approval.waitFor({ timeout: 30000 });
    assert.match(await approval.innerText(), /git status/);
    await approval.getByRole('button', { name: 'Decline' }).click();
    await page.locator('.ai-state', { hasText: 'Completed' }).first().waitFor({ timeout: 30000 });
    const projectId = (await invoke('projects.recent', {})).value[0].id;
    const tasks = (await invoke('ai.tasks.list', { projectId })).value;
    const task = (await invoke('ai.tasks.get', { projectId, taskId: tasks[0].id })).value;
    assert.deepEqual(task.filesChanged, ['index.html']);
    assert.ok(task.messages.some((m) => m.toolResult?.name === 'run_browser_check' && m.toolResult.ok), 'the real browser check passed');
    const working = (await invoke('files.read', { projectId, ref: { kind: 'line', lineId: task.workingLineId }, path: 'index.html' })).value.text;
    const origin = (await invoke('files.read', { projectId, ref: { kind: 'line', lineId: task.originLineId }, path: 'index.html' })).value.text;
    assert.match(working, /ships sooner/);
    assert.doesNotMatch(origin, /ships sooner/, 'the user’s version is untouched');
    await page.getByRole('button', { name: 'Review changes' }).click();
    await page.getByRole('radio', { name: 'Compare & Combine', checked: true }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'ai-build-review.png') });
  });

  let siteId = null;
  await step('Templates: create a website from Home and land in Design', async () => {
    await page.keyboard.press('Control+1');
    await page.getByRole('heading', { name: 'Start something new' }).waitFor();
    await page.getByRole('button', { name: /Landing page/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New landing page' });
    await dialog.getByLabel('Project name').fill('Launch site');
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.design-body').waitFor();
    siteId = (await invoke('projects.recent', {})).value.find((r) => r.name === 'Launch site').id;
    assert.match(await frameText(page, 'index.html in Design'), /Meeting notes that write themselves/);
    for (const label of ['Header', 'Hero', 'Features', 'Pricing']) await page.locator('.outline-label', { hasText: label }).first().waitFor();
  });

  const readSite = async (file) => (await invoke('files.read', { projectId: siteId, ref: { kind: 'line', lineId: 'shared' }, path: file })).value.text;

  await step('Design: select on the canvas, edit text in place, and the HTML source changes exactly', async () => {
    const canvas = page.frameLocator('iframe[title="index.html in Design"]');
    await canvas.locator('h1').click();
    await page.locator('.element-head h2', { hasText: /h1: Meeting notes/ }).waitFor();
    await canvas.locator('h1').dblclick();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Notes that write themselves');
    await page.keyboard.press('Enter');
    await expectEventually(async () => assert.match(await readSite('index.html'), /data-mv-id="hero-title">Notes that write themselves<\/h1>/));
    assert.match(await frameText(page, 'index.html in Design'), /Notes that write themselves/);
    // Only the heading text changed: everything else in the file is byte-for-byte the same.
    const original = await readFile(path.join(root, 'templates', 'landing', 'index.html'), 'utf8');
    assert.equal(await readSite('index.html'), original.replace('>Meeting notes that write themselves</h1>', '>Notes that write themselves</h1>'));
  });

  await step('Design: edit text and a link in the inspector, style per breakpoint, then undo', async () => {
    await page.locator('.outline-label', { hasText: 'Start free' }).click();
    const panel = page.locator('.element-panel');
    await panel.getByLabel('Text', { exact: true }).fill('Try it free');
    await panel.getByLabel('Text', { exact: true }).press('Control+Enter');
    await expectEventually(async () => assert.match(await readSite('index.html'), />Try it free<\/a>/));
    await panel.getByLabel('Link address').fill('signup.html');
    await panel.getByLabel('Link address').press('Enter');
    await expectEventually(async () => assert.match(await readSite('index.html'), /href="signup.html"[^>]*data-mv-id="hero-cta"/));
    await page.getByRole('radio', { name: 'Mobile' }).click();
    await panel.getByLabel('Padding', { exact: true }).fill('10px 14px');
    await panel.getByLabel('Padding', { exact: true }).press('Enter');
    await expectEventually(async () => assert.match(await readSite('design.css'), /@media \(max-width: 600px\) \{\s*\[data-mv-id="hero-cta"\] \{\s*padding: 10px 14px;/));
    await page.getByRole('radio', { name: 'Desktop' }).click();
    await page.getByRole('button', { name: /^Undo / }).click();
    await expectEventually(async () => assert.doesNotMatch(await readSite('design.css'), /hero-cta/));
    assert.match(await readSite('index.html'), /href="signup.html"/, 'undo reverts one step at a time');
    assert.equal(await page.getByText('Could not apply the change').count(), 0, 'Enter followed by blur sends each value once');
  });

  await step('Design: insert a section from the library and change a theme token', async () => {
    await page.locator('.outline-label', { hasText: 'Pricing' }).first().click();
    await page.getByRole('radio', { name: 'Add' }).click();
    await page.getByRole('button', { name: /^Questions/ }).click();
    await expectEventually(async () => assert.match(await readSite('index.html'), /data-mv-section="faq"/));
    const html = await readSite('index.html');
    assert.ok(html.indexOf('data-mv-section="faq"') > html.indexOf('data-mv-id="pricing"'), 'inserted after the selected section');
    await page.getByRole('radio', { name: 'Theme' }).click();
    const accent = page.locator('.theme-panel').getByLabel('--mv-color-primary', { exact: true });
    await accent.fill('#c2410c');
    await accent.press('Enter');
    await expectEventually(async () => assert.match(await readSite('theme.css'), /--mv-color-primary:\s*#c2410c/));
    if (shots) await page.screenshot({ path: path.join(shots, 'm3-design.png') });
  });

  await step('Build: run terminal commands without a shell and bring a generated file in', async () => {
    await page.keyboard.press('Control+2');
    const input = page.getByLabel('Command', { exact: true });
    await input.fill('node -e "console.log(1 + 1)"');
    await input.press('Enter');
    await page.locator('.build-output', { hasText: /^2\s*$/ }).waitFor();
    await input.fill('node -v | cat');
    await input.press('Enter');
    await page.getByText(/Pipes \(\|\) are not supported/).waitFor();
    await input.fill(`node -e "require('fs').writeFileSync('robots.txt', 'User-agent: *')"`);
    await input.press('Enter');
    await page.locator('.proc-tab .proc-dot.is-exited').nth(1).waitFor();
    await page.getByRole('button', { name: 'Bring changes in' }).click();
    await page.getByText('Brought in 1 file').waitFor();
    assert.equal(await readSite('robots.txt'), 'User-agent: *');
  });

  await step('Build: an app’s dev server starts on a free port and its preview shows in the app', async () => {
    const source = path.join(workspace, '..', `mv-app-${Date.now()}`);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'index.html'), '<!doctype html><title>Counter</title><div id="root"></div><script type="module" src="/main.js"></script>');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'counter', private: true, scripts: { dev: 'node server.js', test: 'node --test' } }, null, 2));
    await writeFile(path.join(source, 'server.js'), "require('node:http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end('<h1>Served by the dev server</h1>'); }).listen(Number(process.env.PORT), process.env.HOST);\n");
    await fetch(`${base}/api/harness/next-import`, { method: 'POST', body: JSON.stringify({ path: source }) });
    await page.locator('.project-switcher').click();
    await page.getByRole('menuitem', { name: 'Open project…' }).click();
    await page.getByRole('dialog', { name: 'Project imported' }).getByRole('button', { name: 'Start exploring' }).click();
    await page.keyboard.press('Control+2');
    await page.getByRole('button', { name: 'Start dev server' }).click();
    const frame = page.frameLocator('iframe[title="App preview from the dev server"]');
    await frame.getByRole('heading', { name: 'Served by the dev server' }).waitFor({ timeout: 20000 });
    assert.match(await page.locator('.dev-url').innerText(), /^http:\/\/127\.0\.0\.1:\d+\/$/);
    if (shots) await page.screenshot({ path: path.join(shots, 'm3-build-dev-server.png') });
    await page.getByRole('button', { name: 'Stop the dev server' }).click();
    await page.getByRole('button', { name: 'Start dev server' }).waitFor();
  });

  const footage = path.join(workspace, '..', `mv-footage-${Date.now()}`);
  await step('Video: import media and build a timeline (bin, drag and drop, crossfade)', async () => {
    await mkdir(footage, { recursive: true });
    const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(footage, 'pattern.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x2266ff:s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(footage, 'blue.mp4')]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', path.join(footage, 'music.wav')]);
    await page.keyboard.press('Control+4');
    await page.getByRole('heading', { name: 'Start a sequence' }).waitFor();
    await page.getByRole('button', { name: /^Landscape/ }).click();
    await page.locator('.timeline').waitFor();
    await fetch(`${base}/api/harness/next-media`, { method: 'POST', body: JSON.stringify({ paths: ['pattern.mp4', 'blue.mp4', 'music.wav'].map((f) => path.join(footage, f)) }) });
    await page.getByRole('button', { name: 'Import media…' }).click();
    await page.getByText('Imported 3 files').waitFor();
    await page.getByRole('button', { name: 'Add pattern.mp4 to the end of the timeline' }).click();
    await page.locator('.tl-clip', { hasText: 'pattern.mp4' }).waitFor();
    await page.getByRole('button', { name: 'Add blue.mp4 to the end of the timeline' }).click();
    await page.locator('.tl-clip', { hasText: 'blue.mp4' }).waitFor();
    // Drag music from the bin onto the audio track.
    // (Native drag events, as Chromium sends them; Playwright's mouse-driven HTML5 drag is unreliable here.)
    await page.evaluate((mime) => {
      const src = [...document.querySelectorAll('.bin-item')].find((e) => e.textContent.includes('music.wav'));
      const dst = document.querySelector('.tl-lane[data-track-id="a1"]');
      const dataTransfer = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      if (!dataTransfer.types.includes(mime)) throw new Error('the bin item did not offer its asset');
      const r = dst.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 4, clientY: r.top + 20 };
      dst.dispatchEvent(new DragEvent('dragover', at));
      dst.dispatchEvent(new DragEvent('drop', at));
    }, 'application/x-mv-asset');
    await page.locator('.tl-row.is-audio .tl-clip', { hasText: 'music.wav' }).waitFor();
    // Crossfade into the blue clip.
    await page.locator('.tl-clip', { hasText: 'blue.mp4' }).click();
    await page.locator('.clip-inspector').getByLabel('Transition in').selectOption('crossfade');
    await expectEventually(async () => {
      const seq = (await invoke('sequences.get', { projectId: (await invoke('projects.recent', {})).value[0].id, lineId: 'shared', sequenceId: 'first-cut' })).value.sequence;
      const v1 = seq.tracks.find((t) => t.id === 'v1');
      assert.deepEqual(v1.clips.map((c) => c.start / 240000), [0, 4]);
      assert.equal(v1.clips[1].transitionIn.kind, 'crossfade');
      assert.equal(seq.tracks.find((t) => t.id === 'a1').clips.length, 1);
    });
    // The viewer shows real frames from the file.
    await page.waitForFunction(() => [...document.querySelectorAll('.player video')].some((v) => v.readyState >= 2 && v.videoWidth === 640));
  });

  await step('Video: split with S, undo with Ctrl+Z, add and edit a title, play', async () => {
    const lane = page.locator('.tl-lane[data-track-id="v1"]');
    const box = await lane.boundingBox();
    const zoom = await page.locator('input[aria-label="Timeline zoom"]').inputValue();
    await page.mouse.click(box.x + Number(zoom) * 2, box.y + box.height - 2);
    await page.locator('.tl-scroll').focus();
    await page.keyboard.press('s');
    await expectEventually(async () => assert.equal(await page.locator('.tl-row.is-video .tl-clip').count(), 3));
    await page.keyboard.press('Control+z');
    await expectEventually(async () => assert.equal(await page.locator('.tl-row.is-video .tl-clip').count(), 2));
    await page.keyboard.press('t');
    await page.locator('.tl-clip.is-text').waitFor();
    await page.locator('.tl-clip.is-text').click();
    const text = page.locator('.clip-inspector').getByLabel('Title text');
    await text.fill('Opening title');
    await text.press('Control+Enter');
    await page.locator('.tl-clip.is-text', { hasText: 'Opening title' }).waitFor();
    await page.locator('.player-text', { hasText: 'Opening title' }).waitFor();
    await page.locator('.tl-scroll').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Space');
    await page.waitForTimeout(800);
    await page.keyboard.press('Space');
    assert.ok((await page.locator('.player-time').innerText()).startsWith('00:00:') && !(await page.locator('.player-time').innerText()).startsWith('00:00:00'), 'playback advanced the playhead');
    if (shots) await page.screenshot({ path: path.join(shots, 'm4-video.png') });
  });

  await step('Video: export to MP4, follow progress, and check the file', async () => {
    await page.getByRole('button', { name: 'Export…' }).click();
    const dialog = page.getByRole('dialog', { name: /Export / });
    await dialog.getByLabel('Resolution').selectOption('480');
    await dialog.getByRole('button', { name: 'Export…' }).click();
    await page.locator('.job-item.is-completed').first().waitFor({ timeout: 60000 });
    await page.locator('.job-item.is-completed').first().getByText(/854×480 · 7\.0 s/).waitFor();
    const projectId = (await invoke('projects.recent', {})).value[0].id;
    const job = (await invoke('video.export.list', { projectId })).value[0];
    assert.equal(job.state, 'completed');
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', job.output]).toString());
    assert.deepEqual(info.streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
    assert.ok(Math.abs(Number(info.format.duration) - 7) < 0.15);
  });

  await step('Assets: one library with details, usage and missing-file relinking', async () => {
    await page.keyboard.press('Control+5');
    await page.locator('.asset-tile', { hasText: 'pattern.mp4' }).click();
    const detail = page.locator('.asset-detail');
    await detail.getByText('First cut').waitFor();
    await detail.getByText('h264').waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'm4-assets.png') });
  });

  const currentProject = async () => (await invoke('projects.recent', {})).value[0].id;
  const sequence = async (lineId, sequenceId = 'first-cut') => (await invoke('sequences.get', { projectId: await currentProject(), lineId, sequenceId })).value.sequence;

  await step('M5 AI media: turn on media endpoints, review what is sent, generate an image (mock), see its provenance', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Providers' }).click();
    await dialog.locator('li', { hasText: 'Local mock' }).getByRole('button', { name: 'Edit' }).click();
    await dialog.getByLabel('Images API (POST /images/generations)').check();
    await dialog.getByLabel('Audio transcriptions (POST /audio/transcriptions)').check();
    await dialog.getByRole('button', { name: 'Save and test' }).click();
    await dialog.getByText('Connected. 4 models available.').waitFor();
    await dialog.getByRole('button', { name: 'Models', exact: true }).click();
    await dialog.getByLabel('Model for Image generation').selectOption({ label: 'mock/image — Local mock (unverified)' });
    await dialog.getByLabel('Model for Transcription').selectOption({ label: 'mock/whisper — Local mock (unverified)' });
    await page.keyboard.press('Escape');
    await expectEventually(async () => assert.equal((await invoke('ai.state', {})).value.routing['image-generation']?.modelId, 'mock/image'));

    await page.keyboard.press('Control+5');
    await page.getByRole('radio', { name: 'Generate' }).click();
    await page.getByLabel('Prompt').fill('A kiln glowing at night');
    const before = (await (await fetch(`${base}/api/harness/mock-provider`)).json()).requests;
    await page.getByRole('button', { name: 'Review…' }).click();
    const review = page.locator('.job-review');
    // The harness's mock provider runs on 127.0.0.1, so it is reported as staying on this computer.
    await review.getByText('Stays on this computer').waitFor();
    await review.getByText('Your prompt').waitFor();
    await review.getByText('Unknown', { exact: true }).waitFor();
    await review.getByText('mock/image').waitFor();
    assert.equal((await (await fetch(`${base}/api/harness/mock-provider`)).json()).requests, before, 'reviewing sends nothing');
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.locator('.gen-jobs .job-item.is-completed').first().waitFor({ timeout: 20000 });
    await page.getByRole('radio', { name: 'Library' }).click();
    const tile = page.locator('.asset-tile', { has: page.locator('.asset-badge', { hasText: 'AI' }) }).first();
    await tile.click();
    const detail = page.locator('.asset-detail');
    await detail.getByRole('heading', { name: 'Generated' }).waitFor();
    await detail.getByText('mock/image').waitFor();
    await detail.getByText('A kiln glowing at night').first().waitFor();
    await detail.getByRole('button', { name: 'Copy into version' }).click();
    await page.getByText(/Copied into images\/a-kiln-glowing-at-night\.png/).waitFor();
    await detail.getByText('images/a-kiln-glowing-at-night.png').waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'm5-generated-asset.png') });
  });

  await step('M5 Transcribe a clip (only audio is sent) and add captions as one undoable AI edit', async () => {
    await page.locator('.line-item.is-shared .line-main').click();
    await page.keyboard.press('Control+4');
    await page.locator('.tl-row.is-video .tl-clip', { hasText: 'pattern.mp4' }).first().click();
    await page.locator('.clip-inspector').getByRole('button', { name: 'Transcribe…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Transcribe pattern.mp4' });
    await dialog.getByText(/the picture is not sent/).waitFor();
    await dialog.getByRole('button', { name: 'Transcribe', exact: true }).click();
    await page.locator('.clip-inspector').getByText(/Saved with this media/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Edit with AI…' }).click();
    const ai = page.getByRole('dialog', { name: 'Edit “First cut” with AI' });
    await ai.getByRole('button', { name: 'Add captions' }).click();
    await ai.getByRole('heading', { name: 'Add 2 captions from the transcript' }).waitFor();
    await ai.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.getByText(/Applied: Add 2 captions/).waitFor();
    await expectEventually(async () => {
      const seq = await sequence('shared');
      const captions = seq.tracks.find((t) => t.name === 'Captions');
      assert.deepEqual(captions?.clips.map((c) => c.text), ['Mock transcript.', 'Second mock line.']);
    });
    await page.locator('.tl-clip.is-text', { hasText: 'Mock transcript.' }).waitFor();
    // The whole AI edit undoes in one step.
    await page.locator('.tl-scroll').focus();
    await page.keyboard.press('Control+z');
    await expectEventually(async () => assert.ok(!(await sequence('shared')).tracks.some((t) => t.name === 'Captions')));
  });

  await step('M5 Edit with AI: a free-form request (mock model) is proposed, then applied as a new alternative', async () => {
    await script([{ calls: [{ name: 'add_text', args: { text: 'Kiln Studio', subtitle: 'Open late', start_seconds: 0, duration_seconds: 2, template: 'lower-third' } }, { name: 'finish', args: { summary: 'Added the studio name over the opening shot.' } }] }]);
    await page.getByRole('button', { name: 'Edit with AI…' }).click();
    const ai = page.getByRole('dialog', { name: 'Edit “First cut” with AI' });
    await ai.getByText(/No media files\. Cost: Unknown\./).waitFor();
    await ai.getByLabel('Edit instruction').fill('Put the studio name over the opening shot');
    await ai.getByRole('button', { name: 'Propose edit' }).click();
    await ai.getByRole('heading', { name: 'Added the studio name over the opening shot.' }).waitFor({ timeout: 15000 });
    await ai.getByText(/Sent: A text description/).waitFor();
    await ai.getByLabel('As a new alternative').check();
    await ai.getByLabel('Alternative name').fill('Named opening');
    await ai.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.getByText('Created “Named opening”').waitFor();
    await page.locator('.line-item', { hasText: 'Named opening' }).waitFor();
    const projectId = await currentProject();
    const alt = (await invoke('projects.view', { projectId })).value.alternatives.find((a) => a.name === 'Named opening');
    const seq = await sequence(alt.id);
    const title = seq.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text' && c.text === 'Kiln Studio');
    assert.equal(title?.template, 'lower-third');
    assert.equal(title?.subtitle, 'Open late');
    assert.ok(!(await sequence('shared')).tracks.flatMap((t) => t.clips).some((c) => c.text === 'Kiln Studio'), 'Shared is unchanged');
    await page.locator('.player-panel').first().waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'm5-lower-third.png') });
  });

  await step('M5 Website → Video: record a page of a version with a scripted scroll', async () => {
    await page.getByRole('button', { name: 'Record a page of a version' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record a page' });
    await dialog.getByLabel('Recording length in seconds').fill('3');
    await dialog.getByRole('radio', { name: 'Follow steps' }).click();
    await dialog.getByRole('button', { name: 'Review…' }).click();
    await dialog.getByText('Stays on this computer').waitFor();
    await dialog.getByRole('button', { name: 'Record 3 s' }).click();
    const projectId = await currentProject();
    await expectEventually(async () => {
      const job = (await invoke('media.jobs.list', { projectId })).value.find((j) => j.kind === 'recording');
      assert.equal(job?.state, 'completed', job?.error ?? job?.state);
    }, 60000);
    await page.keyboard.press('Control+5');
    await page.getByRole('radio', { name: 'Recordings' }).click();
    await page.locator('.asset-tile', { has: page.locator('.asset-badge', { hasText: 'Recorded' }) }).first().click();
    await page.locator('.asset-detail').getByRole('heading', { name: 'Recording', exact: true }).waitFor();
    const media = (await invoke('media.list', { projectId })).value.find((m) => m.provenance?.source === 'recording');
    assert.equal(media.kind, 'video');
    assert.ok(media.probe.durationSeconds > 2 && media.probe.durationSeconds < 4.5, `recording is about 3 s (${media.probe.durationSeconds})`);
    await page.getByRole('radio', { name: 'All', exact: true }).click();
  });

  await step('M5 Brand: a title follows a brand style; a brand update is previewed per version and applied', async () => {
    await page.getByRole('radio', { name: 'Brand' }).click();
    await page.getByRole('button', { name: 'Add colour' }).click();
    await page.getByLabel('Primary hex value').fill('#c2410c');
    await page.getByRole('button', { name: 'Add text style' }).click();
    await page.getByRole('button', { name: 'Save brand' }).click();
    await expectEventually(async () => assert.equal((await invoke('brand.get', { projectId: await currentProject() })).value.textStyles[0]?.name, 'Headline'));
    // Choose the style for the Shared title.
    await page.locator('.line-item.is-shared .line-main').click();
    await page.keyboard.press('Control+4');
    await page.locator('.tl-clip.is-text', { hasText: 'Opening title' }).click();
    await page.locator('.clip-inspector').getByLabel('Brand style').selectOption({ label: 'Headline' });
    await expectEventually(async () => {
      const t = (await sequence('shared')).tracks.flatMap((x) => x.clips).find((c) => c.text === 'Opening title');
      assert.equal(t.brandStyleId?.startsWith('ts-'), true);
      assert.equal(t.style.color, '#c2410c');
    });
    // Change the brand colour: nothing changes until the preview is applied.
    await page.keyboard.press('Control+5');
    await page.getByRole('radio', { name: 'Brand' }).click();
    await page.getByLabel('Primary hex value').fill('#0f766e');
    await page.getByRole('button', { name: 'Preview update…' }).click();
    const plan = page.locator('.brand-plan');
    await plan.getByText('Sequence “First cut”').first().waitFor();
    await plan.getByText('1 title using “Headline”').first().waitFor();
    assert.equal((await sequence('shared')).tracks.flatMap((x) => x.clips).find((c) => c.text === 'Opening title').style.color, '#c2410c', 'previewing changes nothing');
    await plan.getByRole('button', { name: /^Apply to \d+ place/ }).click();
    await page.getByText(/Brand applied to/).waitFor();
    await expectEventually(async () => assert.equal((await sequence('shared')).tracks.flatMap((x) => x.clips).find((c) => c.text === 'Opening title').style.color, '#0f766e'));
    if (shots) await page.screenshot({ path: path.join(shots, 'm5-brand.png') });
  });

  await step('M6 Timelines across versions: conflicting trims become a per-clip decision (no line merge of JSON)', async () => {
    const projectId = await currentProject();
    const alt = (await invoke('projects.view', { projectId })).value.alternatives.find((a) => a.name === 'Named opening');
    const pattern = (await sequence('shared')).tracks.find((t) => t.id === 'v1').clips[0];
    // Both versions trim the same clip differently.
    await invoke('commands.run', { projectId, lineId: alt.id, name: 'video.trimClip', args: { sequence: 'first-cut', clipId: pattern.id, edge: 'end', at: 3 * 240000 } });
    await invoke('commands.run', { projectId, lineId: 'shared', name: 'video.trimClip', args: { sequence: 'first-cut', clipId: pattern.id, edge: 'end', at: 3.5 * 240000 } });
    await page.locator('.line-item.is-shared .line-main').click();
    await page.getByRole('button', { name: /Save shared change/ }).first().click();
    await page.getByText(/Named opening needs a decision/).waitFor();
    await page.getByRole('button', { name: 'Review conflict' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Resolve conflicts in Named opening' });
    await dialog.locator('.tl-item', { hasText: 'pattern.mp4' }).waitFor();
    await dialog.getByText(/merged without a decision/).waitFor();
    await dialog.locator('.tl-item', { hasText: 'pattern.mp4' }).getByRole('radio', { name: /Use Shared/ }).click();
    await dialog.getByText('Everything is decided.').waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'm6-timeline-conflict.png') });
    await dialog.getByRole('button', { name: 'Finish and apply' }).click();
    await page.getByText('Named opening is up to date').waitFor();
    const seq = await sequence(alt.id);
    const clip = seq.tracks.find((t) => t.id === 'v1').clips.find((c) => c.id === pattern.id);
    assert.equal((clip.start + (clip.out - clip.in) / clip.speed) / 240000, 3.5, 'took Shared’s trim as a whole');
    assert.ok(seq.tracks.flatMap((t) => t.clips).some((c) => c.text === 'Kiln Studio'), 'kept the alternative’s own title');
    assert.equal(seq.tracks.flatMap((t) => t.clips).find((c) => c.text === 'Opening title').style.color, '#0f766e', 'brought in Shared’s brand change');
  });

  await step('M6 Compare two cuts with a timeline viewer; outdated exports are listed under Updates', async () => {
    const projectId = await currentProject();
    await page.keyboard.press('Control+6');
    await page.getByRole('radio', { name: 'Explore' }).click();
    await page.getByRole('radio', { name: 'Updates' }).click();
    const updates = page.locator('.updates');
    await updates.getByText(/edited after this export/).first().waitFor();
    await updates.getByRole('button', { name: 'Export again' }).first().click();
    await page.getByText(/Exporting First cut again/).waitFor();
    await page.getByRole('radio', { name: 'Compare & Combine' }).click();
    await page.getByRole('radio', { name: 'Compare', exact: true }).click();
    const toolbar = page.locator('.compare-toolbar');
    await toolbar.getByRole('button', { name: /^Left:/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Shared version', exact: true }).click();
    await toolbar.getByRole('button', { name: /^Right:/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Named opening', exact: true }).click();
    await toolbar.getByRole('radio', { name: 'Source' }).click();
    await page.locator('.changed-row', { hasText: 'sequences/first-cut.mvseq.json' }).click();
    const diff = page.locator('.seq-diff');
    await diff.waitFor();
    await diff.getByText('Kiln Studio').first().waitFor();
    await diff.locator('.seq-diff-clip.is-added').first().waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'm6-compare-timelines.png') });
    await page.keyboard.press('Control+4');
    await page.getByRole('radio', { name: /^Exports/ }).click();
    await expectEventually(async () => {
      const jobs = (await invoke('video.export.list', { projectId })).value;
      assert.equal(jobs[0].state, 'completed');
      assert.equal(jobs[0].outdated, null, 'the new export matches its sources');
      assert.equal(jobs[1].outdated?.reason, 'sequence-changed');
    }, 60000);
  });

  await step('M7 Publish: add a Netlify destination (mock host), review the plan, publish; success only after the host confirms', async () => {
    const mock = await (await fetch(`${base}/api/harness/mock-provider`)).json();
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Publishing', exact: true }).click();
    await settings.getByRole('button', { name: /^Netlify/ }).click();
    await settings.getByLabel('Display name').fill('Mock Netlify');
    await settings.getByLabel('Access token').fill('mock-netlify-token');
    await settings.getByText('Advanced', { exact: true }).click();
    await settings.getByLabel('API address').fill(mock.url.replace(/\/v1$/, '/netlify'));
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await settings.locator('li', { hasText: 'Mock Netlify' }).getByText('Token for this session only').waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+2');
    await page.getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: /^Publish / }).click();
    const dialog = page.getByRole('dialog', { name: /^Publish / });
    await dialog.getByText('A new Netlify site', { exact: true }).waitFor();
    await dialog.getByText(/left out on purpose/).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'm7-publish-plan.png') });
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
    const row = dialog.locator('.deploy-row').first();
    await row.getByText('Published').waitFor({ timeout: 20000 });
    await row.getByRole('button', { name: 'https://mock-kiln.netlify.app' }).click();
    if (shots) await page.screenshot({ path: path.join(shots, 'm7-published.png') });
    const after = await (await fetch(`${base}/api/harness/mock-provider`)).json();
    assert.equal(after.netlifyDeploys.length, 1);
    assert.equal(after.netlifyDeploys[0].contentType, 'application/zip');
    assert.ok(after.openedUrls.includes('https://mock-kiln.netlify.app'), 'the host-returned URL opens in the system browser');
    await page.keyboard.press('Escape');
    // The token never lands in project files or app settings on disk.
    const grep = (dir) => execFileSync('grep', ['-rl', 'mock-netlify-token', dir], { encoding: 'utf8' }).trim();
    assert.throws(() => grep(workspace), 'no file in the workspace contains the token');
  });

  await step('M7 Settings: task defaults persist; storage shows caches apart from history and clears media previews', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Tasks and permissions', exact: true }).click();
    await settings.getByText('not a sandbox').waitFor();
    await settings.getByRole('radio', { name: 'Plan' }).click();
    await expectEventually(async () => assert.equal((await invoke('settings.get', {})).value.taskMode, 'plan'));
    await settings.getByRole('radio', { name: 'Ask' }).click();
    await settings.getByRole('button', { name: 'Media tools', exact: true }).click();
    await settings.getByText(/FFmpeg .* is ready/).waitFor();
    const projectId = await currentProject();
    const before = (await invoke('storage.usage', {})).value;
    const history = before.projects.find((p) => p.id === projectId).historyBytes;
    assert.ok(before.categories.find((c) => c.id === 'media').bytes > 0, 'thumbnails and waveforms are cached');
    await settings.getByRole('button', { name: 'Storage', exact: true }).click();
    const media = settings.locator('li', { hasText: 'Media previews' });
    await media.getByRole('button', { name: 'Clear', exact: true }).click();
    await media.getByRole('button', { name: /^Clear .*B/ }).click();
    await page.getByText('Cleared media previews').waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'm7-storage.png') });
    const afterClean = (await invoke('storage.usage', {})).value;
    assert.equal(afterClean.projects.find((p) => p.id === projectId).historyBytes, history, 'history is untouched');
    await page.keyboard.press('Escape');
    // Previews are made again from the originals when the library is listed.
    await page.keyboard.press('Control+5');
    await expectEventually(async () => assert.ok((await invoke('storage.usage', {})).value.categories.find((c) => c.id === 'media').bytes > 0), 30000);
  });

  await step('M7 Recovery: work interrupted by a restart is listed for review; nothing restarts on its own', async () => {
    const recent = (await invoke('projects.recent', {})).value[0];
    const jobsFile = path.join(recent.storagePath, 'publish', 'jobs.json');
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
    const jobs = JSON.parse(await readFile(jobsFile, 'utf8'));
    jobs.unshift({ ...jobs[0], id: 'interrupted-deploy', state: 'uploading', detail: 'Uploading…', remoteId: null, url: null, deployUrl: null, finishedAt: null, step: 'none' });
    await writeFile(jobsFile, JSON.stringify(jobs));
    server = await startServer();
    await page.reload();
    await page.locator('.recent-open').first().click();
    const notice = page.locator('.toast', { hasText: 'One job was interrupted' });
    await notice.waitFor();
    await notice.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Interrupted work' });
    const item = dialog.locator('.deploy-row', { hasText: /Publish .* to Mock Netlify/ });
    await item.getByText('Publish · Interrupted').waitFor();
    await item.getByText(/Publishing again is safe/).waitFor();
    await page.waitForTimeout(450); // let the dialog finish opening for the screenshot
    if (shots) await page.screenshot({ path: path.join(shots, 'm7-recovery.png') });
    // The mock host restarted with the harness: it has received nothing since.
    assert.equal((await (await fetch(`${base}/api/harness/mock-provider`)).json()).netlifyDeploys.length, 0, 'nothing was re-sent');
    await item.getByRole('button', { name: /^Dismiss/ }).click();
    await dialog.getByText('Nothing left to review').waitFor();
    await page.keyboard.press('Escape');
  });

  await step('Director: a selected clip becomes a reference chip; the AI adds a title with the same command as the user (mock model)', async () => {
    const projectId = await currentProject();
    await script([
      { calls: [{ name: 'get_studio_state', args: { include_assets: false } }] },
      { calls: [{ name: 'list_studio_commands', args: { domain: 'video' } }] },
      { calls: [{ name: 'run_studio_command', args: { name: 'video.addText', args: { sequence: 'first-cut', start: 30 * 240000, duration: 2 * 240000, text: 'Made with Kiln', template: 'lower-third' } } }] },
      { text: 'Added a lower third after the last shot.' },
    ]);
    await page.keyboard.press('Control+4');
    await page.locator('.tl-clip.is-text').first().click();
    await page.getByRole('radio', { name: 'Assistant' }).click();
    await page.getByRole('button', { name: 'New conversation' }).click();
    const chips = page.getByRole('group', { name: 'Referenced objects' });
    await chips.locator('.ai-chip.is-ref').first().waitFor();
    await page.getByRole('radio', { name: 'Build' }).click();
    await page.locator('#ai-prompt').fill('Add a lower third like this one at the end');
    if (shots) await page.screenshot({ path: path.join(shots, 'director-reference.png') });
    await page.getByRole('button', { name: 'Start task' }).click();
    try {
      await page.locator('.ai-state', { hasText: 'Completed' }).first().waitFor({ timeout: 60000 });
    } catch (error) {
      const list = (await invoke('ai.tasks.list', { projectId })).value ?? [];
      const t = list[0] ? (await invoke('ai.tasks.get', { projectId, taskId: list[0].id })).value : null;
      const mock = await (await fetch(`${base}/api/harness/mock-provider`)).json();
      console.log(JSON.stringify({ state: t?.state, error: t?.error, messages: (t?.messages ?? []).slice(-6).map((m) => ({ role: m.role, text: String(m.text ?? '').slice(0, 300), tool: m.toolResult?.name, out: String(m.toolResult?.output ?? '').slice(0, 300) })), mock: { requests: mock.requests } }, null, 1));
      throw error;
    }
    const tasks = (await invoke('ai.tasks.list', { projectId })).value;
    const task = (await invoke('ai.tasks.get', { projectId, taskId: tasks[0].id })).value;
    assert.equal(task.context.references[0].kind, 'clip', 'the selected clip was sent as a reference by id');
    assert.ok(task.messages.some((m) => m.toolResult?.name === 'get_studio_state' && /first-cut/.test(m.toolResult.output)));
    assert.ok(task.messages.some((m) => m.toolResult?.name === 'run_studio_command' && m.toolResult.ok));
    const seq = (await invoke('sequences.get', { projectId, lineId: task.workingLineId, sequenceId: 'first-cut' })).value.sequence;
    assert.ok(seq.tracks.some((t) => t.clips.some((c) => c.type === 'text' && c.text === 'Made with Kiln' && c.template === 'lower-third')), 'an ordinary, editable title in the task universe');
    const origin = (await invoke('sequences.get', { projectId, lineId: task.originLineId, sequenceId: 'first-cut' })).value.sequence;
    assert.ok(!origin.tracks.some((t) => t.clips.some((c) => c.type === 'text' && c.text === 'Made with Kiln')), 'the user’s universe is untouched');
    if (shots) await page.screenshot({ path: path.join(shots, 'director-done.png') });
    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.getByRole('switch', { name: 'Autopilot for this project' }).click();
    await page.getByRole('radio', { name: 'Autopilot' }).waitFor();
    assert.equal((await invoke('ai.project.get', { projectId })).value.autopilot, true);
    await page.getByRole('switch', { name: 'Autopilot for this project' }).click();
  });

  await step('D2 Activity: every action is a command with its actor; the task started from a checkpoint', async () => {
    const projectId = await currentProject();
    const log = (await invoke('ops.activity', { projectId })).value;
    assert.ok(log.some((r) => r.type === 'video.addText' && r.actor === 'ai-task'), 'the director’s title edit is logged as an AI task');
    assert.ok(log.some((r) => r.type === 'project.createCheckpoint' && r.actor === 'ai-task' && /Before task/.test(r.summary)), 'a checkpoint before the task');
    assert.ok(log.some((r) => r.type === 'project.createUniverse' && r.actor === 'user'), 'universes made with buttons are commands too');
    await page.keyboard.press('Control+7');
    await page.getByRole('radio', { name: 'Inspector' }).click();
    const activity = page.locator('.activity-list');
    await activity.waitFor();
    await activity.locator('.activity-actor.is-ai').first().waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'd2-activity.png') });
    await page.getByRole('radio', { name: 'Assistant' }).click();
  });

  await step('D3 Living objects: create a pricing card, place it on a page and in the video, edit it once, both update', async () => {
    const projectId = await currentProject();
    const lineId = (await invoke('projects.open', { projectId })).value.alternatives[0].id;
    await page.keyboard.press('Control+5');
    await page.getByRole('radio', { name: 'Objects' }).click();
    await page.getByRole('group', { name: 'New living object' }).getByRole('button', { name: 'Pricing card' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Pro plan');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText('Pricing card created').waitFor();
    await page.getByRole('button', { name: 'Place on page' }).click();
    await page.getByText(/^Placed on /).waitFor();
    await page.getByRole('button', { name: 'Add to video' }).click();
    await page.getByText(/^Added to /).waitFor();
    const uses = page.locator('.objects-uses');
    await expectEventually(async () => assert.equal(await uses.locator('.obj-state.is-current').count(), 2));
    await page.getByLabel('Price').fill('$9');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.getByText(/^Updated in /).waitFor();
    const objects = (await invoke('objects.list', { projectId, lineId })).value;
    const pro = objects.find((o) => o.name === 'Pro plan');
    assert.equal(pro.properties.price, '$9');
    assert.equal(pro.placements.length, 2);
    assert.ok(pro.placements.every((p) => p.state === 'current'));
    const pagePath = pro.placements.find((p) => p.kind === 'page').path;
    const html = (await invoke('files.read', { projectId, ref: { kind: 'line', lineId }, path: pagePath })).value.text;
    assert.match(html, /<span class="mv-obj-amount">\$9<\/span>/);
    const scene = pro.placements.find((p) => p.kind === 'scene');
    const seq = (await invoke('sequences.get', { projectId, lineId, sequenceId: scene.path.replace(/^sequences\/|\.mvseq\.json$/g, '') })).value.sequence;
    assert.ok(seq.tracks.some((t) => t.clips.some((c) => c.id === scene.clipId && c.text === 'Pro — $9')), 'the video scene shows the new price');
    if (shots) await page.screenshot({ path: path.join(shots, 'd3-objects.png') });
    const r = await audit(page);
    assert.deepEqual([r.unnamed, r.unlabeled, r.duplicateIds, r.lowContrast], [[], [], [], []]);
  });

  await step('D4 Stories: record steps in the preview, add a chapter and a check, run it as a test, record it into a timeline', async () => {
    const projectId = await currentProject();
    await page.keyboard.press('Control+8');
    await page.getByRole('heading', { name: 'Stories', exact: true }).waitFor();
    const lineName = (await page.locator('.stories-head .muted').innerText()).replace(/^in /, '');
    const lineId = (await invoke('projects.open', { projectId })).value.alternatives.find((l) => l.name === lineName).id;
    await invoke('files.create', { projectId, lineId, path: 'faq.html', text: '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Questions</title></head>\n<body>\n<main>\n<h1>Questions</h1>\n<details>\n<summary>Can clients use it without an account?</summary>\n<p>Yes. Clients open a private link to review work and leave comments.</p>\n</details>\n</main>\n</body>\n</html>\n' });
    await page.getByLabel('New story name').fill('Read a question');
    await page.getByRole('region', { name: 'Stories' }).getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: /Read a question/ }).waitFor();
    await expectEventually(async () => {
      await page.getByLabel('Starts at').selectOption('faq.html');
    });
    await page.getByRole('button', { name: 'Save steps' }).click();
    await expectEventually(async () => assert.ok(await page.getByRole('button', { name: 'Save steps' }).isDisabled()));
    const addStep = async (kind, text) => {
      await page.getByLabel('Kind of step').selectOption({ label: kind });
      await page.getByRole('group', { name: 'Add a step' }).getByRole('textbox').fill(text);
      await page.getByRole('group', { name: 'Add a step' }).getByRole('button', { name: 'Add' }).click();
    };
    await addStep('Chapter', 'Client questions');
    await page.getByRole('button', { name: 'Record steps' }).click();
    const frame = page.frameLocator('iframe[title$="preview for stories"]');
    await frame.getByText('Can clients use it without an account?').click();
    await page.getByText(/1 step so far/).waitFor();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await addStep('Check text', 'Clients open a private link to review work');
    await page.getByRole('button', { name: 'Save steps' }).click();
    await page.getByRole('button', { name: 'Run test' }).click();
    await page.getByText('Story passed').waitFor({ timeout: 60000 });
    await page.locator('.story-status-line.is-passing').waitFor();
    const story = (await invoke('stories.list', { projectId, lineId })).value.find((s) => s.name === 'Read a question');
    assert.ok(story, 'the story is saved in the active version');
    assert.equal(story.page, 'faq.html');
    assert.deepEqual(story.steps.map((s) => s.kind), ['chapter', 'click', 'verify']);
    assert.equal(story.lastRun.ok, true);
    assert.ok(story.lastRun.steps.filter((r) => r.ok === true).length === 2, 'the click and the check passed; the chapter is not part of the test');
    await page.getByRole('button', { name: 'Record video' }).click();
    await page.getByText('Story recorded').waitFor({ timeout: 120000 });
    const seq = (await invoke('sequences.get', { projectId, lineId, sequenceId: `story-${story.id}` })).value.sequence;
    const titles = seq.tracks.find((t) => t.name === 'Story titles');
    assert.ok(seq.tracks.some((t) => t.kind === 'video' && t.clips.length === 1), 'the recording is a clip in a new sequence');
    assert.ok(titles?.clips.some((c) => c.text === 'Client questions'), 'the chapter is an editable title');
    const runs = (await invoke('stories.runs', { projectId })).value.filter((r) => r.storyId === story.id);
    assert.ok(runs.some((r) => r.mode === 'recording' && r.ok && r.assetId && r.revision), 'the recording records the revision it came from');
    if (shots) await page.screenshot({ path: path.join(shots, 'd4-stories.png') });
    const r = await audit(page);
    assert.deepEqual([r.unnamed, r.unlabeled, r.duplicateIds, r.lowContrast], [[], [], [], []]);
  });

  await step('D5 Outcomes: compare two universes by measured results; each release destination stands on its own', async () => {
    const projectId = await currentProject();
    await page.keyboard.press('Control+6');
    await page.getByRole('radio', { name: 'Compare & Combine' }).click();
    await page.getByRole('radio', { name: 'Compare', exact: true }).click();
    const toolbar = page.locator('.compare-toolbar');
    await toolbar.getByRole('button', { name: /^Left:/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Shared version', exact: true }).click();
    await toolbar.getByRole('button', { name: /^Right:/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Named opening', exact: true }).click();
    await toolbar.getByRole('radio', { name: 'Outcomes' }).click();
    const outcomes = page.getByRole('region', { name: 'Outcomes by version' });
    const storyRow = outcomes.getByRole('table', { name: 'Stories' }).locator('.outcome-row', { hasText: 'Read a question' });
    await storyRow.waitFor();
    assert.match(await storyRow.innerText(), /Not in this version[\s\S]*Passing/);
    await outcomes.getByRole('table', { name: 'Pages' }).locator('.outcome-row', { hasText: 'faq.html' }).getByText('Not in this version').waitFor();
    await storyRow.getByRole('button', { name: 'Run' }).click();
    await page.getByText('Ran “Read a question” in Named opening').waitFor({ timeout: 60000 });
    const releases = outcomes.getByRole('region', { name: 'Release destinations' });
    await releases.getByText(/never released together as one step/).waitFor();
    const dests = (await invoke('releases.list', { projectId })).value;
    assert.ok(dests.some((d) => d.kind === 'website') && dests.some((d) => d.kind === 'video'), 'the site and the video are separate destinations');
    assert.equal(await releases.locator('.release-row').count(), dests.length);
    if (shots) await page.screenshot({ path: path.join(shots, 'd5-outcomes.png') });
    const r = await audit(page);
    assert.deepEqual([r.unnamed, r.unlabeled, r.duplicateIds, r.lowContrast], [[], [], [], []]);
  });

  await step('D6 Orbit: create the demo app, record a story in its working task list, run it, and find it all after a restart', async () => {
    await page.keyboard.press('Control+1');
    await page.getByRole('heading', { name: 'Start something new' }).waitFor();
    await page.getByRole('button', { name: /Orbit demo app/ }).click();
    const dialog = page.getByRole('dialog', { name: /New orbit/i });
    await dialog.getByLabel('Project name').fill('Orbit');
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.design-body').waitFor();
    const orbitId = (await invoke('projects.recent', {})).value.find((r) => r.name === 'Orbit').id;
    await page.keyboard.press('Control+8');
    await page.getByLabel('New story name').fill('First task');
    await page.getByRole('region', { name: 'Stories' }).getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: /First task/ }).waitFor();
    await page.getByLabel('Starts at').selectOption('app.html');
    await page.getByRole('button', { name: 'Save steps' }).click();
    await expectEventually(async () => assert.ok(await page.getByRole('button', { name: 'Save steps' }).isDisabled()));
    const frame = page.frameLocator('iframe[title$="preview for stories"]');
    // Saving reloads the preview; let it settle so record mode reaches the page that is typed into.
    await page.waitForTimeout(1000);
    await frame.getByRole('heading', { name: 'Tasks' }).waitFor();
    await page.getByRole('button', { name: 'Record steps' }).click();
    await page.waitForTimeout(500);
    await frame.getByLabel('Task title').fill('Write the brief');
    await frame.getByLabel('Task title').press('Enter');
    await frame.getByRole('checkbox', { name: 'Write the brief' }).click();
    await page.getByText(/3 steps so far/).waitFor();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await page.getByRole('group', { name: 'Add a step' }).getByRole('textbox').fill('0 open');
    await page.getByRole('group', { name: 'Add a step' }).getByRole('button', { name: 'Add' }).click();
    await page.getByRole('button', { name: 'Run test' }).click();
    await page.getByText('Story passed').waitFor({ timeout: 60000 });
    const [story] = (await invoke('stories.list', { projectId: orbitId, lineId: 'shared' })).value;
    assert.deepEqual(story.steps.map((s) => s.kind), ['fill', 'press', 'click', 'verify']);
    assert.ok(Object.keys(story.lastRun.deps).includes('js/tasks.js'), 'the run is tied to the task code');
    if (shots) await page.screenshot({ path: path.join(shots, 'd6-orbit-story.png') });
    // Restart: the project, its story and the run reopen.
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
    server = await startServer();
    await page.reload();
    await page.locator('.recent-open', { hasText: 'Orbit' }).first().click();
    await page.locator('.design-body').waitFor();
    await page.keyboard.press('Control+8');
    await page.getByRole('button', { name: /First task/ }).waitFor();
    await page.locator('.story-status-line.is-passing').waitFor();
    await page.keyboard.press('Control+7');
    await page.locator('.timeline-entry').first().waitFor();
  });

  await step('Token saver: reply style and compaction settings are saved; defaults are on', async () => {
    assert.deepEqual((await invoke('ai.state', {})).value.tokenSaver, { replies: 'brief', compactOutputs: true, compactHistory: true, promptCaching: true });
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Usage and budgets', exact: true }).click();
    const saver = settings.getByRole('region', { name: 'Token saver' });
    await saver.getByRole('radio', { name: 'Minimal' }).click();
    await saver.getByText(/Results only, at most five lines/).waitFor();
    await saver.getByRole('switch', { name: 'Shorten older results in long tasks' }).click();
    await expectEventually(async () => assert.deepEqual((await invoke('ai.state', {})).value.tokenSaver, { replies: 'minimal', compactOutputs: true, compactHistory: false, promptCaching: true }));
    await page.waitForTimeout(300);
    assert.equal(await saver.getByRole('switch', { name: 'Shorten older results in long tasks' }).getAttribute('aria-checked'), 'false', 'the switch shows the saved setting');
    assert.equal(await saver.getByRole('radio', { name: 'Minimal' }).getAttribute('aria-checked'), 'true');
    if (shots) await page.screenshot({ path: path.join(shots, 'token-saver.png') });
    await saver.getByRole('radio', { name: 'Brief' }).click();
    await saver.getByRole('switch', { name: 'Shorten older results in long tasks' }).click();
    await expectEventually(async () => assert.equal((await invoke('ai.state', {})).value.tokenSaver.compactHistory, true));
    await page.keyboard.press('Escape');
  });

  // ChatGPT/Claude connector and the live AI activity layer. The app side is a scripted MCP client on the
  // local endpoint (the same requests the Claude Desktop bridge sends); nothing here calls a real AI service.
  let mcpDisc = null;
  let mcpId = 1;
  const mcp = async (name, args, app = 'Claude') => {
    const META = 'io.modelcontextprotocol';
    const body = { jsonrpc: '2.0', id: mcpId++, method: 'tools/call', params: { name, arguments: args, _meta: { [`${META}/protocolVersion`]: '2026-07-28', [`${META}/clientInfo`]: { name: app, version: '1' }, [`${META}/clientCapabilities`]: {} } } };
    const r = await fetch(mcpDisc.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${mcpDisc.token}`, 'x-mv-client': app, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name }, body: JSON.stringify(body) });
    return (await r.json()).result;
  };
  const pill = () => page.locator('.activity-pill');
  let appProject = null;

  await step('AI apps: turn on access in Settings, approve Claude once, and it creates and opens a project', async () => {
    if (await page.getByRole('button', { name: 'Settings' }).count()) {
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('button', { name: 'AI apps', exact: true }).click();
      await settings.getByRole('switch', { name: 'Let AI apps use Multiverse Studio' }).click();
      await settings.getByText(/Claude Desktop/).first().waitFor();
      if (shots) await page.screenshot({ path: path.join(shots, 'connector-settings.png') });
      await page.keyboard.press('Escape');
    } else await invoke('connector.setEnabled', { enabled: true }); // E2E_ONLY runs start on the welcome screen
    await expectEventually(async () => assert.equal((await invoke('connector.state', {})).value.enabled, true));
    mcpDisc = JSON.parse(await readFile(path.join(workspace, '..', 'harness-home', '.multiverse-studio', 'connector.json'), 'utf8'));
    const created = mcp('create_project', { name: 'Orbit from Claude', template: 'orbit' });
    const card = page.getByRole('alertdialog');
    await card.getByText(/Claude/).first().waitFor();
    await card.getByRole('button', { name: 'Allow' }).click();
    const r = await created;
    assert.equal(r.isError, false, r.content[0].text);
    appProject = r.structuredContent.projectId;
    await expectEventually(async () => assert.match(await page.locator('.sidebar').innerText(), /Orbit from Claude/));
  });

  await step('Activity: an app’s change in another universe says where; View activity shows the changed lines; Back to your view', async () => {
    const u = await mcp('run_studio_command', { project: appProject, name: 'project.createUniverse', args: { from: { kind: 'line', lineId: 'shared' }, name: 'Playful', color: 'rose', description: '', following: true } });
    assert.equal(u.isError, false, u.content[0].text);
    await page.keyboard.press('Control+3');
    await page.locator('.design-body').waitFor();
    const w = await mcp('run_studio_command', { project: appProject, universe: 'Playful', name: 'code.writeFile', args: { path: 'notes.md', text: '# Playful\nBright colours\n' } });
    assert.equal(w.isError, false, w.content[0].text);
    await expectEventually(async () => assert.match(await pill().innerText(), /Claude[\s\S]*Creating notes\.md · Playful/));
    assert.equal(await page.locator('.ai-highlight.is-on').count(), 0, 'nothing is drawn on the universe being viewed');
    await pill().getByRole('button', { name: 'View activity' }).click();
    await expectEventually(async () => assert.equal(await page.locator('.ai-highlight.is-on').count(), 1));
    assert.match(await page.locator('.workspace').getAttribute('class'), /workspace-build/);
    assert.match(await page.locator('.toolbar').innerText(), /Playful/);
    if (shots) await page.screenshot({ path: path.join(shots, 'activity-view.png') });
    await page.getByRole('button', { name: 'Back to your view' }).click();
    await expectEventually(async () => assert.match(await page.locator('.workspace').getAttribute('class'), /workspace-design/));
    await pill().getByRole('button', { name: 'Show activity details' }).click();
    const details = page.getByRole('dialog', { name: 'Claude activity' });
    await details.getByText('Changed').waitFor();
    assert.match(await details.innerText(), /notes\.md\s*· Playful/);
    await page.keyboard.press('Escape');
    const lines = await page.evaluate(() => document.documentElement.classList.contains('has-activity'));
    assert.equal(lines, true, 'a row under the toolbar is reserved while there is activity');
  });

  await step('Activity: an app’s story run puts the AI pointer on each real element and marks checks separately', async () => {
    const sc = await mcp('run_studio_command', {
      project: appProject,
      name: 'stories.create',
      args: { story: 'add-task', name: 'Add a task', page: 'app.html', fixtures: {}, viewport: { width: 900, height: 640 }, timing: { stepDelayMs: 0, typingMsPerChar: 10, endHoldMs: 0 }, steps: [
        { id: 's1', kind: 'fill', target: { by: 'label', name: 'Task title' }, text: 'Write launch notes' },
        { id: 's2', kind: 'press', target: { by: 'label', name: 'Task title' }, key: 'Enter' },
        { id: 's3', kind: 'verify', target: { by: 'testid', value: 'count' }, expect: { text: '1 open' } },
      ] },
    });
    assert.equal(sc.isError, false, sc.content[0].text);
    await page.keyboard.press('Control+8');
    await page.locator('.story-steps').waitFor();
    await page.frameLocator('iframe[title*="preview for stories"]').locator('#task-title').waitFor();
    await page.waitForTimeout(800);
    const run = mcp('run_studio_command', { project: appProject, name: 'story.run', args: { lineId: 'shared', storyId: 'add-task' } });
    await page.locator('.ai-pointer.is-on').waitFor({ timeout: 15000 });
    if (shots) await page.screenshot({ path: path.join(shots, 'activity-story-pointer.png') });
    const r = await run;
    assert.equal(r.isError, false, r.content[0].text);
    assert.match(r.content[0].text, /passed/);
    await expectEventually(async () => assert.equal(await page.locator('.ai-highlight.is-assertion.is-on').count(), 1, 'the last step is a check'));
    assert.equal(await page.locator('.story-step.is-live').count(), 1);
    assert.equal(await page.locator('.story-step.is-live').getAttribute('aria-current'), 'step');
  });

  await step('Activity: Pause holds the app’s changes; typing in the file it is changing pauses it until you stop', async () => {
    await pill().getByRole('button', { name: 'Pause' }).click();
    await expectEventually(async () => assert.match(await pill().innerText(), /Changes from Claude are paused/));
    const held = await mcp('run_studio_command', { project: appProject, name: 'code.writeFile', args: { path: 'held.md', text: 'x' } });
    assert.equal(held.isError, true);
    assert.match(held.content[0].text, /paused changes from Claude/);
    await pill().getByRole('button', { name: 'Resume' }).click();
    await expectEventually(async () => assert.deepEqual((await invoke('connector.state', {})).value.held, []));
    const w = await mcp('run_studio_command', { project: appProject, name: 'code.writeFile', args: { path: 'held.md', text: 'one\n' } });
    assert.equal(w.isError, false, w.content[0].text);
    await page.keyboard.press('Control+2');
    await page.locator('.tree-row', { hasText: 'held.md' }).click();
    await page.getByTestId('code-editor').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' two');
    await expectEventually(async () => assert.match(await pill().innerText(), /Paused while you edit/));
    const during = await mcp('run_studio_command', { project: appProject, name: 'code.writeFile', args: { path: 'held.md', text: 'overwritten' } });
    assert.equal(during.isError, true, 'the app cannot overwrite what you are typing');
    if (shots) await page.screenshot({ path: path.join(shots, 'activity-paused-edit.png') });
    await expectEventually(async () => assert.match(await pill().innerText(), /Waiting for Claude/), 8000);
    await expectEventually(async () => assert.match((await invoke('files.read', { projectId: appProject, ref: { kind: 'line', lineId: 'shared' }, path: 'held.md' })).value.text, /two/));
  });

  await step('Activity: Follow AI opens the work; visuals Off keeps the pill without drawing on the workspace', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
    await settings.getByRole('switch', { name: 'Follow AI' }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+5');
    await page.waitForTimeout(2800); // Follow waits until the person has not touched anything for a moment.
    const w = await mcp('run_studio_command', { project: appProject, name: 'code.writeFile', args: { path: 'follow.md', text: 'a\nb\n' } });
    assert.equal(w.isError, false, w.content[0].text);
    await expectEventually(async () => assert.match(await page.locator('.workspace').getAttribute('class'), /workspace-build/));
    await page.getByRole('button', { name: 'Back to your view' }).click();
    await expectEventually(async () => assert.match(await page.locator('.workspace').getAttribute('class'), /workspace-assets/));
    await page.getByRole('button', { name: 'Settings' }).click();
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
    await settings.getByRole('switch', { name: 'Follow AI' }).click();
    await settings.getByRole('radio', { name: 'Off', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+2');
    await page.waitForTimeout(400);
    await mcp('run_studio_command', { project: appProject, name: 'code.writeFile', args: { path: 'follow.md', text: 'a\nb\nc\n' } });
    await expectEventually(async () => assert.match(await pill().innerText(), /Writing follow\.md/));
    assert.equal(await page.locator('.ai-overlay').count(), 0);
    await page.getByRole('button', { name: 'Settings' }).click();
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
    await settings.getByRole('radio', { name: 'Minimal', exact: true }).click();
    await page.keyboard.press('Escape');
    const saved = (await invoke('settings.get', {})).value;
    assert.deepEqual([saved.activityVisuals, saved.followAi], ['minimal', false]);
  });

  await step('M7 Accessibility: names, labels, ids and text contrast in three themes', async () => {
    const problems = [];
    const check = async (label) => {
      const r = await audit(page);
      for (const [kind, list] of Object.entries(r)) if (Array.isArray(list) && list.length) problems.push(`${label} ${kind}: ${list.slice(0, 3).join('; ')}`);
    };
    for (const theme of ['Dystopia', 'Pearl', 'Graphite']) {
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
      await settings.getByRole('radio', { name: theme }).click();
      for (const tab of ['Providers', 'Tasks and permissions', 'Usage and budgets', 'Publishing', 'AI apps', 'Storage']) {
        await settings.getByRole('button', { name: tab, exact: true }).click();
        await page.waitForTimeout(250);
        await check(`${theme} settings/${tab}`);
      }
      await page.keyboard.press('Escape');
      for (const key of ['1', '2', '3', '4', '5', '6', '7', '8']) {
        await page.keyboard.press(`Control+${key}`);
        await page.waitForTimeout(500);
        await check(`${theme} workspace ${key}`);
      }
    }
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('radio', { name: 'Dystopia' }).click();
    await page.keyboard.press('Escape');
    assert.deepEqual(problems, []);
  });

  assert.deepEqual(
    pageErrors.filter((m) => !/Unexpected token/.test(m)),
    [],
    'no uncaught errors in the app',
  );
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
