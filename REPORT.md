# Multiverse Studio 0.2 — implementation and verification report

Status at the end of milestone 7 (v0.2 spec) and the AI director plan D1–D6. “Verified” means a test or a run in this environment exercised it; “mocked” means against recorded response shapes, not the real service.

## What was built

| Area | State |
| --- | --- |
| Revision engine: Shared draft, alternatives, three-way propagation, conflicts, checkpoints, undo, combine (files, hunks, HTML sections, timelines) | Complete, verified by unit tests and the harness journey |
| Workspaces: Explore, Compare & Combine, Design, Build (terminal, dev server), Video, Assets, History | Complete for the documented scope; limits in README → Partial |
| AI: provider adapters, capability tracking, model roles, Assistant, Plan/Build coding agent, budgets | Complete; mocked tests only (no live provider here) |
| AI media: images, transcription, voice-over, video generation, AI timeline edits, page recording | Complete; mocked providers, real FFmpeg |
| Publishing (Netlify, Vercel) | Complete for static files; mocked hosts only |
| Settings → Storage, recovery review, onboarding, FFmpeg queue, benchmarks, accessibility audit | Complete; verified in the harness |
| AI director: shared commands and activity log, living objects, executable stories, outcome comparison, dependency-aware combining, per-destination release status, the Orbit demonstration | Complete; mocked models; stories run in real Chromium; the Orbit demo runs end to end by hand (`tests/orbit.test.ts`) |
| Token saver: brief replies, shortened tool results with the full text kept, batched history compaction, prompt caching (Anthropic, OpenAI) with cached tokens reported, compact instructions and command signatures, savings shown per task | Complete; mocked providers; cache hits not measured live |
| Connect AI apps: MCP server (current and earlier protocol), OAuth 2.1 for ChatGPT and claude.ai, Claude Desktop extension and relay, quick tunnel, per-app approval, pause and history under the app's name | Complete; tested with scripted MCP clients; not tried with the real ChatGPT or Claude apps |
| Live AI activity: activity bar, one target highlight, the AI pointer for real browser steps, Follow AI, pause while you edit, settings | Complete; verified in unit tests and the harness journey (Chromium); not seen in Electron |
| Container runner | Not implemented |
| Packaged Windows build | Configuration only; not built or run here |

## Supported providers and protocols

| Provider | Protocol | Verified |
| --- | --- | --- |
| OpenAI | Responses API, Chat Completions; images (`/images/generations`), transcription (`/audio/transcriptions`) | Mocked |
| Anthropic | Messages API | Mocked |
| Google Gemini | `streamGenerateContent` (SSE); Interactions API for images, speech and video | Mocked |
| OpenRouter | OpenAI-compatible Chat Completions | Mocked |
| Ollama | Native `/api/chat` (NDJSON) or OpenAI-compatible | Mocked |
| LM Studio, custom endpoints | OpenAI Chat, OpenAI Responses or Anthropic Messages, chosen explicitly | Mocked; the harness journey runs a full Assistant and Build task against a local scripted OpenAI-compatible server |
| Netlify (publishing) | REST: create site, ZIP deploy, poll deploy | Mocked (unit tests and harness journey) |
| Vercel (publishing) | REST: upload files by SHA-1, create deployment, poll, cancel | Mocked (unit tests) |

Model identifiers are discovered from each provider or typed in; none are hard-coded. A connection counts as working only after a real request succeeds.

## Required external services

None for manual work: websites, code, video editing and export run offline. Optional:

- An AI provider account and key (or a local server such as Ollama) for the Assistant, coding agent and AI media.
- A Netlify or Vercel account and access token for publishing.
- FFmpeg and ffprobe for video (system PATH, `MV_FFMPEG`/`MV_FFPROBE`, or bundled with `npm run bundle:ffmpeg`).
- The npm registry for installing app template dependencies.

## Credentials

AI keys and publishing tokens are stored in the main process with Electron `safeStorage` (DPAPI, Keychain, Secret Service), or for the session only when that is not available; nothing is written in plain text. They never reach the renderer, projects, exports, generated apps, logs, model prompts, previews or child-process environments. Publishing tokens use separate vault ids from AI keys. Tests use fake tokens and assert they appear nowhere in the workspace.

## Execution isolation

- Build commands, dev servers and coding-agent commands run **as the user**, in a copy of the version under the cache folder, started with argument arrays (no shell), with an allow-listed environment that removes anything resembling a credential. **This is not a sandbox**: a script can read the user's files and use the network. The UI says so in Settings → Tasks and permissions.
- Previews run in a sandboxed origin with a strict CSP and no access to the app bridge. The desktop browser probe is a hidden sandboxed window in its own session with network limited to `127.0.0.1` and previews.
- Child process trees are stopped when a task is cancelled, a project closes or the app quits.

