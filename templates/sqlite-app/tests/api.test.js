import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { migrate, openDatabase } from '../server/db.js';
import { seedDemo, DEMO_BOOKS } from '../server/seed.js';
import { createApp } from '../server/app.js';

// Uses an in-memory database: no files, no network beyond 127.0.0.1.
let server;
let base;
let db;

before(async () => {
  db = openDatabase(':memory:');
  migrate(db);
  server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(() => { db.close(); r(); })));

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test('migrations are recorded and not re-applied', () => {
  const names = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);
  assert.deepEqual(names, ['001_init.sql', '002_finished_on.sql']);
  assert.deepEqual(migrate(db), []);
});

test('demo seed is labelled and only runs on an empty table', async () => {
  assert.equal(seedDemo(db), DEMO_BOOKS.length);
  assert.equal(seedDemo(db), 0);
  const { body } = await call('GET', '/api/books');
  assert.equal(body.books.length, DEMO_BOOKS.length);
  assert.ok(body.books.every((b) => b.isDemo === true));
  const removed = await call('DELETE', '/api/demo');
  assert.equal(removed.body.removed, DEMO_BOOKS.length);
});

test('create, read, update and delete a book', async () => {
  const created = await call('POST', '/api/books', { title: '  Middlemarch ', author: 'George Eliot' });
  assert.equal(created.status, 201);
  assert.equal(created.body.book.title, 'Middlemarch');
  assert.equal(created.body.book.status, 'want');
  assert.equal(created.body.book.isDemo, false);
  const id = created.body.book.id;

  const done = await call('PATCH', `/api/books/${id}`, { status: 'done', rating: 5 });
  assert.equal(done.status, 200);
  assert.equal(done.body.book.rating, 5);
  assert.match(done.body.book.finishedOn, /^\d{4}-\d{2}-\d{2}$/);

  const back = await call('PATCH', `/api/books/${id}`, { status: 'reading' });
  assert.equal(back.body.book.finishedOn, null);

  const listed = await call('GET', '/api/books?status=reading&q=middle');
  assert.deepEqual(listed.body.books.map((b) => b.id), [id]);

  assert.equal((await call('DELETE', `/api/books/${id}`)).status, 204);
  assert.equal((await call('GET', `/api/books/${id}`)).status, 404);
});

test('validation rejects bad input with field messages', async () => {
  const empty = await call('POST', '/api/books', { title: '   ' });
  assert.equal(empty.status, 400);
  assert.ok(empty.body.fields.title);

  const bad = await call('POST', '/api/books', { title: 'Ok', rating: 9, status: 'lost', extra: true });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['extra', 'rating', 'status']);

  const notJson = await call('POST', '/api/books', '{nope');
  assert.equal(notJson.status, 400);

  const wrongType = await call('POST', '/api/books', undefined, { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 415);

  assert.equal((await call('PATCH', '/api/books/999', { status: 'done' })).status, 404);
  assert.equal((await call('GET', '/api/books?status=unknown')).status, 400);
  assert.equal((await call('GET', '/api/nowhere')).status, 404);
});

test('search treats % and _ literally (no wildcard injection)', async () => {
  await call('POST', '/api/books', { title: '100% Pure' });
  await call('POST', '/api/books', { title: 'Plain title' });
  const pct = await call('GET', `/api/books?q=${encodeURIComponent('%')}`);
  assert.deepEqual(pct.body.books.map((b) => b.title), ['100% Pure']);
  const sql = await call('GET', `/api/books?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.deepEqual(sql.body.books, []);
});
