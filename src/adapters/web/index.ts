import type { ProjectAdapter } from '../types';
import { diagnosticsFor } from './diagnostics';
import { referencesInFile } from './refs';
import { analyzeSection, listSections, transplantSection } from './sections';
import { comparePaths, fileExtension } from '../../shared/paths';

export const webAdapter: ProjectAdapter = {
  id: 'web',
  displayName: 'Static web project (HTML, CSS, JavaScript)',
  validate(paths) {
    if (paths.includes('index.html')) return { ok: true, entry: 'index.html' };
    return { ok: false, message: 'This folder has no index.html at its top level. Choose the folder that contains your site’s index.html.' };
  },
  entryFile(paths) {
    const list = [...paths];
    if (list.includes('index.html')) return 'index.html';
    return list.filter((p) => /\.html?$/i.test(p)).sort(comparePaths)[0] ?? null;
  },
  diagnostics: diagnosticsFor,
  references: referencesInFile,
  structuralFiles(paths) {
    return paths.filter((p) => ['html', 'htm'].includes(fileExtension(p))).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : comparePaths(a, b)));
  },
  structural: {
    listSections: (_path, text) => listSections(text),
    analyze: analyzeSection,
    transplant: transplantSection,
  },
};

export const adapters: Record<string, ProjectAdapter> = { web: webAdapter };

export function adapterFor(id: string): ProjectAdapter {
  return adapters[id] ?? webAdapter;
}
