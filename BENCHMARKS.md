# Benchmarks

Measured with `npm run bench` (scripts/bench.ts) on 2026-11-18: Intel(R) Xeon(R) Processor @ 2.10GHz × 2, 8 GB RAM, linux 6.18.44-fc-v595, Node 22.23.4.
Real engine and services, generated content, no network. Times are single runs; expect variation of ±30%.

| Operation | Size | Time |
| --- | --- | --- |
| Import a folder | 1000 HTML files, about 1.4 MB | 1020 ms |
| Create alternatives (following) | 8 alternatives | 53 ms |
| Save a Shared change (propagation) | merged into 8 alternatives with their own edits | 125 ms |
| Compare two versions | 1000 files | 26 ms |
| Publish packaging (select + ZIP) | 1000 files | 259 ms |
| Measure storage | cache categories + projects | 121 ms |
| Tidy history (garbage collection) | 9 versions | 21 ms |
| Import clips and make previews | 8 × 4 s 720p clips; at most 1 FFmpeg job at once | 3600 ms |
| Peak concurrent FFmpeg preview jobs | limit 1 on 2 CPUs | 1 |
