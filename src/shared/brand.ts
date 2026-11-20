/** How a brand text style becomes a title's style (shared by the timeline UI and brand updates). */
import type { BrandSettingsView } from './media';
import type { TextStyle } from './video';

/** Brand sizes are for a 1080-pixel-high frame and scale with the sequence. */
export function brandTitleStyle(brand: BrandSettingsView, styleId: string, frameHeight: number): Partial<TextStyle> | null {
  const style = brand.textStyles.find((s) => s.id === styleId);
  if (!style) return null;
  const out: Partial<TextStyle> = {};
  const color = style.colorId ? brand.colors.find((c) => c.id === style.colorId)?.value : undefined;
  if (color) out.color = color;
  const font = style.fontId ? brand.fonts.find((f) => f.id === style.fontId) : undefined;
  out.fontAssetId = font?.assetId ?? null;
  out.weight = style.weight >= 600 ? 'semibold' : 'regular';
  out.fontSize = Math.max(8, Math.min(600, Math.round((style.size * frameHeight) / 1080)));
  return out;
}
