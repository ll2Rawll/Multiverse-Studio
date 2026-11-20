/**
 * Settings → AI apps: let ChatGPT, Claude and other MCP apps use Multiverse Studio with the user's
 * own subscription. Plus the approval card that appears wherever the user is.
 */
import { useEffect, useState } from 'react';
import { call, errorMessage } from '../lib/api';
import { toast } from '../state/store';
import { connectorAction, loadConnector, useConnector } from '../state/connector';
import { Button, Toggle } from '../components/primitives';
import { Icon } from '../components/Icon';
import { relativeTime } from '../lib/util';

function Copyable({ value, label }: { value: string; label: string }) {
  return (
    <div className="connector-copy">
      <code aria-label={label}>{value}</code>
      <Button
        size="sm"
        variant="quiet"
        icon="copy"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => toast({ tone: 'success', title: 'Copied' }),
            () => toast({ tone: 'error', title: 'Couldn’t copy', body: 'Select the text and copy it.' }),
          )
        }
      >
        Copy
      </Button>
    </div>
  );
}

export function ConnectorSettings() {
  const state = useConnector((s) => s.state);
  const [own, setOwn] = useState('');
  const [saved, setSaved] = useState<{ file: string; config: string } | null>(null);
  useEffect(() => void loadConnector(), []);
  if (!state) return <p className="field-hint">Connecting AI apps is not available here.</p>;
  const tunnelBusy = state.tunnel.state === 'starting';
  return (
    <div className="connector-settings">
      <Toggle
        checked={state.enabled}
        onChange={(enabled) => void connectorAction(() => call('connector.setEnabled', { enabled }))}
        label="Let AI apps use Multiverse Studio"
        description="ChatGPT, Claude and other apps that support MCP can create and edit your projects here, with your own subscription and no API key. Each app must be approved here first, risky actions still ask you, and every change can be undone."
      />
      {state.error && (
        <p className="info-banner" role="alert">
          {state.error}
        </p>
      )}
      {state.enabled && (
        <>
          <section className="connector-card" aria-labelledby="claude-desktop-title">
            <h3 className="ai-subhead" id="claude-desktop-title">
              Claude Desktop
            </h3>
            <ol className="connector-steps">
              <li>
                <Button
                  size="sm"
                  icon="export"
                  onClick={() =>
                    void call('connector.extension.save', {}).then(
                      (r) => setSaved(r),
                      (e) => toast({ tone: 'error', title: 'Couldn’t save the extension', body: errorMessage(e) }),
                    )
                  }
                >
                  Save the Claude Desktop extension
                </Button>
                {saved && <span className="field-hint"> Saved to {saved.file}</span>}
              </li>
              <li>Open it, or in Claude Desktop go to Settings → Extensions → Install extension, and choose the file.</li>
              <li>Ask Claude: “Use Multiverse Studio to make …”. Approve Claude here the first time.</li>
            </ol>
            {saved && (
              <details className="connector-more">
                <summary>Other apps on this computer</summary>
                <p className="field-hint">Apps that run MCP servers as a command can use this configuration:</p>
                <Copyable value={saved.config} label="MCP configuration" />
              </details>
            )}
          </section>

          <section className="connector-card" aria-labelledby="remote-apps-title">
            <h3 className="ai-subhead" id="remote-apps-title">
              ChatGPT and claude.ai
            </h3>
            <p className="field-hint">These apps reach Multiverse Studio over the internet, so it needs a public HTTPS address that forwards to this computer. Anyone can find the address, but only apps you approve here can use it.</p>
            {state.publicUrl ? (
              <>
                <Copyable value={state.publicUrl} label="Connector address" />
                <p className="field-hint">{state.tunnel.detail}</p>
                <div className="connector-row">
                  {state.tunnel.tool === 'cloudflared' ? (
                    <Button size="sm" variant="quiet" onClick={() => void connectorAction(() => call('connector.tunnel.stop', {}))}>
                      Stop the tunnel
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" onClick={() => void connectorAction(() => call('connector.setPublicUrl', { url: null }))}>
                      Remove the address
                    </Button>
                  )}
                </div>
                <ol className="connector-steps">
                  <li>ChatGPT (web): Settings → Apps &amp; Connectors → Advanced → turn on Developer mode, then Create. Paste the address, choose OAuth, and connect.</li>
                  <li>claude.ai: Settings → Connectors → Add custom connector, and paste the address.</li>
                  <li>Approve the app here when it asks. Then, in a chat with the connector turned on: “Use Multiverse Studio to make …”.</li>
                </ol>
                <p className="field-hint">What each plan allows depends on OpenAI and Anthropic. ChatGPT’s Developer mode is in beta, and some plans may only allow read-only connectors.</p>
              </>
            ) : (
              <>
                <div className="connector-row">
                  <Button size="sm" icon="globe" disabled={!state.tunnel.found || tunnelBusy} onClick={() => void connectorAction(() => call('connector.tunnel.start', {}), 'Couldn’t start the tunnel')}>
                    {tunnelBusy ? 'Starting…' : 'Start a quick tunnel'}
                  </Button>
                  {!state.tunnel.found && <span className="field-hint">Needs Cloudflare’s cloudflared to be installed.</span>}
                </div>
                {state.tunnel.state === 'failed' && <p className="field-hint">{state.tunnel.detail}</p>}
                <form
                  className="connector-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connectorAction(() => call('connector.setPublicUrl', { url: own }), 'Couldn’t use that address');
                  }}
                >
                  <label className="field-label" htmlFor="connector-own">
                    Or your own address
                  </label>
                  <input id="connector-own" className="input" placeholder="https://studio.example.com" value={own} onChange={(e) => setOwn(e.target.value)} />
                  <Button size="sm" type="submit" disabled={!own.trim()}>
                    Use address
                  </Button>
                </form>
                <p className="field-hint">For a fixed address, forward a named Cloudflare tunnel, ngrok or Tailscale Funnel to {state.localUrl?.replace(/\/mcp$/, '') ?? 'the local port'}.</p>
              </>
            )}
          </section>

          <section className="connector-card" aria-labelledby="connected-apps-title">
            <h3 className="ai-subhead" id="connected-apps-title">
              Connected apps
            </h3>
            {state.apps.length === 0 ? (
              <p className="field-hint">No apps yet.</p>
            ) : (
              <ul className="connector-apps">
                {state.apps.map((a) => {
                  const now = state.active.find((x) => x.appId === a.id);
                  return (
                    <li key={a.id}>
                      <Icon name={a.kind === 'local' ? 'desktop' : 'globe'} size={14} />
                      <span className="connector-app-name">{a.name}</span>
                      <span className="field-hint">
                        {a.redirectHost ? `${a.redirectHost} · ` : 'On this computer · '}
                        {a.lastUsedAt ? `used ${relativeTime(a.lastUsedAt)}` : `approved ${relativeTime(a.createdAt)}`}
                        {now ? ` · ${now.lastAction}` : ''}
                      </span>
                      <Button size="sm" variant="quiet" onClick={() => void connectorAction(() => call('connector.revoke', { appId: a.id }))}>
                        Disconnect
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Approval requests from AI apps, shown wherever the user is. */
const NO_PENDING: never[] = [];

export function ConnectorApprovals() {
  const pending = useConnector((s) => s.state?.pending) ?? NO_PENDING;
  const first = pending[0];
  if (!first) return null;
  const decide = (allow: boolean) => void connectorAction(() => call('connector.decide', { id: first.id, allow }));
  return (
    <div className="connector-approval" role="alertdialog" aria-labelledby="connector-approval-title" aria-describedby="connector-approval-detail">
      <Icon name={first.kind === 'connect' ? 'link' : 'warning'} size={16} />
      <div className="connector-approval-text">
        <strong id="connector-approval-title">{first.title}</strong>
        <p id="connector-approval-detail">{first.detail}</p>
        {pending.length > 1 && <p className="field-hint">{pending.length - 1} more waiting</p>}
      </div>
      <div className="connector-approval-actions">
        <Button size="sm" variant="quiet" onClick={() => decide(false)}>
          Deny
        </Button>
        <Button size="sm" onClick={() => decide(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}
