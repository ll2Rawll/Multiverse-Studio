import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db.js';

/** Demo rows. Every one is stored with is_demo = 1 and labelled "Demo" in the app. */
export const DEMO_BOOKS = [
  { title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', status: 'done', rating: 5, notes: 'Demo entry.' },
  { title: 'A Pattern Language', author: 'Christopher Alexander', status: 'reading', rating: null, notes: 'Demo entry.' },
  { title: 'Piranesi', author: 'Susanna Clarke', status: 'want', rating: null, notes: 'Demo entry.' },
  { title: 'The Design of Everyday Things', author: 'Don Norman', status: 'done', rating: 4, notes: 'Demo entry.' },
];

/** Inserts the demo rows only when the table is empty. Returns how many were inserted. */
export function seedDemo(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM books').get();
  if (n > 0) return 0;
  const insert = db.prepare("INSERT INTO books (title, author, status, rating, notes, is_demo, finished_on) VALUES (?, ?, ?, ?, ?, 1, CASE WHEN ? = 'done' THEN date('now') END)");
  db.exec('BEGIN');
  for (const b of DEMO_BOOKS) insert.run(b.title, b.author, b.status, b.rating, b.notes, b.status);
  db.exec('COMMIT');
  return DEMO_BOOKS.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const db = openDatabase(config.databaseFile);
  migrate(db);
  const added = seedDemo(db);
  console.log(added ? `Inserted ${added} demo books.` : 'The database already has books; nothing inserted.');
  db.close();
}
