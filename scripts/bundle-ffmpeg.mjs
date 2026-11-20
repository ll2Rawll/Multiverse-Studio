/**
 * Copy FFmpeg and ffprobe into resources/bin so electron-builder ships them with the app.
 * Usage: node scripts/bundle-ffmpeg.mjs <ffmpeg> <ffprobe>
 * Nothing is downloaded. The licence note records the exact build configuration, because whether a
 * build is LGPL or GPL depends on it.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [ffmpeg, ffprobe] = process.argv.slice(2);
if (!ffmpeg || !ffprobe) {
  console.error('Usage: node scripts/bundle-ffmpeg.mjs <path-to-ffmpeg> <path-to-ffprobe>');
  process.exit(1);
}
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'bin');
const exe = process.platform === 'win32' ? '.exe' : '';
const version = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' });
execFileSync(ffprobe, ['-hide_banner', '-version'], { stdio: 'ignore' });
for (const [src, name] of [[ffmpeg, `ffmpeg${exe}`], [ffprobe, `ffprobe${exe}`]]) {
  const dest = path.join(bin, name);
  copyFileSync(src, dest);
  if (!exe) chmodSync(dest, 0o755);
}
const gpl = /--enable-gpl/.test(version);
writeFileSync(
  path.join(bin, 'FFMPEG-LICENSE.txt'),
  `This application includes FFmpeg (https://ffmpeg.org), used as separate programs.\n\n${version.split('\n').slice(0, 3).join('\n')}\n\nThis build is licensed under the ${gpl ? 'GNU GPL' : 'GNU LGPL'} (version 2.1 or later for LGPL; see https://ffmpeg.org/legal.html).\nThe corresponding source code is available from the provider of this build or https://ffmpeg.org/download.html.\n`,
);
console.log(`Copied ${ffmpeg} and ${ffprobe} to ${bin} (${gpl ? 'GPL' : 'LGPL'} build). Ship FFMPEG-LICENSE.txt with the app.`);
