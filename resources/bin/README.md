# Bundled FFmpeg (optional)

Put `ffmpeg` and `ffprobe` (`ffmpeg.exe` and `ffprobe.exe` on Windows) here to ship them with the
packaged app; electron-builder copies this folder to `resources/resources/bin`. The app looks for
FFmpeg in this order: `MV_FFMPEG`/`MV_FFPROBE`, this folder, then the system PATH.

Use `npm run bundle:ffmpeg -- <path-to-ffmpeg> <path-to-ffprobe>` to copy them in and record their
version. FFmpeg builds are LGPL or GPL depending on how they were configured: ship the matching
licence text and a link to the source (the script writes `FFMPEG-LICENSE.txt` with the version and
configuration it reports). Nothing is downloaded by the build.
