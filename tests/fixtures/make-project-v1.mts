// Generated tests/fixtures/project-v1 with the v0.1.0 code (manifest format 1) on 2026-11-17.
// Kept for provenance only: running it against current code produces a format-2 project.
// Source folder: index.html, styles.css and a 4x4 dot.png (see tests/fixtures/README.md).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StudioService } from '../../src/services/studio';
import { SHARED_LINE_ID } from '../../src/shared/types';
const ws = '/tmp/fixture-ws';
await fs.rm(ws, { recursive: true, force: true });
const service = new StudioService({ workspaceRoot: ws, sampleRoot: new URL('../../sample', import.meta.url).pathname, previewUrl: (t) => `http://${t}.localhost:1/`, emit: () => {} });
const report = await service.call('projects.import', { folderPath: '/tmp/fixture-src' });
const projectId = report!.project.id;
const { line } = await service.call('lines.create', { projectId, from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Warm', color: 'amber', description: 'Warmer heading colour', following: true } as never);
await service.call('files.write', { projectId, lineId: line.id, path: 'styles.css', text: 'body { font-family: system-ui; margin: 0; }\n.title { color: #b5541c; }\n' });
const html = (await service.call('files.read', { projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: 'index.html' })).text!;
await service.call('files.write', { projectId, lineId: SHARED_LINE_ID, path: 'index.html', text: html.replace('Version one project', 'A version one project') });
await service.call('shared.save', { projectId, message: 'Reword intro' });
await service.call('history.createCheckpoint', { projectId, name: 'Before migration', description: 'Created by the v1 fixture script' } as never);
await service.call('projects.close', { projectId });
const dir = (await fs.readdir(path.join(ws, 'Projects')))[0]!;
console.log(path.join(ws, 'Projects', dir), projectId);
