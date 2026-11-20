/**
 * Shared brand settings: colours, fonts, text styles and a logo, kept with the project. Updating a
 * brand never rewrites versions silently: "Preview update" lists, per version, the theme tokens and
 * titles that would change; only the ticked items are applied (after a checkpoint, each undoable).
 */
import { useEffect, useState } from 'react';
import { useStudio, toast } from '../../state/store';
import { useVideo } from '../../state/video';
import { useMedia, loadBrand, saveBrand } from '../../state/media';
import { call, errorMessage } from '../../lib/api';
import { Button, EmptyState, IconButton } from '../../components/primitives';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/util';
import type { BrandPlanView, BrandSettingsView } from '../../../shared/media';

const uid = (p: string): string => `${p}-${Math.random().toString(36).slice(2, 8)}`;
const HEX = /^#[0-9a-fA-F]{6}$/;

export function BrandPanel() {
  const projectId = useStudio((s) => s.project!.id);
  const saved = useMedia((s) => s.brand);
  const media = useVideo((s) => s.media);
  const fonts = media.filter((m) => m.kind === 'font');
  const images = media.filter((m) => m.kind === 'image');
  const [draft, setDraft] = useState<BrandSettingsView | null>(saved);
  const [plan, setPlan] = useState<(BrandPlanView & { planId: string }) | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Refresh from the project, but never over edits made while it loaded.
    const start = useMedia.getState().brand;
    void loadBrand(projectId).then((b) => b && setDraft((d) => (d === null || JSON.stringify(d) === JSON.stringify(start) ? b : d)));
  }, [projectId]);
  useEffect(() => {
    if (saved && !draft) setDraft(saved);
  }, [saved, draft]);
  if (!draft) return <div className="editor-loading" />;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const valid = draft.colors.every((c) => c.name.trim() && HEX.test(c.value)) && draft.fonts.every((f) => f.name.trim() && f.family.trim()) && draft.textStyles.every((t) => t.name.trim() && t.size >= 4);
  const edit = (patch: Partial<BrandSettingsView>): void => {
    setDraft({ ...draft, ...patch });
    setPlan(null);
  };
  const save = async (): Promise<boolean> => {
    setBusy(true);
    const ok = await saveBrand(projectId, draft);
    setBusy(false);
    return ok;
  };
  const preview = async (): Promise<void> => {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const p = await call('brand.plan', { projectId });
      setPlan(p);
      setTicked(new Set(p.items.map((i) => i.id)));
    } catch (error) {
      toast({ tone: 'error', title: 'Could not preview the update', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  const apply = async (): Promise<void> => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await call('brand.apply', { projectId, planId: plan.planId, itemIds: [...ticked] });
      toast({ tone: r.failed.length ? 'warning' : 'success', title: `Brand applied to ${r.applied.length} place${r.applied.length === 1 ? '' : 's'}`, body: r.failed.length ? r.failed.map((f) => f.reason).join(' ') : 'A checkpoint was saved first; each change can also be undone where it was made.' });
      setPlan(null);
    } catch (error) {
      toast({ tone: 'error', title: 'Could not apply the brand', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="brand">
      <div className="brand-grid">
        <section className="brand-section material-solid" aria-labelledby="brand-colors">
          <header className="brand-head">
            <h2 id="brand-colors">Colours</h2>
            <IconButton icon="plus" size="sm" label="Add colour" onClick={() => edit({ colors: [...draft.colors, { id: uid('c'), name: draft.colors.length ? 'Accent' : 'Primary', value: '#4338ca' }] })} />
          </header>
          <p className="muted small">A colour named “Primary” sets the site theme’s --mv-color-primary, and so on.</p>
          {draft.colors.map((c, i) => (
            <div key={c.id} className="brand-row">
              <input type="color" className="prop-swatch" aria-label={`${c.name} colour`} value={HEX.test(c.value) ? c.value : '#000000'} onChange={(e) => edit({ colors: draft.colors.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)) })} />
              <input className="input" aria-label="Colour name" value={c.name} maxLength={60} onChange={(e) => edit({ colors: draft.colors.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
              <input className={cx('input mono-input', !HEX.test(c.value) && 'is-invalid')} aria-label={`${c.name} hex value`} value={c.value} maxLength={7} onChange={(e) => edit({ colors: draft.colors.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)) })} />
              <IconButton icon="trash" size="sm" label={`Remove ${c.name}`} onClick={() => edit({ colors: draft.colors.filter((_, k) => k !== i), textStyles: draft.textStyles.map((t) => (t.colorId === c.id ? { ...t, colorId: null } : t)) })} />
            </div>
          ))}
        </section>

        <section className="brand-section material-solid" aria-labelledby="brand-fonts">
          <header className="brand-head">
            <h2 id="brand-fonts">Fonts</h2>
            <IconButton icon="plus" size="sm" label="Add font" onClick={() => edit({ fonts: [...draft.fonts, { id: uid('f'), name: draft.fonts.length ? 'Body' : 'Heading', family: 'Inter', assetId: null }] })} />
          </header>
          <p className="muted small">“Heading” and “Body” set the theme’s font tokens. Pick a font file from Assets to ship it with sites and use it in videos.</p>
          {draft.fonts.map((f, i) => (
            <div key={f.id} className="brand-row">
              <input className="input" aria-label="Font role" value={f.name} maxLength={60} onChange={(e) => edit({ fonts: draft.fonts.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
              <input className="input" aria-label={`${f.name} family name`} value={f.family} maxLength={200} onChange={(e) => edit({ fonts: draft.fonts.map((x, k) => (k === i ? { ...x, family: e.target.value } : x)) })} />
              <select className="input" aria-label={`${f.name} font file`} value={f.assetId ?? ''} onChange={(e) => edit({ fonts: draft.fonts.map((x, k) => (k === i ? { ...x, assetId: e.target.value || null } : x)) })}>
                <option value="">System font (no file)</option>
                {fonts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <IconButton icon="trash" size="sm" label={`Remove ${f.name}`} onClick={() => edit({ fonts: draft.fonts.filter((_, k) => k !== i), textStyles: draft.textStyles.map((t) => (t.fontId === f.id ? { ...t, fontId: null } : t)) })} />
            </div>
          ))}
        </section>

        <section className="brand-section material-solid brand-wide" aria-labelledby="brand-styles">
          <header className="brand-head">
            <h2 id="brand-styles">Text styles</h2>
            <IconButton icon="plus" size="sm" label="Add text style" onClick={() => edit({ textStyles: [...draft.textStyles, { id: uid('ts'), name: draft.textStyles.length ? 'Caption' : 'Headline', fontId: draft.fonts[0]?.id ?? null, size: draft.textStyles.length ? 42 : 96, weight: draft.textStyles.length ? 400 : 700, lineHeight: 1.2, colorId: draft.colors[0]?.id ?? null }] })} />
          </header>
          <p className="muted small">Titles that follow a style (choose it in the clip inspector) are restyled by brand updates. Sizes are for a 1080-pixel-high frame.</p>
          {draft.textStyles.map((t, i) => {
            const set = (patch: Partial<typeof t>): void => edit({ textStyles: draft.textStyles.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
            const color = draft.colors.find((c) => c.id === t.colorId)?.value ?? '#ffffff';
            return (
              <div key={t.id} className="brand-row brand-style-row">
                <span className="brand-sample" style={{ color, fontWeight: t.weight, fontFamily: draft.fonts.find((f) => f.id === t.fontId)?.family }}>
                  Aa
                </span>
                <input className="input" aria-label="Style name" value={t.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
                <select className="input" aria-label={`${t.name} font`} value={t.fontId ?? ''} onChange={(e) => set({ fontId: e.target.value || null })}>
                  <option value="">Default font</option>
                  {draft.fonts.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <input className="input num-input" type="number" min={4} max={400} aria-label={`${t.name} size`} value={t.size} onChange={(e) => set({ size: Number(e.target.value) })} />
                <select className="input" aria-label={`${t.name} weight`} value={t.weight} onChange={(e) => set({ weight: Number(e.target.value) })}>
                  {[300, 400, 500, 600, 700, 800].map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
                <select className="input" aria-label={`${t.name} colour`} value={t.colorId ?? ''} onChange={(e) => set({ colorId: e.target.value || null })}>
                  <option value="">Keep each title’s colour</option>
                  {draft.colors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <IconButton icon="trash" size="sm" label={`Remove ${t.name}`} onClick={() => edit({ textStyles: draft.textStyles.filter((_, k) => k !== i) })} />
              </div>
            );
          })}
        </section>

        <section className="brand-section material-solid" aria-labelledby="brand-logo">
          <header className="brand-head">
            <h2 id="brand-logo">Logo</h2>
          </header>
          <select className="input" aria-label="Logo image" value={draft.logoAssetId ?? ''} onChange={(e) => edit({ logoAssetId: e.target.value || null })}>
            <option value="">No logo</option>
            {images.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {draft.logoAssetId && images.find((a) => a.id === draft.logoAssetId)?.thumbUrl && <img className="brand-logo" src={images.find((a) => a.id === draft.logoAssetId)!.thumbUrl!} alt="Brand logo" />}
        </section>
      </div>

      <div className="brand-actions">
        <Button variant="quiet" disabled={!dirty || busy} onClick={() => setDraft(saved)}>
          Revert
        </Button>
        <Button disabled={!dirty || !valid || busy} onClick={() => void save()}>
          Save brand
        </Button>
        <Button variant="primary" icon="sync" disabled={!valid || busy} onClick={() => void preview()}>
          Preview update…
        </Button>
      </div>

      {plan && (
        <section className="brand-plan material-solid" aria-label="Brand update preview">
          <h2>Where the brand would change</h2>
          {plan.items.length === 0 ? (
            <EmptyState icon="check" title="Nothing to change" body="Every version already matches these brand settings." />
          ) : (
            <ul className="brand-plan-items">
              {plan.items.map((it) => (
                <li key={it.id}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={ticked.has(it.id)}
                      onChange={() =>
                        setTicked((s) => {
                          const n = new Set(s);
                          if (n.has(it.id)) n.delete(it.id);
                          else n.add(it.id);
                          return n;
                        })
                      }
                    />
                    <Icon name={it.kind === 'video-titles' ? 'film' : 'brush'} size={14} />
                    <strong>{it.lineName}</strong>
                    <span className="muted small">{it.kind === 'video-titles' ? `Sequence “${it.target}”` : it.target}</span>
                  </label>
                  <ul className="brand-plan-changes">
                    {it.changes.map((c) => (
                      <li key={c} className="small">
                        {c}
                      </li>
                    ))}
                    {it.fontFiles.map((f) => (
                      <li key={f.path} className="small muted">
                        Copies the font into {f.path}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {plan.notes.map((n) => (
            <p key={n} className="muted small">
              {n}
            </p>
          ))}
          {plan.items.length > 0 && (
            <div className="brand-actions">
              <Button variant="quiet" onClick={() => setPlan(null)}>
                Cancel
              </Button>
              <Button variant="primary" icon="check" disabled={!ticked.size || busy} onClick={() => void apply()}>
                Apply to {ticked.size} place{ticked.size === 1 ? '' : 's'}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
