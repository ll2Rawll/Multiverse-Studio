import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types';
import { writeFileAtomic } from '../engine/store/atomic';

const schema = z.object({
  appearance: z.enum(['system', 'dystopia', 'dark', 'light']),
  transparency: z.enum(['system', 'reduced', 'full']),
  motion: z.enum(['system', 'reduced', 'full']),
  livePreviewLimit: z.number().int().min(1).max(12),
  sidebarWidth: z.number().min(180).max(420),
  inspectorWidth: z.number().min(240).max(480),
  editorSplit: z.number().min(0.2).max(0.8),
  taskMode: z.enum(['ask', 'plan', 'build']),
  taskPermissions: z.object({ editAlternative: z.boolean(), runBuildAndTests: z.boolean(), installDependencies: z.boolean(), operatePreview: z.boolean() }),
  activityVisuals: z.enum(['off', 'minimal', 'detailed']),
  followAi: z.boolean(),
  activityLabels: z.boolean(),
});

/** App preferences (not project data) stored as JSON in the user data folder. */
export class SettingsStore {
  private cache: AppSettings | null = null;
  constructor(private readonly file: string) {}

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    try {
      const parsed = schema.partial().safeParse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      this.cache = { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) };
    } catch {
      this.cache = { ...DEFAULT_SETTINGS };
    }
    return this.cache;
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = schema.parse({ ...(await this.get()), ...patch });
    this.cache = next;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}
