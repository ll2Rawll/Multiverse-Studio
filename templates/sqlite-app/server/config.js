import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reads .env (if present) without overriding variables that are already set. */
export function loadConfig(env = process.env) {
  const envFile = path.join(ROOT, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a number between 0 and 65535 (got "${env.PORT}").`);
  const file = env.DATABASE_FILE ?? 'data/app.db';
  return {
    port,
    databaseFile: file === ':memory:' ? file : path.resolve(ROOT, file),
    seedDemo: (env.SEED_DEMO ?? 'true').toLowerCase() === 'true',
  };
}
