import { useStudio, openDialog } from '../state/store';
import type { TemplateInfo } from '../../shared/types';

/** Small line drawings of each template's layout, so the choice is visual rather than a list of names. */
function Schematic({ id }: { id: string }) {
  const common = { className: 'tpl-schematic', viewBox: '0 0 120 76', 'aria-hidden': true } as const;
  switch (id) {
    case 'landing':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="104" height="5" rx="2" className="s-faint" />
          <rect x="24" y="20" width="72" height="8" rx="2" className="s-strong" />
          <rect x="36" y="31" width="48" height="4" rx="2" className="s-faint" />
          <rect x="50" y="39" width="20" height="6" rx="3" className="s-accent" />
          <rect x="8" y="53" width="32" height="16" rx="3" className="s-faint" />
          <rect x="44" y="53" width="32" height="16" rx="3" className="s-faint" />
          <rect x="80" y="53" width="32" height="16" rx="3" className="s-faint" />
        </svg>
      );
    case 'portfolio':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="44" height="7" rx="2" className="s-strong" />
          <rect x="8" y="18" width="30" height="4" rx="2" className="s-faint" />
          <rect x="8" y="30" width="50" height="38" rx="3" className="s-accent-soft" />
          <rect x="62" y="30" width="50" height="17" rx="3" className="s-faint" />
          <rect x="62" y="51" width="50" height="17" rx="3" className="s-faint" />
        </svg>
      );
    case 'small-business':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="104" height="26" rx="3" className="s-accent-soft" />
          <rect x="14" y="16" width="44" height="6" rx="2" className="s-strong" />
          <rect x="8" y="40" width="50" height="4" rx="2" className="s-faint" />
          <rect x="8" y="48" width="44" height="4" rx="2" className="s-faint" />
          <rect x="8" y="56" width="48" height="4" rx="2" className="s-faint" />
          <rect x="66" y="40" width="46" height="28" rx="3" className="s-faint" />
          <rect x="72" y="47" width="22" height="4" rx="2" className="s-strong" />
        </svg>
      );
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="23" height="12" rx="2" className="s-faint" />
          <rect x="35" y="8" width="23" height="12" rx="2" className="s-faint" />
          <rect x="62" y="8" width="23" height="12" rx="2" className="s-faint" />
          <rect x="89" y="8" width="23" height="12" rx="2" className="s-faint" />
          <rect x="8" y="25" width="70" height="43" rx="3" className="s-faint" />
          <path d="M13 60 L26 48 L37 53 L50 37 L62 44 L73 32" className="s-line" />
          <rect x="82" y="25" width="30" height="43" rx="3" className="s-faint" />
          <rect x="86" y="32" width="20" height="4" rx="2" className="s-accent" />
          <rect x="86" y="41" width="14" height="4" rx="2" className="s-accent" />
          <rect x="86" y="50" width="22" height="4" rx="2" className="s-accent" />
        </svg>
      );
    case 'sqlite-app':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="70" height="10" rx="3" className="s-faint" />
          <rect x="8" y="23" width="70" height="10" rx="3" className="s-faint" />
          <rect x="8" y="38" width="70" height="10" rx="3" className="s-faint" />
          <rect x="8" y="53" width="70" height="10" rx="3" className="s-faint" />
          <rect x="12" y="11.5" width="30" height="3" rx="1.5" className="s-strong" />
          <rect x="12" y="26.5" width="38" height="3" rx="1.5" className="s-strong" />
          <rect x="12" y="41.5" width="26" height="3" rx="1.5" className="s-strong" />
          <rect x="12" y="56.5" width="34" height="3" rx="1.5" className="s-strong" />
          <ellipse cx="98" cy="22" rx="12" ry="4.5" className="s-accent-soft" />
          <path d="M86 22 v30 a12 4.5 0 0 0 24 0 v-30" className="s-db" />
          <path d="M86 32 a12 4.5 0 0 0 24 0 M86 42 a12 4.5 0 0 0 24 0" className="s-db" />
        </svg>
      );
    case 'orbit':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="50" height="60" rx="3" className="s-faint" />
          <rect x="13" y="14" width="30" height="5" rx="2" className="s-strong" />
          <rect x="13" y="24" width="40" height="12" rx="3" className="s-accent-soft" />
          <rect x="13" y="42" width="30" height="4" rx="2" className="s-faint" />
          <rect x="66" y="8" width="46" height="8" rx="3" className="s-faint" />
          <rect x="66" y="21" width="46" height="8" rx="3" className="s-faint" />
          <rect x="66" y="34" width="46" height="8" rx="3" className="s-faint" />
          <circle cx="71" cy="25" r="2" className="s-accent" />
          <circle cx="71" cy="38" r="2" className="s-accent" />
          <rect x="66" y="50" width="46" height="18" rx="3" className="s-accent-soft" />
          <path d="M76 59 h26" className="s-line" />
        </svg>
      );
    case 'launch-video':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="104" height="34" rx="3" className="s-accent-soft" />
          <rect x="34" y="20" width="52" height="6" rx="2" className="s-strong" />
          <rect x="8" y="48" width="30" height="6" rx="2" className="s-accent" />
          <rect x="42" y="48" width="22" height="6" rx="2" className="s-faint" />
          <rect x="88" y="48" width="24" height="6" rx="2" className="s-accent" />
          <rect x="8" y="58" width="104" height="6" rx="2" className="s-faint" />
          <path d="M60 4 V70" className="s-line" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="8" y="8" width="104" height="60" rx="4" className="s-faint" />
        </svg>
      );
  }
}

export function TemplateGallery({ templates }: { templates?: TemplateInfo[] }) {
  const all = useStudio((s) => s.templates);
  const list = templates ?? all;
  if (list.length === 0) return <p className="muted">Templates are not available in this build.</p>;
  return (
    <ul className="tpl-grid">
      {list.map((t) => (
        <li key={t.id}>
          <button type="button" className="tpl-tile" onClick={() => openDialog({ kind: 'new-from-template', templateId: t.id })}>
            <Schematic id={t.id} />
            <span className="tpl-text">
              <span className="tpl-name">{t.name}</span>
              <span className="tpl-stack">{t.stack}</span>
              <span className="tpl-desc">{t.description}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
