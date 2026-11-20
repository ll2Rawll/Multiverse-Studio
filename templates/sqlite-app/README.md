# Reading list

A small full-stack app: React + Vite in the browser, a Node.js API (`node:http`) and a SQLite database (`node:sqlite`, built into Node).

## Requirements

Node.js 22.13 or later. Nothing else: SQLite is part of Node.

## Run

```
cp .env.example .env   # optional; the defaults work
npm install
npm run dev            # API on 127.0.0.1:8787 and the site on Vite's port (usually 5173)
```

`npm run dev` applies any pending migrations and, when the database is empty and `SEED_DEMO=true`, inserts four **demo** books. Demo rows are stored with `is_demo = 1`, carry a “Demo” label in the list, and can be removed with **Remove demo data** in the app.

## Other commands

| Command | What it does |
| --- | --- |
| `npm test` | API tests against an in-memory database (`node --test`) |
| `npm run migrate` | Apply pending migrations from `migrations/` |
| `npm run seed` | Insert demo rows if the table is empty |
| `npm run build` | Build the site into `dist/` |
| `npm start` | Serve the API and the built `dist/` from one port |

## Layout

- `migrations/` numbered SQL files, applied in order and recorded in `schema_migrations`
- `server/` API: `app.js` routes, `validate.js` input rules, `db.js` connection and migrations, `seed.js` demo data
- `src/` React client; `src/api.js` is the only file that talks to the API
- `tests/` API tests

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/books?status=&q=` | List, filter by status, search title and author |
| POST | `/api/books` | `{ title, author?, status?, rating?, notes? }` |
| GET / PATCH / DELETE | `/api/books/:id` | PATCH accepts any subset of the fields |
| GET | `/api/stats` | Counts by status and demo rows |
| DELETE | `/api/demo` | Remove demo rows |

Invalid input returns `400` with `{ error, fields }`. All queries use bound parameters.

## Configuration

See `.env.example`. Secrets do not belong in source; keep them in `.env`, which is git-ignored. This template needs none.
