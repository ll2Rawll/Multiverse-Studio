/** Bumped when the project activity log gets a new record, so views refresh. */
import { create } from 'zustand';
import type { StudioEvent } from '../../shared/types';

export const useActivity = create<{ revision: number }>(() => ({ revision: 0 }));

export function handleActivityEvent(event: StudioEvent): void {
  if (event.type === 'activity') useActivity.setState((s) => ({ revision: s.revision + 1 }));
}
