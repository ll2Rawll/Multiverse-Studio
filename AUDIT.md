# Multiverse Studio release audit

November 20, 2026 · Desktop source release 0.2.0 · Linux x64

The release builds the Electron desktop app and exercises the video, code, and website workspaces end to end. The review covered the project engine and storage, renderer and IPC, preview and build processes, design and video pipelines, AI tools and connectors, publishing adapters, dependencies, tests, and packaging. The release includes the fixes below. The earlier development report remains available as a historical record. [Development report](REPORT.md)

## Findings and repairs

| Area | What the review found | Change in this release |
| --- | --- | --- |
| Code editor | A pending autosave shared state with the next file. Switching documents while a write was delayed could block the newly opened file or misdirect the next edit. | Isolated pending text and revision hashes by project, version, and path. A regression test holds an HTML write open, edits CSS, reopens the HTML, and checks both files on disk. |
| Video exports | Concurrent queue loads or status writes could expose a completed or cancelled state ahead of the durable job record. | Shared in-flight loads and ordered per-project writes keep the queue consistent across reads and restarts. |
| Dependencies | The initial dependency resolution reported 19 npm advisories, including one critical and 14 high. The original toolchain used Electron 37. | Updated to Electron 45.4.1, electron-builder 26.18.0, and Zod 4.6.7. Added a lockfile, migrated command schemas to Zod’s public JSON Schema API, and retained support for partial saved model assignments. |
| AI media | A Gemini media URL could qualify for authenticated handling by matching only the configured host. | Authenticated requests now require the same origin, including the scheme and port. |
| Build and packaging | The TypeScript build lacked an iterable DOM declaration. The packaged AI connector also lacked its external bridge and icon. | Restored the production build and included both resources. The packaged resources produced a valid desktop extension with ten declared tools. |
| Test portability | Browser probes depended on a machine-specific Playwright path. Several desktop assertions relied on outdated UI state or output formatting. | Resolved the project’s own Playwright installation and updated checks to exercise the active version, current navigation, and supported Node output. |

## Verification

| Check | Result |
| --- | --- |
| Strict TypeScript and production build | Passed for the renderer, main process, worker, and preload. |
| Unit and integration suite | 172 passed. Coverage includes version merges, storage and recovery, source edits, media, exports, AI operations, and publishing contracts. FFmpeg rendered real MP4 and WebM output. |
| Chromium workflow suite | 47 passed against the real service. Includes three appearance themes, visual page editing, website-to-video recording, timeline changes, and delayed editor saves. The browser harness supplies an editor stand-in. |
| Native Electron | 2 journeys passed with the desktop runtime. They cover creating a project, editing and propagating changes, resolving a conflict, exporting, and reopening after restart. |
| Packaged desktop | Built and launched the unpacked Linux x64 app in a fresh profile, created the Kiln project, and read the live website preview. Verified the connector archive contents separately. |
| Local AI | Connected a real Qwen2.5-1.5B model through a local llama.cpp server. The Assistant identified all three alternatives in the Afterimage project. Small-model responses to open-ended creative prompts varied. |
| Release film | 30.000 seconds, 900 frames, 1920 × 1080 H.264 with 48 kHz stereo AAC. The visuals include native Electron recordings and original motion artwork. The soundtrack is the supplied recording, level-matched for playback with a short ending fade. |

Test environment included Node 24.22.1, npm 11.9.0, Playwright 1.65.1, and FFmpeg 7.1.5. To reproduce from a checkout, install FFmpeg and its probe on your PATH and run

```sh
npm ci
npx playwright install chromium
npm run build
npm test
npm run test:e2e:harness
npm run test:e2e
npm audit --omit=dev
npm audit
```

The native desktop tests need a graphical session. For an unpacked build, run `npm run package:dir`.

## Remaining findings and coverage limits

- **Dependency advisories.** The final production dependency audit reported zero known advisories. The complete lockfile reported six moderate entries through packaging dependencies associated with one `minimatch` advisory. No high or critical entries remained. Recheck the packaging chain when a compatible fix ships. [GitHub advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- **External integrations.** Automated hosted AI and Netlify/Vercel publishing checks used local fixtures. Live commercial-provider billing, public deployment, external AI-client pairing, and tunnel setup were outside the live run.
- **Platform and accessibility.** Native and packaged verification covered Linux x64. Windows and macOS installer execution, signing, and screen-reader testing remain unverified. The automated accessibility checks cover accessible names, labels, IDs, and sampled contrast.
- **Project commands.** Running a build, dev server, or approved project script executes local code with the operating-system permissions of the current user. Use trusted project scripts. [Studio guide](GUIDE.md)

## Source provenance

The supplied Google Drive ZIP was 46,119,851 bytes. All 560 archive entries passed ZIP integrity checks. Its SHA-256 is `6c08b2b42c61e4467436a44ad124f7652df1aae4bd07da1797582863e3288493`. The first commit preserves the imported project files. The release also offers the original archive byte-for-byte and the audited source at the release tag. [Release downloads](https://github.com/ll2Rawll/Multiverse-Studio/releases/tag/studio-showcase)
