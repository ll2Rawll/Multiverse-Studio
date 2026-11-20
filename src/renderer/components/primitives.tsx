import { forwardRef, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon';
import { cx, lineColorVar } from '../lib/util';
import type { LineColor, LineView } from '../../shared/types';
import { shortStatus, statusText } from '../lib/util';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'shared';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: string; size?: 'sm' | 'md' }>(function Button(
  { variant = 'secondary', icon, size = 'md', className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span className="btn-label">{children}</span>}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean; size?: 'sm' | 'md' }>(function IconButton(
  { icon, label, active, size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('icon-btn', size === 'sm' && 'icon-btn-sm', active && 'is-active', className)}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 15 : 18} />
    </button>
  );
});

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: string;
  hideLabel?: boolean;
}

/** Pill segmented control with roving focus (arrow keys, Home/End). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = (): void => {
      const el = refs.current[index];
      if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (groupRef.current) ro.observe(groupRef.current);
    return () => ro.disconnect();
  }, [index, options.length, options.map((o) => o.label).join('|')]);
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next >= 0) {
      event.preventDefault();
      onChange(options[next]!.value);
      refs.current[next]?.focus();
    }
  };
  return (
    <div ref={groupRef} className={cx('segmented', size === 'sm' && 'segmented-sm', className)} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      <span className="segmented-thumb" style={thumb ? { width: thumb.width, transform: `translateX(${thumb.left}px)` } : { opacity: 0 }} aria-hidden="true" />
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={cx('segment', o.value === value && 'is-selected')}
          onClick={() => onChange(o.value)}
          title={o.hideLabel ? o.label : undefined}
          aria-label={o.hideLabel ? o.label : undefined}
        >
          {o.icon && <Icon name={o.icon} size={size === 'sm' ? 14 : 16} />}
          {!o.hideLabel && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className={cx('toggle-row', disabled && 'is-disabled')}>
      <div className="toggle-text">
        <label htmlFor={id} className="toggle-label">
          {label}
        </label>
        {description && (
          <p className="toggle-desc" id={`${id}-desc`}>
            {description}
          </p>
        )}
      </div>
      <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={description ? `${id}-desc` : undefined} disabled={disabled} className={cx('switch', checked && 'is-on')} onClick={() => onChange(!checked)}>
        <span className="switch-knob" aria-hidden="true" />
      </button>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function ColorDot({ color, size = 10, shared }: { color: LineColor; size?: number; shared?: boolean }) {
  if (shared || color === 'shared') {
    return (
      <span className="color-dot is-shared" style={{ width: size + 2, height: size + 2 }} aria-hidden="true">
        <Icon name="shared" size={size + 2} />
      </span>
    );
  }
  return <span className="color-dot" style={{ width: size, height: size, background: lineColorVar(color) }} aria-hidden="true" />;
}

export function StatusBadge({ line, compact }: { line: LineView; compact?: boolean }) {
  const tone =
    line.kind === 'shared' ? (line.hasDraft ? 'draft' : 'neutral') : line.status === 'conflicted' ? 'danger' : line.status === 'paused' || line.status === 'behind' ? 'muted' : 'ok';
  const icon = line.kind === 'shared' ? (line.hasDraft ? 'pencil' : 'check') : line.status === 'conflicted' ? 'conflict' : line.status === 'paused' ? 'pause' : line.status === 'behind' ? 'history' : 'link';
  return (
    <span className={cx('status-badge', `tone-${tone}`)} title={statusText(line)}>
      <Icon name={icon} size={12} />
      <span>{compact ? shortStatus(line) : statusText(line)}</span>
    </span>
  );
}

export function EmptyState({ icon, title, body, children }: { icon: string; title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

export function InspectorSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="inspector-section">
      <header className="inspector-section-head">
        <h3>{title}</h3>
        {actions}
      </header>
      <div className="inspector-section-body">{children}</div>
    </section>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function FileStatusIcon({ status }: { status: 'added' | 'deleted' | 'modified' | 'unchanged' }) {
  const map = { added: ['plus', 'Added'], deleted: ['minus', 'Deleted'], modified: ['dot', 'Modified'], unchanged: ['check', 'Unchanged'] } as const;
  const [icon, label] = map[status];
  return (
    <span className={cx('file-status', `fs-${status}`)} title={label}>
      <Icon name={icon} size={13} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
