import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { cx } from '../lib/util';

export type MenuItem =
  | { kind?: 'item'; label: string; icon?: string; onSelect: () => void; disabled?: boolean; danger?: boolean; hint?: string; checked?: boolean }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string };

/**
 * A menu button with a floating, strongly opaque menu. Keyboard: Enter/Space/↓ open,
 * ↑/↓/Home/End move, Escape closes and returns focus to the trigger.
 */
export function Menu({
  items,
  label,
  trigger,
  align = 'end',
  className,
}: {
  items: MenuItem[];
  label: string;
  trigger: (props: { ref: (el: HTMLButtonElement | null) => void; onClick: () => void; onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean }) => ReactNode;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; flip: boolean }>({ top: 0, left: 0, flip: false });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const actionable = items.map((item, i) => ({ item, i })).filter(({ item }) => (item.kind ?? 'item') === 'item' && !(item as { disabled?: boolean }).disabled);

  const close = (restore = true): void => {
    setOpen(false);
    if (restore) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const menuH = menuRef.current?.offsetHeight ?? 240;
    const menuW = menuRef.current?.offsetWidth ?? 220;
    const flip = r.bottom + menuH + 12 > window.innerHeight;
    const left = align === 'end' ? Math.max(8, r.right - menuW) : Math.min(r.left, window.innerWidth - menuW - 8);
    setPos({ top: flip ? Math.max(8, r.top - menuH - 6) : r.bottom + 6, left, flip });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node) || triggerRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    const onBlur = (): void => close(false);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const target = actionable[focusIndex];
    const el = menuRef.current?.querySelector<HTMLButtonElement>(`[data-index="${target?.i ?? -1}"]`);
    el?.focus();
  }, [open, focusIndex]);

  const openMenu = (index = 0): void => {
    setFocusIndex(index);
    setOpen(true);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(actionable.length - 1);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => (i + 1) % actionable.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => (i - 1 + actionable.length) % actionable.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setFocusIndex(actionable.length - 1);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <>
      {trigger({
        ref: (el) => {
          triggerRef.current = el;
        },
        onClick: () => (open ? close() : openMenu(0)),
        onKeyDown: onTriggerKey,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
      })}
      {open &&
        createPortal(
          <div ref={menuRef} className={cx('menu', 'material-menu', pos.flip && 'is-flipped', className)} role="menu" aria-label={label} style={{ top: pos.top, left: pos.left }} onKeyDown={onMenuKey}>
            {items.map((item, i) => {
              if (item.kind === 'separator') return <div key={i} className="menu-separator" role="separator" />;
              if (item.kind === 'heading') return <div key={i} className="menu-heading">{item.label}</div>;
              return (
                <button
                  key={i}
                  type="button"
                  role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={item.checked}
                  data-index={i}
                  tabIndex={-1}
                  disabled={item.disabled}
                  className={cx('menu-item', item.danger && 'is-danger')}
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                >
                  <span className="menu-item-icon">{item.checked ? <Icon name="check" size={15} /> : item.icon ? <Icon name={item.icon} size={15} /> : null}</span>
                  <span className="menu-item-label">{item.label}</span>
                  {item.hint && <span className="menu-item-hint">{item.hint}</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

export function MoreMenu({ items, label = 'More actions', size = 'md' }: { items: MenuItem[]; label?: string; size?: 'sm' | 'md' }) {
  return (
    <Menu
      items={items}
      label={label}
      trigger={(props) => (
        <button type="button" className={cx('icon-btn', size === 'sm' && 'icon-btn-sm')} aria-label={label} title={label} {...props}>
          <Icon name="more" size={size === 'sm' ? 16 : 18} />
        </button>
      )}
    />
  );
}
