/** Connect AI apps: the connector's state, its approvals and the apps working in the studio. */
import { create } from 'zustand';
import { call, errorMessage } from '../lib/api';
import { get as getStudio, toast } from './store';
import type { ConnectorStateView } from '../../shared/connector';
import type { StudioEvent } from '../../shared/types';

export const useConnector = create<{ state: ConnectorStateView | null }>(() => ({ state: null }));

/** Bumped by every state event: a reply to an older request must not replace a newer state. */
let eventSeq = 0;

export async function loadConnector(): Promise<void> {
  const seq = eventSeq;
  try {
    const state = await call('connector.state', {});
    if (seq === eventSeq) useConnector.setState({ state });
  } catch {
    if (seq === eventSeq) useConnector.setState({ state: null });
  }
}

export async function connectorAction<T extends ConnectorStateView>(run: () => Promise<T>, failure = 'Couldn’t change AI apps'): Promise<void> {
  const seq = eventSeq;
  try {
    const state = await run();
    if (seq === eventSeq) useConnector.setState({ state });
  } catch (error) {
    toast({ tone: 'error', title: failure, body: errorMessage(error) });
  }
}

export function handleConnectorEvent(event: StudioEvent, open: (projectId: string, lineId: string | null) => Promise<void>): void {
  if (event.type === 'connector') {
    eventSeq++;
    useConnector.setState({ state: event.state });
  } else if (event.type === 'connector-show') {
    // An AI app is working in a project: show it, so the user can watch (and undo).
    const s = getStudio();
    if (s.project?.id !== event.projectId) {
      toast({ tone: 'info', title: `${event.app} opened a project`, body: 'You can watch its changes here and undo them in History.' });
      void open(event.projectId, event.lineId);
    }
  }
}
