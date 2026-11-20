# Progress log

Kept current so work can resume exactly where it stopped. Newest first.

## Exact next step

The AI director plan (D1–D6), the token saver, the AI app connector and the live activity layer are implemented. Next: connect the real ChatGPT and Claude apps once (Claude Desktop extension; ChatGPT through a tunnel) and watch a session end to end, then run `npm install && npm run typecheck && npm test && npm run test:e2e` on Windows, run the director demo (`docs/DEMO.md`) once against a live provider with a small budget, publish once to each host with a test token, and add a container runner.

## Live AI activity (done)

- Events: `src/shared/live.ts` (`LiveEvent`, targets by identity: code lines, page elements, story steps with locators, clips, tracks, assets, objects, universes). `src/live/describe.ts` (changed line ranges, command and tool descriptions), `src/live/hub.ts` (`LiveHub`: AI actors only, universe names, task labels). Sources: `CommandService.onApplied`/`onFailed`, `OperationHost.onLive`, `TaskRunner` (`RunnerDeps.live`: task start/finish, planning, tool steps with `ToolResult.targets`, pause with reason), `StoryService` (per-step `onStep` through both probes and the worker protocol `story-step`), connector reads.
- Pausing: `ai.tasks.pause` takes `reason: 'user-edit'`; the runner says *Pausing…* first and *Paused while you edit* when it stops. Connected apps: `connector.hold` refuses their changes (`assertActive`, `beforeChange`).
- Renderer: `state/live.ts` (tasks, coalesced visuals, Follow AI with a saved view, View activity, auto-pause on the person's own edits via `callHooks`), `shell/Activity.tsx` (slot under the toolbar, pill, details, chooser; overlay with one highlight and the pointer), `live/registry.ts` (editors and previews register; previews answer `measure` with a rectangle only). `data-live` on universes, assets, files, objects and story steps. `design/activity.css`.
- Settings: `activityVisuals` (off/minimal/detailed), `followAi`, `activityLabels` in Appearance. Stories: *Include AI activity* for recordings (`aiActivity` → the in-page pointer).
- Fixes found on the way: Settings' approval card selector returned a new array each render (an update loop at startup); connector state events could arrive out of order and hide a pending approval (events are now sent one at a time, and the window ignores replies older than the latest event); an app's file commands didn't tell the window that files changed; a story run in progress was listed as *interrupted*; a highlight could land in a sidebar that was being hidden.
- Tests: `tests/live.test.ts` (4), connector test extended (app events, hold). Harness steps: AI apps (approve, create), activity in another universe, story pointer, pause and edit-pause, Follow AI and visuals Off.

## Connect AI apps (done)

- `src/connector/`: MCP protocol (both eras), OAuth 2.1 authorization server, tools, HTTP service on `127.0.0.1` with discovery file, Cloudflare quick tunnel, Claude Desktop extension (`.mcpb`), handlers. `resources/connector/bridge.mjs`.
- Actor `ai-app` with `via` (the app's name) through commands, operations and the activity log. `code.writeFile` and `code.editFile` commands.
- Settings → AI apps; the approval card.
- Tests: `tests/connector.test.ts` (6).

## Token saver (done)

- `src/ai/compact.ts` (log and test-output compaction, JSON compaction, history stubs and batch boundaries, `read_full_output`, reply rules, output limits), runner integration (`src/ai/runner.ts`: settings, specs, conversation stubs with savings, usage with cached tokens, request breakdown, full outputs saved through `RunnerDeps.outputs`).
- Adapters: Anthropic cache breakpoints and complete usage; OpenAI Responses `prompt_cache_key` and cached tokens; cached tokens from Chat Completions and Gemini.
- `schemaSignature` in `src/director/schema.ts`; `list_studio_commands` uses it; `get_studio_state` compact JSON; shorter instructions (`systemPrompt`) with task context moved to the first message; shorter tool descriptions.
- Settings (`tokenSaver` in AI settings, `ai.tokenSaver.set`), Usage and budgets → Token saver, task status shows cached and saved tokens.
- Tests: `tests/token-saver.test.ts` (11); harness step “Token saver”.

## Director D6 — the Orbit demonstration (done)

- `templates/orbit/`: site, working task app (`app.html`, `js/tasks.js`, `js/app.js`, storage guarded), `tests/tasks.test.js` (`npm test`, no dependencies), the Pro plan and headline objects and the launch sequence, generated through the studio's commands by `scripts/make-orbit.ts`. Template gallery drawing.
- `docs/DEMO.md`: the 14 steps, by hand and with the director, and what is automated.
- `tests/orbit.test.ts`: the 14 steps through the same commands as the buttons, with a restart. Harness step D6: create Orbit from Home, record a story in its task list, run it, restart and find it.

## Director D5 — whole-outcome universes (done)

- `src/shared/outcomes.ts`, `src/outcomes/service.ts` (`universeOutcomes`, `releaseDestinations`), `src/outcomes/validation.ts` (test runs with a code hash).
- Combine: `src/engine/combine/dependencies.ts` (objects, the object stylesheet, story pages and step targets; stories to re-run), object and story merges, `CombineWarning.include` with an *Include* button.
- `src/stories/merge.ts` (by step), also used when Shared changes propagate.
- Publishing: jobs record `revision`, `draft` and `sourceHash`; a saved revision is read from history; unsaved changes are checked by hash before upload. Exports record `revision` and `draft`.
- IPC `outcomes.compare`, `releases.list`, `tests.run`, `tests.list`; operations `universe.compareOutcomes`, `release.status`; `code.runTests` records its run.
- UI: Compare → Outcomes with the release destinations list.
- Tests: `tests/outcomes.test.ts` (4), a release test in `tests/publish.test.ts`; harness step D5.

## Director D4 — executable stories (done)

- `src/shared/stories.ts`, `src/stories/` (model, script, runner, commands, service, walkthrough), probe `story()` in `src/main/browserProbe.ts` and `e2e/harness/playwrightProbe.ts`, the bridge's record mode, `PreviewFrame` record props, the Stories workspace, `stories.*` IPC, operations `story.run`, `story.record`, `story.addToTimeline`, interrupted runs in Recovery, *Export walkthrough*.
- Tests: `tests/stories.test.ts` (5); harness step D4.

## Director D3 — living objects (done)

- `src/shared/objects.ts` (types, the five-type library with fields and defaults), `src/objects/model.ts` (parse and serialize; web renderer with escaping, safe links and a content hash; video renderer to title fields; placement scanning and state: current, outdated, edited), `src/objects/commands.ts` (create, update with optional sync, place, addScene, setInstance, sync, detach; `objects.css`), `src/objects/merge.ts` (property-wise object merge; placements reduced to stubs before a merge and rendered again after), `src/objects/handlers.ts` (`objects.list`, `objects.uses`).
- `TextClip.object` (id, instance, revision, overrides, hash) in the sequence schema and the timeline merge.
- `treeMerge` routes object files to the object merge and renders placements after merging.
- UI: Assets → Objects (list, create, three scopes with an impact line, place on page, add to video, where is this used with update per universe); Design and the Video clip inspector link to the object.
- Publishing leaves `objects/*.mvobj.json` out.
- Tests: `tests/objects.test.ts` (5); harness step 37.

## Director D2 — every important action is a command (done)

- `src/commands/operations.ts`: `OperationRegistry`, `OperationService` (validation, expected revision, actor, result, undo info, activity log in `<project>/commands/activity.jsonl`); `src/shared/activity.ts`.
- `src/services/operationHandlers.ts`: project.createUniverse, duplicateUniverse, deleteUniverse, createCheckpoint; universe.saveShared, compare, combine; render.start; assets.import; code.runTests — each with an AI policy (routine, ask, or deny). `lines.create`, `lines.duplicate`, `lines.delete`, `history.createCheckpoint`, `shared.save`, `combine.apply`, `video.export.start` and `media.import` route through them for every caller. `ops.activity`, `ops.undo`.
- `CommandService.onRecord` logs file commands. `code.applyPatch` (`src/commands/patch.ts`).
- Director: `run_studio_command` runs operations (approval when the policy asks), `get_studio_state` includes universe heads; Build/Autopilot tasks start with a checkpoint (`TaskView.checkpointId`); roles `director` and `visual-inspection`; `look_at_page`; structured-command protocol for models without tool calling.
- UI: History → Activity; *Restore from before the task…* on task cards.
- Tests: `tests/operations.test.ts` (7); harness step 36.

## Director D1 — the director operates the studio through the shared commands (done)

- `src/director/schema.ts`: zod → JSON Schema for command arguments. `src/director/director.ts`: `commandCatalog`, `runStudioCommand` (CommandService, actor `ai-task`), `studioState` (stable ids for universes, sequences, tracks, clips, assets; references; playhead; dependencies; processes; conflicts; models and capabilities; budget).
- Agent tools `get_studio_state`, `list_studio_commands`, `run_studio_command` (Build and Autopilot; validation errors go back to the model; results carry hashes and the undo scope).
- Task context: `references` (file, element, clip, sequence, asset by id) and `playhead`; the composer shows them as removable chips and says they are sent as ids and names.
- Autopilot mode: `ai.project.get/set` (stored in `<project>/ai/settings.json`), refused unless on; grants all routine permissions; the composer toggle “Autopilot for this project”.
- Prompts: studio-control and untrusted-content rules for Plan, Build and Autopilot.
- Tests: `tests/director.test.ts` (4: state, malformed command refused, the AI's title equals the user's, one undo; Ask can't edit; Autopilot gating; schema; catalog). Harness step 35.

## Milestone 7 — polish and delivery (done)

- Publishing (`src/publish/`):
  - `hosts.ts`: Netlify (create site, ZIP deploy, poll) and Vercel (SHA-1 file uploads, create deployment, poll, cancel), from their current API docs. Errors are classified (auth, not found, rate limit, invalid, server, network, timeout) with readable messages; tokens are redacted.
  - `service.ts`: destinations in a settings file (no tokens), tokens in the vault as `publish:<id>`; `selectFiles` leaves out secrets and app internals; `plan()` gives requirements and warnings; persistent jobs in `<project>/publish/jobs.json` with the in-flight step, so recovery can poll by deploy id, mark *result unknown*, or mark interrupted. Retrying an unknown result needs confirmation.
  - UI: Settings → Publishing; the Publish dialog (plan, Publish, recent publishes with Check again, Stop, Publish again); entry points in the Toolbar menu, Inspector and preview cards; `shell.openUrl` (https only).
- Storage (`src/services/storageHandlers.ts`): `storage.usage`, `storage.clean` per category (refused while in use; run folders forgotten afterwards; media previews re-made on demand, including proxies), `storage.compact` (garbage collection). Settings → Storage.
- Settings: tabs for Providers, Models, Tasks and permissions (default mode and permissions persisted in app settings; isolation explained), Usage and budgets, Publishing, Appearance, Media tools, Storage.
- Onboarding: Start with AI (provider or skip, describe, template; prepares a Build task without sending), Create manually (websites, apps, video), Open existing work (folder, or media into a new video project). New `launch-video` template.
- Recovery: `state/recovery.ts` collects interrupted tasks, media jobs, exports and publishes on project open; the *Interrupted work* dialog opens tasks, retries jobs (with confirmation for unknown results) or dismisses them.
- Performance: `heavyWork` limiter for FFmpeg previews, proxies, waveforms, silence scans and audio extraction; `scripts/bench.ts` → `docs/BENCHMARKS.md`.
- Accessibility: `e2e/a11y.mjs` audit in the journey (three themes); fixed tertiary text and Pearl warning/danger contrast; switches link their descriptions. Design inspector edits now run in order against the latest outline (fixes a stale-command race).
- Packaging: optional `resources/bin` FFmpeg (`npm run bundle:ffmpeg`, licence note) in `extraResources`.
- Docs: README, `docs/REPORT.md`, `docs/BENCHMARKS.md`.
- Tests: `tests/publish.test.ts` (8), `tests/storage.test.ts` (3), template test; harness steps 31–34.

## Milestone 6 — integrated multiverse (done)

- `src/video/merge.ts`: `mergeSequences(base, ours, theirs, choices)`.
  - Clips and tracks are matched by id. Clip fields merge in groups (timing, sound, fades and transition, position and crop, text, style, media); timing is one group.
  - Conflict items, each with a stable key: settings, track field, track deleted but changed, clip changed on both sides, clip deleted but changed, and overlapping placements.
  - Undecided items take ours, so the result is always valid; *both* moves the incoming clip to a `<track>-b` track. Ids never depend on display names.
- `diffSequences` gives Compare a clip-level diff: added, removed, moved, trimmed, changed.
- Engine:
  - `mergeTrees` routes `sequences/*.mvseq.json` to the structured merge. An unreadable sequence is a whole-file choice, never a text merge.
  - New conflict type `timeline`, storing item keys and decisions. `saveResolution` recomputes the items after each decision.
  - `createAlternative({ includeDraft })` starts from Shared's unsaved draft by snapshotting it as a revision (`draftBase`). Later shared saves merge against the draft; discarding the draft hands those changes to the alternative.
- Combine:
  - timeline files offer *Merge the timelines* (with decisions) or *Pick tracks and clips* (`kind: 'timeline'`);
  - picked clips keep their times and move to a `<track>-from` track if they would overlap;
  - hunk picks on timelines are blocked;
  - `combine.timeline` feeds the picker and the decision UI.
- Outdated exports: each export records the sequence hash and asset hashes; `video.export.list` reports sequence-changed, media-changed, sequence-deleted or version-deleted.
- `src/services/dependencies.ts`: `deps.status` (package drift against Shared, outdated media copies, outdated exports) and `deps.align`, which runs the `code.setDependencies` command and keeps the file's indentation and key order.
- UI:
  - timeline decisions in the conflicts dialog and in Combine;
  - the track and clip picker;
  - the sequence diff in Compare and in the combine review (*Timeline*);
  - Multiverse → Explore → *Updates*;
  - *Outdated* and *Export again* in the Exports list.
- Tests: `tests/timeline-merge.test.ts` (7).

## Milestone 5 — AI media and connections (done)

- Media adapters (`src/ai/media/adapters.ts`), built from the providers' documentation as of Nov 2026, with no hard-coded model ids:
  - OpenAI-shaped: images (`/images/generations`, b64) and transcriptions (`/audio/transcriptions`, `verbose_json` with segment timestamps where supported);
  - Gemini Interactions: images, speech output and video (background interaction, poll, cancel, file `ACTIVE` before download).
  - OpenAI-compatible connections can opt into images and transcriptions (`mediaOptional`).
- `src/video/generation.ts`: `GenerationJobs`.
  - Plan (what is sent, sizes, connection, model, cost `null` = Unknown), then start, list, cancel and retry.
  - Persisted in `<project>/ai/media-jobs.json`, with the provider job or request id.
  - Recovery after a restart:
    - a video with a remote id is followed again;
    - nothing sent means interrupted;
    - an in-flight paid request is *uncertain* and is retried only with `confirmUncertain`;
    - a lost response (timeout or network error) after sending is also uncertain.
  - App shutdown leaves saved states untouched.
  - Results are imported with provenance (provider, model, prompt, settings, time, request id).
- Transcripts are saved per asset; transcription sends a mono audio extract, chunked for large files.
- Recording: `BrowserProbe.record` (Electron offscreen paint → FFmpeg; Playwright `recordVideo` in the harness) with scripted steps.
- `src/video/aiEdit.ts`: `TimelineAi`.
  - Local planners: remove pauses with cached silencedetect, captions, ducking, trim to length, portrait copy.
  - A model planner with 15 timeline tools, validated on an in-memory copy, with errors fed back (up to 12 rounds), using the coding route.
  - Proposals; apply makes a checkpoint plus one `video.batch` (in place, or as a new alternative from the current draft).
- Timeline commands: `video.duplicateSequence` (reframe fill/fit), `video.batch`, `applyVideoCommand`. Titles gained `template`, `subtitle`, `brandStyleId` and `style.fontAssetId`; the renderer draws title cards, lower thirds and end cards and uses library fonts (TTF, OTF, WOFF).
- Font assets (signature-checked); `assets.place` (binary-capable command) with link tracking in `<project>/media/links.json`; `assets.updateLinks`; `media.usage`; tags.
- Brand: `brand.set`, `brand.plan` and `brand.apply`. The `design.applyBrand` command updates tokens, the managed `@font-face` block and font files in one step. Titles that follow a brand style are restyled through `video.batch`.
- The command layer allows bytes in results (`FileChanges`).
- UI:
  - Generate panel and job list (Assets and the Video bin), with review before sending;
  - Transcribe dialog, *Edit with AI* dialog, *Record a page* dialog;
  - clip inspector: layout, second line, panel colour, brand style, font, transcript;
  - Assets: tags, search, filters, provenance, usage, *Copy into version*, transcript, drag-and-drop import (main asks first);
  - Brand panel with a propagation preview.
- Tests:
  - `tests/media.test.ts` (8), `tests/timeline-ai.test.ts` (4), `tests/brand.test.ts` (4), all against mocked providers;
  - harness steps 24–30, using the harness mock provider (code-drawn images, fixed transcript).

## Milestone 4 — video editor (done)

- Media store (`src/video/media.ts`):
  - imported files are copied into `<project>/media/<aa>/<sha256>.<ext>`, outside the revision tree and shared by every version;
  - stable asset ids, and importing the same content twice gives the same asset;
  - ffprobe metadata;
  - derived files in the cache: thumbnail, a 10-frame strip, waveform peaks, and an H.264 preview proxy for codecs Chromium can't play;
  - missing files are detected, and relink accepts the same content, or a file of the same kind that is at least as long.
- Sequences are `sequences/<id>.mvseq.json` in the project. Time is in integer ticks (240,000 per second).
  - 12 `video.*` commands through the command layer, with validated arguments, stale-revision checks, and undo/redo that persists:
    - add/move/trim/split/delete clips (ripple optional);
    - tracks: add/remove, mute, hide, lock, volume;
    - clip volume, mute, speed 0.25–4×, fades, crossfade or dip transitions, position, scale, rotation, opacity, crop;
    - titles with style.
  - Clips never overlap on a track; transitions use handles when rendering.
- Export (`src/video/render.ts`, `src/video/exporter.ts`):
  - a pure filtergraph builder;
  - inputs are passed as argument arrays, and text and fonts as files in the job folder (no shell, no escaping);
  - H.264/AAC MP4 or VP9/Opus WebM; landscape, portrait and square presets; resolution, frame rate, quality and range options;
  - a persisted job state machine: queued, running, then completed, failed, cancelled or interrupted. Interrupted jobs are never restarted automatically;
  - progress from `-progress pipe:1`, and cancellation;
  - a job completes only after ffprobe reads the file back and the codecs, size and duration match.
- Desktop: `mvmedia:` protocol with byte ranges. The worker resolves asset ids to files, so no renderer path is ever opened. The main process shows the native import, relink and save dialogs. Inter fonts (OFL) are in `resources/fonts`.
- UI:
  - Video workspace: media bin with drag to timeline, the exports list, viewer, clip inspector, and a timeline with ruler, playhead scrubbing, zoom, snapping, drag/trim, filmstrips and waveforms. Shortcuts: Space, S, T, Delete, Shift+Delete, arrows, Home/End, Ctrl+Z/Shift+Z.
  - Assets workspace: library, filters, details, usage, relink.
- Tests:
  - `tests/video.test.ts` (6) uses real FFmpeg on generated footage: probe, dedupe, proxy, waveform, every command and undo, then exports checked by pixel colour (layers, logo position, title, crossfade), audio level, VP9 range export, cancel, interrupted jobs, and missing/relink;
  - harness steps 20–23.

## Milestone 3 — website builder (done)

- Workspace rail: Home, Build, Design, Video, Assets, Multiverse (Explore + Compare & Combine) and History, on Ctrl+1–7. Explore and Compare are two views of Multiverse, and focus follows the switch.
- Templates (`templates/`, `projects.createFromTemplate`, `templates.list`):
  - landing page, portfolio and small business (static, sections with `data-mv-id`, theme tokens);
  - a React/TypeScript/Vite dashboard (labelled demo data; loading, empty and error states; data tests);
  - an SQLite app: `node:http` + `node:sqlite` API, numbered SQL migrations, validation, demo rows flagged `is_demo` with a "Remove demo data" action, `.env.example`, 5 API tests, README.
- Design workspace (`src/design/*`, `design.*` commands):
  - in the canvas, click to select and double-click to edit text in place (bridge Design mode);
  - outline, text, link, image and alt-text fields, and styles per breakpoint written to `design.css`;
  - a section library (insert after the selection), move, duplicate and remove;
  - pages, components (save, insert, update other uses), theme tokens, and undo/redo.
  - The source stays the truth: an in-place text edit changes only those bytes of the HTML.
- Build workspace (`src/build/*`):
  - a terminal with no shell (`parseCommandLine` refuses pipes, redirection, chaining and substitution);
  - npm scripts, Install, and "Bring changes in" (runtime databases, `.env`, `node_modules` and build output are never brought in);
  - a dev server on a free port, previewed in the app. Only ports of dev servers you started may load in a frame (`hardenSessions`).
- Fixes found while testing:
  - AI settings writes are serialized (two quick model assignments could lose one);
  - a late call result no longer downgrades a finished process;
  - listing media no longer re-triggers itself in a loop;
  - a slow first video load can't undo a sequence created meanwhile.

## Milestone 2 — coding agent (done)

- `src/agent/`:
  - typed tools (zod), path and mode validation, permissions with an approval flow (`ApprovalRequired` → `waiting-input` → Allow once / Decline);
  - `ProcessManager`: no shell, scrubbed environment, process-tree kill, bounded output, dev servers on free ports;
  - `RunDirectory` sync, ignoring `node_modules`, build output, caches, local databases and `.env`;
  - Build tasks work in a task alternative;
  - Review changes / Combine into your version.
- Browser probe: Electron hidden sandboxed window (not run here); harness: Playwright.
- Shutdown handshake stops tasks and child processes on quit.

## Milestone 1 — foundation and AI connection (done)

- Project format v2 with a migration registry; the v1 fixture opens, the original is kept as `project.v1.json`, and newer formats are refused.
- Adapters: OpenAI Responses, OpenAI-compatible Chat, Anthropic Messages, Gemini, Ollama. SSE/NDJSON parsing, tool-call assembly, usage, error classification, abortable streams, redaction.
- Vault: Electron `safeStorage`, or session-only (`RemoteVault` RPC from the worker).
- AiService (connections, discovery, verification, routing, prices) and TaskRunner/TaskStore (persisted tasks, interrupted-on-restart without resubmission).
- UI: Assistant / Tasks / Inspector, composer, Ctrl+K command field, Settings → Providers / Models / Usage.

## Verification status (as of milestone 6; current counts are in README → What was actually run)

- `npm test`: 109/109. Providers are mocked (no real keys anywhere in fixtures); video, AI-edit and brand tests use real FFmpeg 6.1.
- `node e2e/harness-journey.mjs`: 30/30 in Chromium against the real engine. Two earlier steps (a Design edit and a Build process list) each failed once across several runs. The Build one was a UI race between the process list fetch and exit events, which is fixed; the Design one did not recur.
- Template checks: dashboard data tests and the SQLite app's API tests run with Node 22; both clients bundle with esbuild; the SQLite server started, migrated and seeded.
- esbuild bundles of main, worker and preload build. The bundled worker answered `video.tools`, `templates.list`, `deps.status` and `brand.plan`, and refused an unconfigured image job with an explanation.
- Type-checks: engine against real types; main and renderer against local stand-ins for Electron and React.
- Not run here:
  - live AI providers (no keys), including every media path: images, transcription, voice-over and video;
  - the Electron runtime: `safeStorage`, the BrowserWindow probe and offscreen recorder, title bar, `mvmedia:` protocol (including fonts), native dialogs and the dropped-file confirmation, dev-server frames under `hardenSessions`;
  - `npm install` for the React templates (no network), and Vite/Monaco builds;
  - Windows packaging.
