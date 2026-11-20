import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from './config.js';
import { migrate, openDatabase } from './db.js';
import { seedDemo } from './seed.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDatabase(config.databaseFile);
const applied = migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
if (config.seedDemo) {
  const added = seedDemo(db);
  if (added) console.log(`Inserted ${added} demo books (labelled "Demo" in the app).`);
}

const dist = path.join(ROOT, 'dist');
const server = createServer(createApp(db, { staticDir: existsSync(dist) ? dist : undefined }));
server.listen(config.port, '127.0.0.1', () => {
  console.log(`API listening on http://127.0.0.1:${server.address().port}`);
});

function stop() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
