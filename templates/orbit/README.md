# Orbit

Orbit is a fictional task app used to demonstrate Multiverse Studio end to end: a marketing
site (`index.html`), a working task app (`app.html`), tests (`npm test`, no dependencies), two
living objects (the Pro plan pricing card and the product facts) shared by the site and the
launch video, and a 30-second launch sequence (`sequences/launch.mvseq.json`).

- The app keeps tasks in the browser’s storage only. There is no account, server or database,
  and the site says so. If storage is blocked, tasks last until the page is closed.
- `js/tasks.js` holds the rules (titles, completing, filtering, the open count) and is what
  `tests/tasks.test.js` checks. `js/app.js` connects them to the page.
- The pricing card and the product facts are living objects: edit them in Assets → Objects and
  every placement (page section, video scene) can be updated.

See `docs/DEMO.md` in the Multiverse Studio repository for the 14-step demonstration.
