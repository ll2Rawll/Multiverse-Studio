import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db.js';

const config = loadConfig();
const db = openDatabase(config.databaseFile);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'The database is up to date.');
db.close();
