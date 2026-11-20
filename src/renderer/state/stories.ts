/** Story run events: refresh counters and which stories are running. */
import { create } from 'zustand';
import type { StoryRunView } from '../../shared/stories';
import type { StudioEvent } from '../../shared/types';

/** Bumped by story-run events so the views refresh. */
export const useStoryRuns = create<{ revision: number; running: Record<string, boolean> }>(() => ({ revision: 0, running: {} }));
export function handleStoryEvent(event: StudioEvent): void {
  if (event.type !== 'story-run') return;
  const key = `${event.run.storyId}:${event.run.lineId}`;
  const running = Boolean((event.run as StoryRunView & { running?: boolean }).running);
  useStoryRuns.setState((s) => ({ revision: s.revision + 1, running: { ...s.running, [key]: running } }));
}


/** A story to open in the Stories workspace (Follow AI, “View activity”). */
export const useStoryUi = create<{ want: { storyId: string; at: number } | null }>(() => ({ want: null }));
