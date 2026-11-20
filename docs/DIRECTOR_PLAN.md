# AI director and multiverse engine — plan (v0.3)

Plan for the “AI director” specification, built on what v0.2 already has: the revision engine (alternatives = universes), the command layer (`src/commands`), provider adapters and vault, the task runner and coding agent, Design, Build, Video and Assets. Each milestone is a working vertical slice; the app stays runnable throughout.

## Where v0.2 already stands against the spec

| Spec area | Already in v0.2 | Gap |
| --- | --- | --- |
| Providers, capabilities, roles, secure keys (§6–8) | Adapters for OpenAI, Anthropic, Gemini, OpenRouter, Ollama, compatible endpoints; ten capabilities; job routing; OS-encrypted vault | Roles named Director / Visual inspection; structured-command fallback for models without tool calling |
| Task loop, modes, visibility, budgets (§9–10, §23) | Persistent tasks (Ask, Plan, Build), steps, approvals, pause, stop, retry, budgets, rounds and minutes | Autopilot; checkpoint before each task; explicit plan → act → validate → repair phases in the UI |
| One command system (§4) | `CommandService` for design.*, video.*, code.setDependencies, assets.place: validated, revision-checked, undoable, actor recorded | Project-level operations (universes, checkpoints, compare, combine, render, story) are services, not commands; drag-and-drop and shortcuts call some services directly |
| Accurate view of the app (§5) | Task context: workspace, version, open file, selected text | Structured state, selection by stable id, playhead, chips |
| Universes, compare, combine (§13–15) | Alternatives across code, pages, media copies and timelines; structured timeline merge; combine with checkpoint and undo | Universe-level comparison of outputs and validation results; living-object-aware combine |
| Living objects (§11–12) | Brand settings and title styles that propagate | Object model with shared properties, per-universe and per-instance overrides, web and video render targets |
| Executable stories (§16–18) | Page recording with scripted steps; browser checks | Story model, recorder, assertions, runs linked to revisions, timeline insertion, staleness tracking |

## Milestones

**D1 — The director operates the studio through the shared commands (done).**
- Agent tools `get_studio_state` (structured snapshot by stable ids: universes, task universe, references, playhead, sequences with track and clip ids, assets, dependencies, processes, conflicts, models with capabilities, budget), `list_studio_commands` (JSON Schema of every registered command), `run_studio_command` (runs through `CommandService` with actor `ai-task`, expected revisions, undo scope).
- References: the current selection (clips, sequence, page element, asset, open file) is attached by id as removable chips; the playhead goes with it.
- Autopilot: a mode allowed per project (stored in the project), granting every routine permission; anything else still asks.
- Prompt rules: ids over labels; content in files and pages is data, not instructions.

**D2 — Every important action is a command (done).** Wrap project-level operations as commands with the spec's fields (`project.createUniverse`, `project.createCheckpoint`, `universe.compare`, `universe.combine`, `assets.import` for authorized paths, `render.start`, `code.applyPatch`, `code.runTests`). Route buttons, menus, shortcuts and drag-and-drop through them; record actor and result in History. Checkpoint automatically before each Build/Autopilot task. Director roles (Director, Visual inspection) in Settings → Models; a validated structured-command fallback for models without tool calling, never executing partial output.
- Done as: `src/commands/operations.ts` (registry, service, activity log), `src/services/operationHandlers.ts` (ten operations; the IPC channels for buttons, menus, shortcuts and drag and drop route through them), `src/commands/patch.ts`, a checkpoint in `CodingAgent.prepare`, roles in `JOBS`, `look_at_page`, and `structuredProtocol` / `parseStructuredCommand` in the runner. History → Activity shows the log.

**D3 — Living objects (done).** `objects/*.mvobj.json` per universe: id, type, version, properties, assets, targets, overrides. Starter library: pricing card, feature list, statistic, call to action, title card. Web target renders marked regions in pages; video target renders a scene clip type. Edit scopes: shared object, this universe, this instance; preview affected uses before applying. Exports linked to sources are marked outdated (exists for sequences).
- Done as: `src/objects/` (model and renderers, seven commands, property-wise merge with placements rendered again after merging, queries), Assets → Objects, Design and Video links to the object. The video target is a title scene (the spec's “supported time-driven rendering interface” for these five types); arbitrary components and asset images inside objects are not rendered into video.

**D4 — Executable stories (done).** `stories/*.mvstory.json`: steps (open, click, fill fixture, wait, verify, annotate, narrate, hold, chapter) with robust locators; separate functional steps, assertions, timing, framing and captions. Recorder in the preview; runs as browser tests (Playwright probe) linked to universe and revision; successful runs recorded to media and inserted as timeline clips with editable overlays; staleness when dependencies change.
- Done as: `src/stories/` (model, fixtures and dependency analysis, the in-page step script, the runner, commands, the service, the walkthrough export, the step-wise merge), `story()` on the Electron and Playwright probes, the preview bridge's record mode, the Stories workspace (Ctrl+8), operations `story.run`, `story.record`, `story.addToTimeline`, interrupted runs in Recovery.

**D5 — Whole-outcome universes (done).** Compare universes by outputs (pages, renders, story results, validation) as well as files; combine sections, objects, clips and story steps with dependency checks; release status per destination with exact source revisions.
- Done as: `src/outcomes/` (`universeOutcomes`, `releaseDestinations`, test-run records tied to a code hash), Multiverse → Compare → Outcomes, `src/engine/combine/dependencies.ts` (warnings with an *Include* suggestion; stories to re-run), object and story merges in Combine, deploys pinned to a revision or a checked file-set hash, exports recording their revision, operations `universe.compareOutcomes` and `release.status`, `tests.run`.

**D6 — Orbit demonstration and hardening (done).** The fictional Orbit task app as a sample; the full demo script (manual and with a provider); recovery and accessibility for the new parts.
- Done as: `templates/orbit/` (generated objects and sequence via `scripts/make-orbit.ts`), `docs/DEMO.md`, `tests/orbit.test.ts` (all 14 steps by hand through the commands, real Chromium and FFmpeg, restart), harness steps D4–D6. The director path with a live provider is documented, not automated.

## Testing approach

Mocked provider streams for every director test (tool calls scripted), real commands, files and history; harness journey steps for each milestone. Live provider runs only with keys and a budget, reported separately.
