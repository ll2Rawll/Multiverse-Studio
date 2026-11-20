/** Publishing: deployment targets (no secrets) and persistent deploy jobs. */

export const PUBLISH_PROVIDERS = ['netlify', 'vercel'] as const;
export type PublishProvider = (typeof PUBLISH_PROVIDERS)[number];

export const PUBLISH_PROVIDER_INFO: Record<PublishProvider, { label: string; apiBase: string; tokenHelp: string; siteLabel: string; siteHelp: string; cancel: boolean }> = {
  netlify: {
    label: 'Netlify',
    apiBase: 'https://api.netlify.com/api/v1',
    tokenHelp: 'A personal access token from Netlify → User settings → Applications.',
    siteLabel: 'Site',
    siteHelp: 'The site id or its name.netlify.app address. Leave empty to create a new site on the first publish.',
    cancel: false,
  },
  vercel: {
    label: 'Vercel',
    apiBase: 'https://api.vercel.com',
    tokenHelp: 'An access token from Vercel → Account settings → Tokens, with access to the team below.',
    siteLabel: 'Project name',
    siteHelp: 'Lowercase letters, digits and dashes. The project is created on the first publish if it does not exist.',
    cancel: true,
  },
};

export interface PublishTargetView {
  id: string;
  provider: PublishProvider;
  name: string;
  /** Netlify site id/name, or Vercel project name. Empty for a Netlify site created on first publish. */
  site: string;
  /** Vercel team id (optional). */
  teamId: string | null;
  /** Override for testing against a local mock; https only, except for this computer. */
  apiBase: string;
  production: boolean;
  hasToken: boolean;
  tokenStorage: 'encrypted' | 'session' | 'none';
  createdAt: string;
}

export type DeployState = 'queued' | 'packaging' | 'uploading' | 'processing' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'uncertain';

export interface DeployJobView {
  id: string;
  projectId: string;
  lineId: string;
  lineName: string;
  targetId: string;
  targetName: string;
  provider: PublishProvider;
  /** Folder of the version that was published ('' = the whole version). */
  folder: string;
  state: DeployState;
  detail: string;
  /** The host's deploy id, kept so the deploy can be checked after a restart. */
  remoteId: string | null;
  /** The address the host returned (only set after the host confirms the deploy is live). */
  url: string | null;
  /** A unique address for this deploy, when the host gives one. */
  deployUrl: string | null;
  adminUrl: string | null;
  fileCount: number;
  bytes: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  remoteCancel: boolean;
  retryOf: string | null;
  /** The exact source: the version's saved revision when publishing started, whether unsaved changes were included, and a hash of the file set sent. */
  revision?: string | null;
  draft?: boolean;
  sourceHash?: string;
}

export interface PublishPlanView {
  targetName: string;
  provider: PublishProvider;
  /** "Netlify site kiln-studio" etc. */
  destination: string;
  folder: string;
  fileCount: number;
  bytes: number;
  /** Files left out on purpose (secrets, project internals). */
  excluded: string[];
  warnings: string[];
  /** When set, publishing is not possible yet and this says what is needed. */
  requirement: string | null;
  /** Folders that look like build output, offered as alternatives. */
  folders: string[];
}
