/** Library fonts, loaded once under a private family name (`mvfont-<asset id>`) for previews. */
import { useEffect } from 'react';
import type { MediaAssetView } from '../../shared/video';

const loaded = new Set<string>();

export function useLibraryFonts(media: MediaAssetView[]): void {
  useEffect(() => {
    for (const m of media) {
      if (m.kind !== 'font' || !m.url || loaded.has(m.id) || typeof FontFace === 'undefined') continue;
      loaded.add(m.id);
      const face = new FontFace(`mvfont-${m.id}`, `url("${m.url}")`);
      void face.load().then(
        (f) => document.fonts.add(f),
        () => loaded.delete(m.id),
      );
    }
  }, [media]);
}
