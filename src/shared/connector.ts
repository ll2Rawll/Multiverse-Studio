/**
 * Connect AI apps: other AI apps (ChatGPT, Claude) use Multiverse Studio through the Model Context
 * Protocol, with the user's own subscription and no API key here. Off until the user turns it on;
 * every new app must be approved in this app, and risky actions still ask here.
 */

export type TunnelState = 'off' | 'starting' | 'on' | 'failed';

export interface ConnectedAppView {
  id: string;
  name: string;
  /** Where the app's sign-in returned to (shown so the user can tell apps apart). */
  redirectHost: string | null;
  kind: 'remote' | 'local';
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ConnectorApprovalView {
  id: string;
  kind: 'connect' | 'action';
  /** The app asking, as it named itself (unverified) and where it signs in from. */
  appName: string;
  redirectHost: string | null;
  title: string;
  detail: string;
  createdAt: string;
}

export interface ConnectorStateView {
  enabled: boolean;
  /** Local endpoint for apps on this computer (Claude Desktop extension, other local MCP clients). */
  localUrl: string | null;
  /** Public HTTPS endpoint for ChatGPT and claude.ai, when a tunnel or address is set. */
  publicUrl: string | null;
  tunnel: { state: TunnelState; tool: 'cloudflared' | 'custom' | null; detail: string; found: boolean };
  apps: ConnectedAppView[];
  pending: ConnectorApprovalView[];
  /** Apps working right now: name, project and what they last did. */
  active: { appId: string; appName: string; projectId: string | null; lastAction: string; at: string }[];
  /** Apps whose changes the person paused (reads still work; changes are refused until resumed). */
  held: string[];
  error: string | null;
}

export const CONNECTOR_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;
