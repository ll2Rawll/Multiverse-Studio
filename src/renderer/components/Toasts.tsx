import { useStudio, dismissToast } from '../state/store';
import { Icon } from './Icon';
import { IconButton } from './primitives';
import { cx } from '../lib/util';

const ICONS = { info: 'info', success: 'check', warning: 'conflict', error: 'error' } as const;

export function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      <div aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', 'material-menu', `toast-${t.tone}`)} role={t.tone === 'error' ? 'alert' : 'status'}>
            <span className="toast-icon">
              <Icon name={ICONS[t.tone]} size={18} />
            </span>
            <div className="toast-text">
              <strong>{t.title}</strong>
              {t.body && <p>{t.body}</p>}
              {t.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    t.action!.run();
                    dismissToast(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <IconButton icon="close" label="Dismiss notification" size="sm" onClick={() => dismissToast(t.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}
