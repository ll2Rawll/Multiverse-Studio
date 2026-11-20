# Test fixtures

- `project-v1/` — a real project written by Multiverse Studio v0.1.0 (manifest format 1): imported
  from a three-file site (`index.html`, `styles.css`, a 4×4 `dot.png`), one alternative “Warm” with
  its own CSS, one saved shared change (“Reword intro”) propagated to it, and a named checkpoint
  “Before migration”. `tests/migrations.test.ts` copies it to a temporary workspace and checks that it
  opens, migrates to the current format, keeps its history and never modifies the fixture itself.
- `make-project-v1.mts` — the script that produced it, kept for provenance.

No fixture contains credentials. Provider tests use mocked HTTP responses only.