## Supported media formats

- Import: MP4, MOV, M4V, WebM, MKV, AVI; MP3, M4A, AAC, WAV, OGG, Opus, FLAC; PNG, JPEG, WebP, GIF (and BMP/TIFF as images); TTF, OTF, WOFF, WOFF2.
- Playback: browser-playable codecs directly; others (for example HEVC, ProRes) through a 540p H.264 proxy. Exports always read the originals.
- Export: MP4 (H.264 + AAC) and WebM (VP9 + Opus), whole sequence or a range, checked afterwards with ffprobe.

## How it was verified here

- `npm test`: 172 tests, all passing (Node 22, FFmpeg 6.1, Playwright Chromium). Provider, host and AI-app traffic is mocked or scripted; FFmpeg and the browser are real.
- `npm run test:e2e:harness`: 46 steps in Chromium against the real engine, including the accessibility audit in three appearances, a director task (mock model), the activity log, living objects, stories, Outcomes and release destinations, the Orbit demo with a restart, and an AI app (scripted MCP client) working with the live activity layer: approval, View activity, the story pointer, pause and pause-while-you-edit, Follow AI and visuals Off.
- `npm run bench`: see `docs/BENCHMARKS.md`.
- Strict type-checks of engine, main and renderer code (the renderer and main against stand-in React/Electron typings).

Not run here: the Electron app, Monaco, `vite build`, electron-builder, the Electron Playwright spec, Windows, screen readers, any live AI provider, any real hosting service, the real ChatGPT, claude.ai or Claude Desktop apps, and a real Cloudflare tunnel.

## Known limitations

- Publishing sends files as they are; there is no remote build step. Netlify ZIP deploys can't be cancelled at the host (the app stops waiting and says so).
- Design edits static HTML; framework-rendered pages are edited as code.
- The Build terminal is not interactive.
- Video: no keyframes or colour correction; transitions in the viewer approximate the export.
- AI timeline edits see a text description of the timeline, not the frames.
- Media costs are shown as *Unknown* unless a provider publishes prices.
- Stories drive pages through the DOM, not OS input; the walkthrough controls the app only from the same site. Outcomes compare by content and measured runs, never by pixel or preference scores. Release destinations are separate jobs; nothing is released atomically across them.
- The contrast audit skips text over gradients; it does not replace a manual review or screen-reader testing.

## Incomplete features

- Container or VM isolation for commands.
- Windows verification, packaged installers, code signing and auto-update.
- Publishing adapters beyond Netlify and Vercel.
- The director demonstration with a live provider (`docs/DEMO.md`) has not been run: no keys or network here. The manual path and the director's commands are tested; the model's own judgement is not.
- Living objects: the video target is a title scene; asset images inside objects and arbitrary components are not rendered into video.

## Audit (November 2026)

A full pass over the code, tests and builds. Fixed, each with a regression test where one could be written:

- Every test process stayed alive 15 s after finishing: the video service's shutdown wait never cleared its timer (same pattern in the engine host). The suite went from 338 s to 84 s.
- Turning on AI apps could report "on" before the connection file for local apps was written (an intermittent connector test failure).
- Two API keys saved at the same moment could overwrite each other; the key file is now created owner-only instead of being made private just after it was written.
- Custom provider headers refused only a few header names; any header that looks like a credential (by name or by value) now has to go in the key field.
- An AI app could run the project's test script, which runs code on this computer, without asking. It now asks every time.
- The desktop app passed a page-chosen path to *Save the Claude Desktop extension*; it now always saves to Downloads.
- An unhandled rejection in a background job (for example a job update on a full disk) ended the whole engine worker; it now reports the error and keeps running. The export and media job queues also keep going after such a failure.
- Polling loops (publishing, video generation, media generation) added an abort listener on every poll.
- Trimming or splitting a clip could leave fades or a transition longer than the clip, which the editor then refused to change; a split could leave a part shorter than a frame; ripple delete could leave a one-tick gap after splitting a slowed clip.
- Thumbnails were requested before they existed, so a new asset could keep a broken image until reload; their addresses now appear once the pictures are made.
- On clips wider than 4000 px the waveform was squeezed and no longer lined up with the audio.
- A dev server and the API port next to it could be given the same free port.

Type checks: the engine, services and main-process code check cleanly against stand-in Electron typings, and the renderer against stand-in React and zustand typings (written for this audit, not kept in the repo); `@types/react`, Electron, Vite and `@types/diff` are not installed here and there is no network to install them.
