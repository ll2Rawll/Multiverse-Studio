import { useEffect, useRef, useState, type DependencyList } from 'react';
import { errorMessage } from './api';
import { get, set } from '../state/store';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Load async data when dependencies change; keeps the previous data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, enabled = true): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    fnRef
      .current()
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError(null);
      })
      .catch((e) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

export function useInterval(callback: () => void, ms: number): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useKeyboard(handler: (e: KeyboardEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: KeyboardEvent): void => ref.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}

/** Workspaces that need width (Design, Video) fold the project sidebar away while open, and restore it after. */
export function useFoldSidebar(): void {
  useEffect(() => {
    const was = get().sidebarCollapsed;
    if (!was && window.innerWidth < 1800) set({ sidebarCollapsed: true });
    return () => {
      if (!was && window.innerWidth >= 900) set({ sidebarCollapsed: false });
    };
  }, []);
}
