// Minimal zustand v5 `create` for the offline harness build (the real package is used by the app).
import { useSyncExternalStore } from 'react';

type SetState<T> = (partial: Partial<T> | T | ((state: T) => Partial<T> | T), replace?: boolean) => void;

export function create<T>(init: (set: SetState<T>, get: () => T) => T) {
  let state: T;
  const listeners = new Set<(s: T, prev: T) => void>();
  const setState: SetState<T> = (partial, replace) => {
    const next = typeof partial === 'function' ? (partial as (s: T) => Partial<T>)(state) : partial;
    if (Object.is(next, state)) return;
    const prev = state;
    state = replace ? (next as T) : Object.assign({}, state, next);
    listeners.forEach((l) => l(state, prev));
  };
  const getState = (): T => state;
  const subscribe = (l: (s: T, prev: T) => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  state = init(setState, getState);
  const initial = state;
  function useStore<U>(selector: (s: T) => U = (s) => s as unknown as U): U {
    return useSyncExternalStore(subscribe, () => selector(state), () => selector(initial));
  }
  return Object.assign(useStore, { getState, setState, subscribe, getInitialState: () => initial });
}
