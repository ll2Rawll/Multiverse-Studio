# Multiverse Studio — expansion plan (v0.2 onward)

This plan extends the first-pass app (v0.1: static-site alternatives with real three-way
propagation) into the AI-assisted creative environment described in the v0.2 brief. It is
kept short on purpose; `docs/PROGRESS.md` records what is finished, what was verified and
the exact next step.

## 1. Audit of v0.1 (17 Nov 2026)

What works, and was re-verified before any change:

- 40 `node:test` tests (engine, merge, storage, combine, export, security, parsers) pass.
- 11-step harness journey (real `StudioService` in Node + UI bundle in Chromium) passes.
- Architecture: Electron main → engine **worker thread** running `StudioService` → content-addressed
  project store (`project.json` manifest v1, `objects/`, `revisions/`). Renderer is sandboxed and talks
  through zod-validated IPC (`src/shared/ipc.ts`). Previews are served from a custom `mvpreview:`
  scheme with per-token CSP, opaque-origin sandboxed iframes.
- Placeholders: `src/shared/ai.ts` (empty extension point), no process execution, no media.

Not runnable in this sandbox (no package downloads): Electron, Monaco, Vite, electron-builder.
Available: Node 22.23 (with `node:sqlite`), ffmpeg/ffprobe, Chromium via Playwright, git.

## 2. Architectural decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where AI runs | `src/ai/*` in the engine worker (Node). | Keeps network and parsing off the UI and main threads; same code runs in the harness. |
| Where keys live | Main process vault. Electron `safeStorage` encrypts each key into `userData/ai/credentials.json`. If OS encryption is unavailable (or Linux `basic_text`), keys are **session-only** in memory. | Keys never reach the renderer, project files, logs or prompts. The worker asks main for a key per request over the worker port. |
| Provider protocols | Adapters by protocol, not by brand: `openai-responses`, `openai-chat` (OpenRouter, LM Studio, vLLM, custom), `anthropic-messages`, `gemini`, `ollama`. Presets map brands to protocols. | A key does not identify a protocol; custom endpoints choose a protocol explicitly. Unsupported APIs need a new adapter (`ProviderAdapter` interface). |
| Model IDs | Never hard-coded as defaults. Discovered from `/models` endpoints or entered manually. | The brief forbids obsolete IDs; IDs change monthly. |
| Capabilities | Per model, per capability: `declared` (from provider metadata or user), `verified` (a real request succeeded), `unavailable` (provider said no / request failed with unsupported), `unknown`. | Brief §6. |
| Project format | Manifest **v2** with a migration registry (`src/engine/store/migrations.ts`). v1 manifests are migrated on open; the original is kept as `project.v1.json`. | Brief §2. Regression fixture: `tests/fixtures/project-v1`. |
| Tasks, messages, jobs | JSON records per project under `ai/` (tasks) and `jobs/` (generation, export, recording), each a persistent state machine. On open, `running` → `interrupted`; remote jobs with ids can be re-polled; uncertain paid requests are never resubmitted automatically. | Brief §8, §23. |
| Video edit decisions | Stored as JSON files **inside the revision tree** (`sequences/<id>.mvseq.json`) so alternatives, history and checkpoints apply; source media stored once in a content-addressed asset store outside the tree; time as integer **ticks** (1/240000 s) to avoid float drift. Timeline merge is clip-ID aware, never text diff3. | Brief §16, §21E. |
| Running code | `ProcessManager` spawns with argument arrays (no shell), scrubbed environment, materialized run directory per alternative under the cache, process-tree kill on cancel/close. Default mode is a **trusted local runner**, labelled as such; a Docker runner is used when the user enables it and Docker is present. | Brief §11: a working directory is not a security boundary. |
| Commands | A unified command layer (`src/commands/*`) with validated args, target, expected revision, actor (`user`/`ai-task`), result and undo info. Manual controls, shortcuts and AI tools call the same commands. | Brief §20. |
| Web-app stack | React + TypeScript + Vite templates; database template uses `node:sqlite` (no native build step on Windows) with SQL migrations. | Brief §13. |

## 3. Milestones and order of work

1. **Foundation and AI connection** — migrations + fixture test; vault; adapters with SSE/NDJSON
   streaming and cancellation; discovery; capability states; routing; usage and cost (“Unknown” when
   unpriced); persisted conversations; Assistant/Tasks/Inspector panel; global command field;
   Settings → Providers, Models, Usage.
2. **Coding agent** — typed tools, path/scope validation, run directories with sync-back and expected
   revisions, process manager, permissions, ask/plan/build loop, pause/steer/cancel, task alternatives,
   review and restore.
3. **Website builder** — templates (landing, portfolio, small business, dashboard, SQLite app);
   workspaces reorganised to Home / Build / Design / Video / Assets / Multiverse / History; visual
   editing of supported components with source as the single source of truth.
4. **Video editor** — asset store + ffprobe, thumbnails, waveforms; sequence model; timeline UI;
   playback; text/audio controls; undo/redo; ffmpeg export jobs with progress and cancel.
5. **AI media and connections** — transcription, AI timeline operations, image generation, video
   generation, preview recording, shared assets and brand.
6. **Integrated multiverse** — per-resource comparison and combining (timeline-aware), dependency
   tracking, outdated exports.
7. **Polish and delivery** — glass refinement, accessibility, performance, recovery, packaging, docs.

Each milestone ends with tests and the harness journey passing, and `docs/PROGRESS.md` updated.
