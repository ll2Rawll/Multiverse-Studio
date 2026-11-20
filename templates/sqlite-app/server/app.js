import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateBook } from './validate.js';

const MAX_BODY = 64 * 1024;
const COLUMNS = 'id, title, author, status, rating, notes, is_demo AS isDemo, finished_on AS finishedOn, created_at AS createdAt, updated_at AS updatedAt';

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

function send(res, status, body) {
  const json = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(json);
}

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send the request body as application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'The request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

const toBook = (row) => (row ? { ...row, isDemo: row.isDemo === 1 } : row);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

/** Creates the request handler. staticDir (optional) serves the built client in production. */
export function createApp(db, { staticDir } = {}) {
  const q = {
    list: db.prepare(`SELECT ${COLUMNS} FROM books WHERE (:status IS NULL OR status = :status) AND (:q IS NULL OR title LIKE :q ESCAPE '\\' OR author LIKE :q ESCAPE '\\') ORDER BY updated_at DESC, id DESC`),
    get: db.prepare(`SELECT ${COLUMNS} FROM books WHERE id = ?`),
    insert: db.prepare("INSERT INTO books (title, author, status, rating, notes, finished_on) VALUES (:title, :author, :status, :rating, :notes, CASE WHEN :status = 'done' THEN date('now') END)"),
    remove: db.prepare('DELETE FROM books WHERE id = ?'),
    stats: db.prepare("SELECT COUNT(*) AS total, SUM(status = 'want') AS want, SUM(status = 'reading') AS reading, SUM(status = 'done') AS done, SUM(is_demo) AS demo FROM books"),
    clearDemo: db.prepare('DELETE FROM books WHERE is_demo = 1'),
  };

  function update(id, patch) {
    const current = q.get.get(id);
    if (!current) throw new HttpError(404, 'That book does not exist.');
    const sets = [];
    const params = { id };
    for (const [key, val] of Object.entries(patch)) {
      sets.push(`${key} = :${key}`); // keys come from validateBook's allowlist
      params[key] = val;
    }
    if (patch.status && patch.status !== current.status) {
      sets.push("finished_on = CASE WHEN :status = 'done' THEN date('now') ELSE NULL END");
    }
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = :id`).run(params);
    return toBook(q.get.get(id));
  }

  async function route(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'books', ':id']
    if (parts[1] === 'health' && parts.length === 2 && req.method === 'GET') return send(res, 200, { ok: true });
    if (parts[1] === 'stats' && parts.length === 2 && req.method === 'GET') {
      const s = q.stats.get();
      return send(res, 200, { total: s.total, want: s.want ?? 0, reading: s.reading ?? 0, done: s.done ?? 0, demo: s.demo ?? 0 });
    }
    if (parts[1] === 'demo' && parts.length === 2 && req.method === 'DELETE') {
      const { changes } = q.clearDemo.run();
      return send(res, 200, { removed: Number(changes) });
    }
    if (parts[1] !== 'books' || parts.length > 3) throw new HttpError(404, 'Not found.');
    if (parts.length === 2) {
      if (req.method === 'GET') {
        const status = url.searchParams.get('status');
        const search = url.searchParams.get('q')?.trim();
        if (status && !['want', 'reading', 'done'].includes(status)) throw new HttpError(400, 'Unknown status filter.');
        const like = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
        return send(res, 200, { books: q.list.all({ status: status || null, q: like }).map(toBook) });
      }
      if (req.method === 'POST') {
        const { value, errors } = validateBook(await readJson(req));
        if (Object.keys(errors).length) throw new HttpError(400, 'Check the highlighted fields.', errors);
        const row = { author: '', status: 'want', rating: null, notes: '', ...value };
        const { lastInsertRowid } = q.insert.run(row);
        return send(res, 201, { book: toBook(q.get.get(lastInsertRowid)) });
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    const id = Number(parts[2]);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'That book does not exist.');
    if (req.method === 'GET') {
      const book = q.get.get(id);
      if (!book) throw new HttpError(404, 'That book does not exist.');
      return send(res, 200, { book: toBook(book) });
    }
    if (req.method === 'PATCH') {
      const { value, errors } = validateBook(await readJson(req), { partial: true });
      if (Object.keys(errors).length) throw new HttpError(400, 'Check the highlighted fields.', errors);
      return send(res, 200, { book: update(id, value) });
    }
    if (req.method === 'DELETE') {
      const { changes } = q.remove.run(id);
      if (!changes) throw new HttpError(404, 'That book does not exist.');
      return send(res, 204);
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  function serveStatic(req, res, url) {
    if (!staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const root = path.resolve(staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep) && file !== root) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!existsSync(file)) return false;
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await route(req, res, url);
      if (serveStatic(req, res, url)) return;
      send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.fields ? { fields: err.fields } : {}) });
      console.error(err);
      send(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}
