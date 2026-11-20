# The Orbit demonstration

Orbit is a fictional task app that ships as a template (**Home → Orbit demo app**). It has a
marketing site (`index.html`), a working task list (`app.html`, tasks kept in the browser only),
tests that need no install (`npm test` runs `node --test`), a pricing card and a headline as
living objects, and a 30-second launch sequence that uses both.

The fourteen steps below can be done by hand with no provider connected, or by asking the
director. What is automated, and how:

| Path | Where | What it proves |
| --- | --- | --- |
| Manual, through the same commands as the buttons | `tests/orbit.test.ts` | All 14 steps with a real browser (Chromium) and real FFmpeg, then a restart |
| Manual, in the UI | `e2e/harness-journey.mjs` steps D4–D6 | Recording steps in the preview, running and recording stories, Outcomes, release destinations, restart and reopen |
| Director, scripted mock model | `tests/director.test.ts`, `tests/stories.test.ts`, journey “Director” | The director uses the same commands, approvals and activity log |
| Director, live provider | not automated | Needs your key and network; see “Live check” below |

Mocked runs are labelled as such everywhere. Nothing in the automated runs calls a real model.

## The steps

**1. Connect a provider.**
Manual: skip it; every step below works without one.
Director: Settings → Providers, add a key (stored by the operating system’s secure storage, or for
this session only). The key never reaches the project, the preview, the generated app or logs.

**2. Build or extend the task interface.**
Manual: in Build, add a “Clear completed” button: a `clearCompleted` function in `js/tasks.js`,
the button in `app.html`, its handler in `js/app.js`, and a test in `tests/tasks.test.js`.
Director: “Add a Clear completed button to Orbit’s task list, with a test.” The task starts from a
checkpoint, edits a task universe and runs `npm test` (allowed by default; installing is not).

**3. Create Professional and Playful universes.**
Manual: Multiverse → New universe twice, both following Shared. Give Playful a warmer primary
colour and rounder corners in Design.
Director: “Make a Professional and a Playful direction of the site.”

**4. Reuse shared product information and the pricing card.**
Manual: Assets → Objects → Pro plan. It is placed on `index.html` and in the launch video.
In Playful, change the price for this universe; Professional keeps $8. Shared edits (the plan
name, for example) reach both without conflicts.
Director: “In Playful, offer Pro at $6 and update every place it appears.”

**5. Run and test the application.**
Manual: Multiverse → Compare → Outcomes → **Run tests** under each universe. Results are tied
to the files they ran on and go stale when the code changes.
Director: “Run the tests in both universes.”

**6. Create an executable story.**
Manual: Stories → New story “Create and complete a first task”, starting at `app.html`.
**Record steps**, type a title and press Enter, tick the task, **Stop recording**, then add a
check for “0 open”. Use a fixture (`task = Draft the launch notes`) instead of real data.
Director: “Demonstrate how a new user creates and completes their first task.”

**7. Record the successful story.**
Manual: **Run test**, then **Record video**. The clip is kept only if every action and check
passes; a failing flow records nothing and says which step failed.
Director: the same, through `story.run` and `story.record`. It reports failures instead of
recording them.

**8. Insert the recording into the timeline.**
Manual: choose “The end of Orbit launch” (or a new sequence) before recording, or press
**Add to video** on a recording.
Director: “Put the recording after the headline in the launch video.”

**9. Add matching editable titles and branding.**
The story’s chapters, captions and narration arrive as ordinary text clips on “Story titles”
and “Story narration” tracks. Add a lower third and apply a brand text style in Video.

**10. Different pacing per universe.**
Manual: in Playful, set the recording’s speed to 1.5× and bring the pricing scene earlier.
Director: “Make Playful’s launch video faster.”

**11. Compare the results.**
Multiverse → Compare → Outcomes. Pages, objects and timelines are read from the files; stories,
tests, renders and deploys are measured and say what they ran on. There are no scores.

**12. Combine into a new universe.**
Combine → a new universe based on Professional, taking Playful’s `theme.css` and launch
timeline. The review lists what picked parts rely on (objects, the object stylesheet, files a
story looks for) with an **Include** button, and which stories will need a new run. A checkpoint
is created before applying.

**13. Export the chosen app and video.**
Export the combined universe as a folder or ZIP (an ordinary static site) and export the launch
video as MP4. Each is its own release destination with the exact revision it came from; they are
never released together as one step. Publishing to Netlify or Vercel reports success only after
the host confirms.

**14. Restart and reopen.**
Quit and reopen. The project, universes, checkpoints, activity, stories and their runs, exports
and test results are all there. Work that was running is listed under Recovery; nothing restarts
on its own, and a story run that was cut off is never shown as passing.

## Live check (with your provider)

Run steps 2, 6–8 and 10 with the director against your own provider and compare with the
manual results: the same commands appear in History → Activity with the AI as the actor, and
the story’s status in Outcomes is what decides whether the flow works, not the model’s summary.
