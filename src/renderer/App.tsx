import { useEffect, useRef, type CSSProperties } from 'react';
import { useStudio, set } from './state/store';
import { bootstrap } from './state/actions';
import { call } from './lib/api';
import { Welcome } from './shell/Welcome';
import { Shell } from './shell/Shell';
import { Toasts } from './components/Toasts';
import { Dialogs } from './shell/Dialogs';
import { ConnectorApprovals } from './shell/ConnectorSettings';
import { FRACTURE_PULSE_EVENT } from './design/fracture';

/**
 * Wallpaper bands (% of window height) and their resting horizontal offsets (vw).
 * A single cut runs through the eclipse; below it, the eclipse has slipped sideways.
 */
const BANDS: Array<{ top: number; bottom: number; dx: number }> = [
  { top: 0, bottom: 58, dx: 0 },
  { top: 58, bottom: 100, dx: -2.2 },
];

function resolveSystem(pref: 'system' | string, query: string, systemValue: string, otherValue: string): string {
  if (pref !== 'system') return pref;
  return window.matchMedia(query).matches ? systemValue : otherValue;
}

/** Keep <html> data attributes in sync with appearance, transparency and motion settings. */
function useAppearance(): void {
  const settings = useStudio((s) => s.settings);
  const host = useStudio((s) => s.info?.host);
  const platform = useStudio((s) => s.info?.platform);
  useEffect(() => {
    if (platform) document.documentElement.dataset.platform = platform;
  }, [platform]);
  useEffect(() => {
    const apply = (): void => {
      const theme = resolveSystem(settings.appearance, '(prefers-color-scheme: dark)', 'dark', 'light');
      const chrome = theme === 'dystopia' ? { background: '#120c1d', symbols: '#e9ddf3' } : theme === 'dark' ? { background: '#10131b', symbols: '#c9cee0' } : { background: '#e9ebf0', symbols: '#2a2f3d' };
      const transparency = settings.transparency === 'system' ? (window.matchMedia('(prefers-reduced-transparency: reduce)').matches ? 'reduced' : 'full') : settings.transparency;
      const motion = settings.motion === 'system' ? (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full') : settings.motion;
      const root = document.documentElement;
      root.dataset.theme = theme;
      root.dataset.transparency = transparency;
      root.dataset.motion = motion;
      if (host) root.dataset.host = host;
      if (host === 'electron') {
        void call('app.setChrome', { theme: theme === 'light' ? 'light' : 'dark', ...chrome }).catch(() => undefined);
      }
    };
    apply();
    const queries = ['(prefers-color-scheme: dark)', '(prefers-reduced-transparency: reduce)', '(prefers-reduced-motion: reduce)'].map((q) => window.matchMedia(q));
    queries.forEach((q) => q.addEventListener('change', apply));
    return () => queries.forEach((q) => q.removeEventListener('change', apply));
  }, [settings.appearance, settings.transparency, settings.motion, host]);
}

/**
 * Dystopia wallpaper: soft colour fields and a dark eclipse curve with a sodium rim, cut by
 * one quiet horizontal slip. The bands settle into place once at launch and shift briefly
 * when a shared change propagates. Hidden by CSS in other appearances.
 */
function Fracture() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const settle = window.setTimeout(() => el.classList.remove('is-entering'), 1800);
    let jolt = 0;
    const onPulse = (): void => {
      el.classList.remove('is-entering', 'is-pulse');
      void el.offsetWidth; // restart the animation
      el.classList.add('is-pulse');
      window.clearTimeout(jolt);
      jolt = window.setTimeout(() => el.classList.remove('is-pulse'), 900);
    };
    window.addEventListener(FRACTURE_PULSE_EVENT, onPulse);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(jolt);
      window.removeEventListener(FRACTURE_PULSE_EVENT, onPulse);
    };
  }, []);
  return (
    <div ref={ref} className="fracture is-entering">
      {BANDS.map((band, i) => (
        <span key={i} style={{ '--i': i, '--t': `${band.top}%`, '--b': `${100 - band.bottom}%`, '--dx': `${band.dx}vw` } as CSSProperties} />
      ))}
    </div>
  );
}

function useResponsive(): void {
  useEffect(() => {
    let wasNarrow: boolean | null = null;
    const onResize = (): void => {
      const narrow = window.innerWidth < 1180;
      if (narrow !== wasNarrow) {
        wasNarrow = narrow;
        set({ narrow, inspectorCollapsed: narrow });
      }
      if (window.innerWidth < 900) set({ sidebarCollapsed: true });
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
}

export function App() {
  const ready = useStudio((s) => s.ready);
  const project = useStudio((s) => s.project);
  const busy = useStudio((s) => s.busy);
  useAppearance();
  useResponsive();
  useEffect(() => {
    void bootstrap();
  }, []);
  return (
    <>
      <div className="app-canvas" aria-hidden="true">
        <Fracture />
      </div>
      {ready && (project ? <Shell /> : <Welcome />)}
      <Toasts />
      <ConnectorApprovals />
      <Dialogs />
      <div className="busy-indicator" role="status" aria-live="polite">
        {busy && <span className="busy-pill material-toolbar">{busy}</span>}
      </div>
    </>
  );
}
