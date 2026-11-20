/**
 * Interactive walkthroughs: a story exported as a page that shows the app in a frame and performs
 * each step when the viewer presses Next, with chapters, captions and narration as text. The page
 * must be served from the same site as the app (for example once published); inside the app's
 * sandboxed preview it cannot control the frame and says so.
 */
import { z } from 'zod';
import { CommandError, type CommandDefinition } from '../commands/commands';
import { describeStep, storyPath } from '../shared/stories';
import { parseStory, storyId, withFixtures } from './model';
import { STORY_STEP_SCRIPT } from './script';

export const WALKTHROUGH_DIR = 'walkthroughs';
const PLAYER = `${WALKTHROUGH_DIR}/walkthrough.js`;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const PLAYER_SCRIPT = `/* Multiverse Studio walkthrough player. Performs story steps in the frame when you press Next. */
(function () {
  var data = JSON.parse(document.getElementById('wt-story').textContent);
  var SRC = ${JSON.stringify(STORY_STEP_SCRIPT)};
  var frame = document.getElementById('wt-frame');
  var title = document.getElementById('wt-title');
  var text = document.getElementById('wt-text');
  var count = document.getElementById('wt-count');
  var note = document.getElementById('wt-note');
  var next = document.getElementById('wt-next');
  var restart = document.getElementById('wt-restart');
  var i = 0, busy = false, chapter = data.name;
  function show() {
    var s = data.steps[i];
    count.textContent = i < data.steps.length ? 'Step ' + (i + 1) + ' of ' + data.steps.length : 'Done';
    if (!s) { title.textContent = chapter; text.textContent = 'That is the whole flow.'; next.disabled = true; return; }
    if (s.kind === 'chapter') chapter = s.title;
    title.textContent = s.kind === 'chapter' ? s.title : chapter;
    text.textContent = s.kind === 'narrate' || s.kind === 'annotate' ? s.text : s.kind === 'chapter' ? (s.subtitle || '') : s.label;
    next.disabled = false;
    next.textContent = s.kind === 'verify' ? 'Check it' : /^(click|fill|press|open|wait)$/.test(s.kind) ? 'Do it' : 'Next';
  }
  async function step() {
    if (busy) return; busy = true; note.textContent = ''; next.disabled = true;
    var s = data.steps[i];
    try {
      if (s.kind === 'open') {
        await new Promise(function (r) { frame.addEventListener('load', r, { once: true }); frame.src = new URL(s.path.replace(/^\\/+/, ''), new URL(data.root, location.href)).toString(); });
      } else if (/^(click|fill|press|wait|verify)$/.test(s.kind)) {
        var run;
        try { run = frame.contentWindow.eval(SRC); } catch (e) { note.textContent = 'This walkthrough can only control the app when both are served from the same site (for example once published). It cannot inside the app’s preview.'; return; }
        var r = await run(s, { mode: 'record', typingMsPerChar: data.typingMsPerChar });
        if (!r || !r.ok) { note.textContent = 'This step did not work: ' + (r ? r.detail : 'no answer'); return; }
        if (s.kind === 'verify') note.textContent = '✓ ' + r.detail;
      }
      i += 1;
    } catch (e) { note.textContent = 'This step did not work: ' + (e && e.message ? e.message : e); return; }
    finally { busy = false; if (i <= data.steps.length) show(); }
  }
  next.addEventListener('click', step);
  restart.addEventListener('click', function () { i = 0; chapter = data.name; note.textContent = ''; frame.src = frame.getAttribute('data-start'); show(); });
  show();
})();
`;

export const walkthroughCommand: CommandDefinition<{ story: string }> = {
  name: 'stories.exportWalkthrough',
  schema: z.object({ story: storyId }),
  scope: (a) => `story:${a.story}`,
  label: () => 'Export an interactive walkthrough',
  files: (a) => [storyPath(a.story), `${WALKTHROUGH_DIR}/${a.story}.html`, PLAYER],
  apply: (files, a) => {
    const text = files.get(storyPath(a.story));
    if (text == null) throw new CommandError(`There is no story “${a.story}” in this version.`);
    let story;
    try {
      story = parseStory(text, storyPath(a.story));
    } catch (error) {
      throw new CommandError((error as Error).message);
    }
    if (story.page === 'dev-server') throw new CommandError('Walkthroughs are for pages in the project. This story runs against a dev server; export the built site and use a page from it.');
    const steps = withFixtures(story.steps, story.fixtures).filter((s) => s.kind !== 'hold');
    const data = { name: story.name, root: '../', typingMsPerChar: story.timing.typingMsPerChar, steps: steps.map((s) => ({ ...s, label: describeStep(s) })) };
    const start = `../${story.page.replace(/^\/+/, '')}`;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Walkthrough: ${esc(story.name)}</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f4f4f6; color: #16161d; }
  .wt { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 100vh; }
  iframe { width: 100%; height: 100vh; border: 0; background: #fff; }
  aside { padding: 28px 24px; display: grid; align-content: start; gap: 12px; border-left: 1px solid #ddd; background: #fff; }
  #wt-count { margin: 0; font-size: 13px; color: #5c5c6b; }
  h1 { margin: 0; font-size: 22px; line-height: 1.2; }
  #wt-text { margin: 0; font-size: 16px; line-height: 1.5; }
  .wt-actions { display: flex; gap: 8px; }
  button { font: inherit; padding: 10px 16px; border-radius: 10px; border: 1px solid #c9c9d4; background: #fff; cursor: pointer; }
  #wt-next { background: #2f2fb5; border-color: #2f2fb5; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible { outline: 3px solid #2f2fb5; outline-offset: 2px; }
  #wt-note { margin: 0; font-size: 14px; color: #5c5c6b; }
  @media (max-width: 760px) { .wt { grid-template-columns: 1fr; } iframe { height: 60vh; } aside { border-left: 0; border-top: 1px solid #ddd; } }
</style>
</head>
<body>
<div class="wt">
  <iframe id="wt-frame" src="${esc(start)}" data-start="${esc(start)}" title="${esc(story.name)}"></iframe>
  <aside aria-live="polite">
    <p id="wt-count"></p>
    <h1 id="wt-title"></h1>
    <p id="wt-text"></p>
    <div class="wt-actions"><button id="wt-next" type="button">Next</button><button id="wt-restart" type="button">Start over</button></div>
    <p id="wt-note"></p>
  </aside>
</div>
<script type="application/json" id="wt-story">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script src="walkthrough.js"></script>
</body>
</html>
`;
    return new Map([
      [`${WALKTHROUGH_DIR}/${a.story}.html`, html],
      [PLAYER, PLAYER_SCRIPT],
    ]);
  },
};
