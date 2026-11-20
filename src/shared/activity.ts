/** The project activity log: every state-changing command, with its actor and undo information. */

/** Who did it: the user, a task of the built-in AI, or another AI app connected through MCP (named in `via`). */
export type Actor = 'user' | 'ai-task' | 'ai-app';

export type UndoInfo =
  | { kind: 'operation'; operationId: string; label: string }
  | { kind: 'inverse'; name: string; args: Record<string, unknown>; label: string }
  | { kind: 'checkpoint'; checkpointId: string; label: string }
  | { kind: 'command'; lineId: string; scope: string; label: string }
  | { kind: 'none'; label: string };

export interface ActivityRecord {
  id: string;
  type: string;
  projectId: string;
  universeId: string | null;
  resourceId: string | null;
  expectedRevision: string | null;
  args: string;
  actor: Actor;
  /** For `ai-app`: the app's name as it introduced itself (for example “ChatGPT”). */
  via?: string | null;
  taskId: string | null;
  at: string;
  ok: boolean;
  summary: string;
  undo: UndoInfo | null;
}
