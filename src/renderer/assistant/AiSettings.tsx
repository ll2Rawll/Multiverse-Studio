import { useEffect, useMemo, useState } from 'react';
import { call, errorMessage } from '../lib/api';
import { toast } from '../state/store';
import { applyAiState, loadAiState, useAi } from '../state/ai';
import { Button, SegmentedControl, Toggle } from '../components/primitives';
import { Icon } from '../components/Icon';
import { cx } from '../lib/util';
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  JOBS,
  JOB_INFO,
  MEDIA_ADAPTER_INFO,
  PROTOCOL_LABELS,
  PROVIDER_PRESETS,
  presetFor,
  type Capability,
  type CapabilityState,
  type ConnectionView,
  type Job,
  type MediaAdapterId,
  type ModelRecord,
  type Protocol,
  type ProviderKind,
} from '../../shared/ai';
import { costText } from './format';

const STATE_TEXT: Record<CapabilityState, string> = { verified: 'Verified', declared: 'Declared', unavailable: 'Unavailable', unknown: 'Unknown' };
const STATE_ICON: Record<CapabilityState, string> = { verified: 'check', declared: 'dot', unavailable: 'close', unknown: 'info' };

function CapChip({ cap, model }: { cap: Capability; model: ModelRecord }) {
  const rec = model.capabilities[cap];
  const state = rec?.state ?? 'unknown';
  return (
    <span className={cx('cap-chip', `cap-${state}`)} title={`${CAPABILITY_LABELS[cap]}: ${STATE_TEXT[state]}${rec ? ` — ${rec.detail}` : ''}`}>
      <Icon name={STATE_ICON[state]} size={11} />
      {CAPABILITY_LABELS[cap]}
    </span>
  );
}

function keyText(c: ConnectionView): string {
  if (!c.requiresKey && !c.key.present) return 'No key needed';
  if (!c.key.present) return 'No key yet';
  return c.key.storage === 'os-encrypted' ? 'Key saved securely' : 'Key for this session only';
}

/* ---------------- Providers ---------------- */

interface Draft {
  id?: string;
  provider: ProviderKind;
  name: string;
  baseUrl: string;
  protocol: Protocol;
  key: string;
  persistence: 'persistent' | 'session';
  timeout: number;
  headers: string;
  media: MediaAdapterId[];
}

function draftFor(provider: ProviderKind, persistent: boolean, existing?: ConnectionView): Draft {
  const preset = presetFor(provider);
  return {
    id: existing?.id,
    provider,
    name: existing?.name ?? preset.label,
    baseUrl: existing?.baseUrl ?? preset.baseUrl,
    protocol: existing?.protocol ?? preset.protocol,
    key: '',
    persistence: persistent ? 'persistent' : 'session',
    timeout: Math.round((existing?.timeoutMs ?? 120_000) / 1000),
    headers: Object.entries(existing?.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    media: existing?.media ?? preset.media,
  };
}

function ConnectionForm({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const ai = useAi((s) => s.ai)!;
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const preset = presetFor(d.provider);
  const update = (patch: Partial<Draft>): void => setD((x) => ({ ...x, ...patch }));
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const headers: Record<string, string> = {};
      for (const line of d.headers.split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const saved = await call('ai.connections.save', { id: d.id, name: d.name, provider: d.provider, protocol: d.protocol, baseUrl: d.baseUrl, headers, timeoutMs: d.timeout * 1000, media: d.media });
      applyAiState(saved);
      if (d.key.trim()) applyAiState(await call('ai.keys.set', { connectionId: saved.savedId, key: d.key, persistence: d.persistence }));
      setD((x) => ({ ...x, key: '' }));
      const tested = await call('ai.connections.test', { connectionId: saved.savedId });
      applyAiState(tested.state);
      toast({ tone: tested.ok ? 'success' : 'warning', title: tested.ok ? `${d.name} connected` : `${d.name} saved, but the test failed`, body: tested.message });
      onDone();
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t save the connection', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="ai-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{d.id ? `Edit ${d.name}` : `Connect ${preset.label}`}</h3>
      <p className="field-hint">{preset.note}</p>
      <div className="field">
        <label className="field-label" htmlFor="c-name">Display name</label>
        <input id="c-name" className="input" value={d.name} onChange={(e) => update({ name: e.target.value })} maxLength={80} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="c-url">Base URL</label>
        <input id="c-url" className="input mono" value={d.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => update({ baseUrl: e.target.value })} spellCheck={false} />
        <p className="field-hint">Requests go directly to this address. Use https:// unless the server runs on this computer.</p>
      </div>
      {preset.protocols.length > 1 && (
        <div className="field">
          <label className="field-label" htmlFor="c-proto">Protocol</label>
          <select id="c-proto" className="input" value={d.protocol} onChange={(e) => update({ protocol: e.target.value as Protocol })}>
            {preset.protocols.map((p) => (
              <option key={p} value={p}>
                {PROTOCOL_LABELS[p]}
              </option>
            ))}
          </select>
          <p className="field-hint">An API key does not say which wire format a server speaks. Pick the one your server documents; the connection test checks it.</p>
        </div>
      )}
      {preset.authStyle !== 'none' && (
        <div className="field">
          <label className="field-label" htmlFor="c-key">API key{preset.requiresKey ? '' : ' (if the server needs one)'}</label>
          <input id="c-key" className="input mono" type="password" autoComplete="off" spellCheck={false} value={d.key} placeholder={d.id ? 'Leave empty to keep the current key' : ''} onChange={(e) => update({ key: e.target.value })} />
          <div className="radio-row" role="radiogroup" aria-label="Key storage">
            <label className={cx(!ai.vault.persistent && 'is-disabled')}>
              <input type="radio" name="persist" checked={d.persistence === 'persistent'} disabled={!ai.vault.persistent} onChange={() => update({ persistence: 'persistent' })} /> Save securely
            </label>
            <label>
              <input type="radio" name="persist" checked={d.persistence === 'session'} onChange={() => update({ persistence: 'session' })} /> This session only
            </label>
          </div>
          <p className="field-hint">{ai.vault.detail} Keys are never shown again, written to projects or logs, or sent to models.</p>
        </div>
      )}
      {[...preset.media, ...(preset.mediaOptional ?? [])].length > 0 && (
        <fieldset className="field">
          <legend className="field-label">Media endpoints</legend>
          <p className="field-hint">Which media endpoints this connection offers. Generation and transcription jobs use them for the models you assign in Models; each job shows exactly what it will send before anything leaves your computer.</p>
          {[...preset.media, ...(preset.mediaOptional ?? [])].map((m) => (
            <label key={m} className="check-row">
              <input type="checkbox" checked={d.media.includes(m)} onChange={(e) => update({ media: e.target.checked ? [...d.media, m] : d.media.filter((x) => x !== m) })} /> {MEDIA_ADAPTER_INFO[m].label}
            </label>
          ))}
        </fieldset>
      )}
      <details className="ai-advanced">
        <summary>Advanced connection settings</summary>
        <div className="field">
          <label className="field-label" htmlFor="c-timeout">Request timeout (seconds)</label>
          <input id="c-timeout" className="input" type="number" min={1} max={600} value={d.timeout} onChange={(e) => update({ timeout: Math.max(1, Math.min(600, Number(e.target.value) || 120)) })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="c-headers">Extra headers (one per line, Name: value)</label>
          <textarea id="c-headers" className="input mono" rows={3} value={d.headers} onChange={(e) => update({ headers: e.target.value })} spellCheck={false} />
          <p className="field-hint">Not for credentials: put keys in the API key field so they are stored securely.</p>
        </div>
      </details>
      <div className="dialog-actions">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !d.baseUrl.trim()}>
          {busy ? 'Saving and testing…' : 'Save and test'}
        </Button>
      </div>
    </form>
  );
}

export function ProvidersTab() {
  const ai = useAi((s) => s.ai);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [other, setOther] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  useEffect(() => {
    void loadAiState();
  }, []);
  if (!ai) return <p className="muted">AI connections are not available in this environment.</p>;
  if (draft) return <ConnectionForm draft={draft} onDone={() => setDraft(null)} />;
  const test = async (id: string): Promise<void> => {
    setTesting(id);
    try {
      const r = await call('ai.connections.test', { connectionId: id });
      applyAiState(r.state);
    } catch (error) {
      toast({ tone: 'error', title: 'Test failed', body: errorMessage(error) });
    } finally {
      setTesting(null);
    }
  };
  const remove = async (c: ConnectionView): Promise<void> => {
    try {
      applyAiState(await call('ai.connections.delete', { connectionId: c.id }));
      toast({ tone: 'info', title: `${c.name} removed`, body: 'Its key was deleted. Tasks that used it keep their history.' });
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t remove it', body: errorMessage(error) });
    }
  };
  return (
    <div className="ai-settings">
      <p className={cx('vault-banner', ai.vault.persistent ? 'is-secure' : 'is-session')}>
        <Icon name={ai.vault.persistent ? 'check' : 'info'} size={14} /> {ai.vault.detail}
      </p>
      {ai.connections.length > 0 && (
        <ul className="conn-list">
          {ai.connections.map((c) => (
            <li key={c.id} className="conn-card">
              <div className="conn-main">
                <strong>{c.name}</strong>
                <span className="muted">
                  {presetFor(c.provider).label} · {PROTOCOL_LABELS[c.protocol]} · {c.local ? 'this computer' : new URL(c.baseUrl).host}
                </span>
                <span className="muted">
                  {keyText(c)} · {c.models.length} model{c.models.length === 1 ? '' : 's'}
                </span>
                {c.lastTest && (
                  <span className={cx('conn-test', c.lastTest.ok ? 'is-ok' : 'is-failed')}>
                    <Icon name={c.lastTest.ok ? 'check' : 'warning'} size={12} /> {c.lastTest.message}
                  </span>
                )}
              </div>
              <div className="conn-actions">
                <Button size="sm" onClick={() => void test(c.id)} disabled={testing === c.id}>
                  {testing === c.id ? 'Testing…' : 'Test'}
                </Button>
                <Button size="sm" onClick={() => setDraft(draftFor(c.provider, ai.vault.persistent, c))}>
                  Edit
                </Button>
                <Button size="sm" variant="danger" onClick={() => void remove(c)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <h3 className="ai-subhead">Add a provider</h3>
      <div className="preset-grid">
        {PROVIDER_PRESETS.map((p) => (
          <button key={p.provider} type="button" className="preset-card" onClick={() => setDraft(draftFor(p.provider, ai.vault.persistent))}>
            <strong>{p.label}</strong>
            <span>{p.local ? 'Runs on this computer' : PROTOCOL_LABELS[p.protocol]}</span>
          </button>
        ))}
        <button type="button" className="preset-card is-other" onClick={() => setOther((v) => !v)} aria-expanded={other}>
          <strong>Another API</strong>
          <span>Different wire format</span>
        </button>
      </div>
      {other && (
        <div className="ai-note-box">
          <p>
            Multiverse Studio talks to providers through protocol adapters: OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, Gemini and Ollama. If your service speaks one of these, add it as a compatible endpoint above and the connection test will confirm it.
          </p>
          <p>
            Otherwise it needs an adapter. Adapters implement the <code>ProviderAdapter</code> interface in <code>src/ai/types.ts</code> (list models and stream a request) and are registered in <code>src/ai/adapters/index.ts</code>. Nothing is reported as compatible until a real request succeeds.
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------------- Models and routing ---------------- */

function RouteRow({ job }: { job: Job }) {
  const ai = useAi((s) => s.ai)!;
  const current = ai.routing[job];
  const options = useMemo(
    () =>
      ai.connections.flatMap((c) =>
        c.models.map((m) => {
          const states = JOB_INFO[job].requires.map((cap) => m.capabilities[cap]?.state ?? 'unknown');
          return { c, m, blocked: states.includes('unavailable'), verified: states.every((s) => s === 'verified'), unknown: states.includes('unknown') };
        }),
      ),
    [ai, job],
  );
  const value = current ? `${current.connectionId}::${current.modelId}` : '';
  const chosen = options.find((o) => `${o.c.id}::${o.m.id}` === value);
  return (
    <div className="route-row">
      <div>
        <strong>{JOB_INFO[job].label}</strong>
        <p className="field-hint">
          {JOB_INFO[job].description} Needs: {JOB_INFO[job].requires.map((c) => CAPABILITY_LABELS[c].toLowerCase()).join(', ')}.
        </p>
      </div>
      <div>
        <select
          className="input"
          aria-label={`Model for ${JOB_INFO[job].label}`}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            const [connectionId, ...rest] = v.split('::');
            void call('ai.routing.set', { job, assignment: v ? { connectionId: connectionId!, modelId: rest.join('::') } : null })
              .then(applyAiState)
              .catch((error) => toast({ tone: 'error', title: 'That model can’t do this job', body: errorMessage(error) }));
          }}
        >
          <option value="">Not assigned</option>
          {options.map((o) => (
            <option key={`${o.c.id}::${o.m.id}`} value={`${o.c.id}::${o.m.id}`} disabled={o.blocked}>
              {o.m.label} — {o.c.name}
              {o.blocked ? ' (unavailable)' : o.verified ? ' (verified)' : o.unknown ? ' (unverified)' : ' (declared)'}
            </option>
          ))}
        </select>
        {chosen && chosen.unknown && <p className="field-hint">Not verified yet. Use Verify on the model below, or just use it: a successful request verifies what it exercised.</p>}
        {!current && options.every((o) => o.blocked) && options.length > 0 && <p className="field-hint">None of your models is known to support this. Connect a provider that offers it.</p>}
      </div>
    </div>
  );
}

function ModelRow({ c, m }: { c: ConnectionView; m: ModelRecord }) {
  const [busy, setBusy] = useState<string | null>(null);
  const verify = async (capability: 'text' | 'code' | 'tools'): Promise<void> => {
    setBusy(capability);
    try {
      const r = await call('ai.models.verify', { connectionId: c.id, modelId: m.id, capability });
      applyAiState(r.state);
      toast({ tone: r.record.state === 'verified' ? 'success' : 'warning', title: `${CAPABILITY_LABELS[capability]}: ${STATE_TEXT[r.record.state]}`, body: r.record.detail });
    } catch (error) {
      toast({ tone: 'error', title: 'Verification didn’t run', body: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };
  const setCap = (capability: Capability, state: 'declared' | 'unavailable' | 'unknown'): void => {
    void call('ai.models.setCapability', { connectionId: c.id, modelId: m.id, capability, state }).then(applyAiState);
  };
  const [inPrice, setIn] = useState(m.pricing?.inputPerMTok?.toString() ?? '');
  const [outPrice, setOut] = useState(m.pricing?.outputPerMTok?.toString() ?? '');
  return (
    <details className="model-row">
      <summary>
        <span className="model-name">{m.label}</span>
        <span className="model-caps">
          {(['text', 'code', 'vision', 'tools'] as Capability[]).map((cap) => (
            <CapChip key={cap} cap={cap} model={m} />
          ))}
        </span>
      </summary>
      <p className="muted mono">{m.id}</p>
      <table className="cap-table">
        <tbody>
          {CAPABILITIES.map((cap) => {
            const rec = m.capabilities[cap];
            return (
              <tr key={cap}>
                <th scope="row">{CAPABILITY_LABELS[cap]}</th>
                <td>
                  <CapChip cap={cap} model={m} />
                </td>
                <td className="muted">{rec?.detail ?? ''}</td>
                <td>
                  {rec?.state !== 'verified' && (
                    <select className="input input-sm" aria-label={`Set ${CAPABILITY_LABELS[cap]}`} value={rec?.source === 'user' ? rec.state : ''} onChange={(e) => setCap(cap, (e.target.value || 'unknown') as 'declared' | 'unavailable' | 'unknown')}>
                      <option value="">{rec && rec.source !== 'user' ? 'From provider' : 'Not set'}</option>
                      <option value="declared">Supported (my declaration)</option>
                      <option value="unavailable">Not supported</option>
                    </select>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="model-actions">
        {(['text', 'code', 'tools'] as const).map((cap) => (
          <Button key={cap} size="sm" onClick={() => void verify(cap)} disabled={busy !== null}>
            {busy === cap ? 'Verifying…' : `Verify ${CAPABILITY_LABELS[cap].toLowerCase()}`}
          </Button>
        ))}
        <span className="field-hint">Each check sends one tiny request to {c.local ? 'your local server' : c.name}{c.local ? '' : ' and may cost a fraction of a cent'}.</span>
      </div>
      <form
        className="price-row"
        onSubmit={(e) => {
          e.preventDefault();
          const parse = (v: string): number | null => (v.trim() === '' ? null : Math.max(0, Number(v)));
          void call('ai.models.setPricing', { connectionId: c.id, modelId: m.id, inputPerMTok: parse(inPrice), outputPerMTok: parse(outPrice) }).then(applyAiState);
        }}
      >
        <label>
          Input $/M tokens <input className="input input-sm" inputMode="decimal" value={inPrice} onChange={(e) => setIn(e.target.value)} />
        </label>
        <label>
          Output $/M tokens <input className="input input-sm" inputMode="decimal" value={outPrice} onChange={(e) => setOut(e.target.value)} />
        </label>
        <Button size="sm" type="submit">
          Save prices
        </Button>
        <span className="field-hint">{m.pricing ? (m.pricing.source === 'provider' ? 'Prices reported by the provider.' : 'Prices you entered.') : 'Unknown prices: costs show as “Unknown”.'}</span>
      </form>
      <Button size="sm" variant="quiet" onClick={() => void call('ai.models.remove', { connectionId: c.id, modelId: m.id }).then(applyAiState)}>
        Remove model
      </Button>
    </details>
  );
}

export function ModelsTab() {
  const ai = useAi((s) => s.ai);
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState({ connectionId: '', modelId: '' });
  if (!ai) return null;
  if (ai.connections.length === 0) return <p className="muted">Connect a provider first. Its models appear here.</p>;
  const q = filter.trim().toLowerCase();
  return (
    <div className="ai-settings">
      <h3 className="ai-subhead">Which model does each job</h3>
      {JOBS.map((job) => (
        <RouteRow key={job} job={job} />
      ))}
      <h3 className="ai-subhead">Models</h3>
      <input className="input" placeholder="Filter models" aria-label="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {ai.connections.map((c) => {
        const models = c.models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
        return (
          <section key={c.id} className="model-group">
            <h4>
              {c.name} <span className="muted">({c.models.length})</span>
            </h4>
            {models.slice(0, 80).map((m) => (
              <ModelRow key={m.id} c={c} m={m} />
            ))}
            {models.length > 80 && <p className="field-hint">{models.length - 80} more. Use the filter to find a model.</p>}
            {c.models.length === 0 && <p className="field-hint">No models listed. Test the connection, or add a model id below.</p>}
          </section>
        );
      })}
      <form
        className="manual-model"
        onSubmit={(e) => {
          e.preventDefault();
          if (!manual.connectionId || !manual.modelId.trim()) return;
          void call('ai.models.add', { connectionId: manual.connectionId, modelId: manual.modelId })
            .then((s) => {
              applyAiState(s);
              setManual((m) => ({ ...m, modelId: '' }));
            })
            .catch((error) => toast({ tone: 'error', title: 'Couldn’t add the model', body: errorMessage(error) }));
        }}
      >
        <h3 className="ai-subhead">Add a model by id</h3>
        <select className="input" aria-label="Connection" value={manual.connectionId} onChange={(e) => setManual((m) => ({ ...m, connectionId: e.target.value }))}>
          <option value="">Choose a connection</option>
          {ai.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input className="input mono" aria-label="Model id" placeholder="Model id exactly as the provider documents it" value={manual.modelId} onChange={(e) => setManual((m) => ({ ...m, modelId: e.target.value }))} />
        <Button type="submit" disabled={!manual.connectionId || !manual.modelId.trim()}>
          Add model
        </Button>
      </form>
    </div>
  );
}

/* ---------------- Usage and budgets ---------------- */

export function UsageTab() {
  const ai = useAi((s) => s.ai);
  const tasks = useAi((s) => s.tasks);
  const [b, setB] = useState(ai?.budgets ?? { perTaskUsd: null, maxToolIterations: 24, maxMinutes: 20 });
  if (!ai) return null;
  const cached = tasks.reduce((n, t) => n + (t.usage.cachedInputTokens ?? 0), 0);
  const saved = tasks.reduce((n, t) => n + (t.usage.savedTokensEstimate ?? 0), 0);
  const totals = tasks.reduce(
    (acc, t) => ({
      requests: acc.requests + t.usage.requests,
      inputTokens: t.usage.inputTokens === null ? acc.inputTokens : (acc.inputTokens ?? 0) + t.usage.inputTokens,
      outputTokens: t.usage.outputTokens === null ? acc.outputTokens : (acc.outputTokens ?? 0) + t.usage.outputTokens,
      estimatedCostUsd: t.usage.estimatedCostUsd === null ? acc.estimatedCostUsd : (acc.estimatedCostUsd ?? 0) + t.usage.estimatedCostUsd,
      partial: acc.partial || t.usage.partial || (t.usage.requests > 0 && t.usage.estimatedCostUsd === null),
    }),
    { requests: 0, inputTokens: null as number | null, outputTokens: null as number | null, estimatedCostUsd: null as number | null, partial: false },
  );
  return (
    <div className="ai-settings">
      <h3 className="ai-subhead">Limits for each task</h3>
      <form
        className="budget-form"
        onSubmit={(e) => {
          e.preventDefault();
          void call('ai.budgets.set', b)
            .then((s) => {
              applyAiState(s);
              toast({ tone: 'success', title: 'Limits saved' });
            })
            .catch((error) => toast({ tone: 'error', title: 'Couldn’t save', body: errorMessage(error) }));
        }}
      >
        <label className="field">
          <span className="field-label">Budget per task (USD, estimated)</span>
          <input className="input" inputMode="decimal" placeholder="No budget" value={b.perTaskUsd ?? ''} onChange={(e) => setB({ ...b, perTaskUsd: e.target.value.trim() === '' ? null : Math.max(0, Number(e.target.value)) })} />
          <span className="field-hint">Only enforced when the model’s prices are known. With unknown prices the other limits still apply.</span>
        </label>
        <label className="field">
          <span className="field-label">Most rounds of actions per task</span>
          <input className="input" type="number" min={1} max={200} value={b.maxToolIterations} onChange={(e) => setB({ ...b, maxToolIterations: Math.max(1, Math.min(200, Number(e.target.value) || 1)) })} />
        </label>
        <label className="field">
          <span className="field-label">Longest running time per task (minutes)</span>
          <input className="input" type="number" min={1} max={240} value={b.maxMinutes} onChange={(e) => setB({ ...b, maxMinutes: Math.max(1, Math.min(240, Number(e.target.value) || 1)) })} />
        </label>
        <div className="dialog-actions">
          <Button type="submit" variant="primary">
            Save limits
          </Button>
        </div>
      </form>
      <TokenSaverForm />
      <h3 className="ai-subhead">This project</h3>
      <p>
        {totals.requests} request{totals.requests === 1 ? '' : 's'} · {totals.inputTokens?.toLocaleString() ?? 'unknown'} input tokens{cached ? ` (${cached.toLocaleString()} read from the provider’s cache)` : ''} · {totals.outputTokens?.toLocaleString() ?? 'unknown'} output tokens
      </p>
      {saved > 0 && <p>About {saved.toLocaleString()} input tokens kept out of requests by compaction (estimated at four characters per token).</p>}
      <p>{costText(totals)}</p>
      <p className="field-hint">Estimates use prices reported by the provider (OpenRouter, local servers) or entered by you, and don’t include cache discounts. Your provider’s bill is the authority.</p>
    </div>
  );
}

const DEFAULT_SAVER = { replies: 'brief' as const, compactOutputs: true, compactHistory: true, promptCaching: true };
let saverRequest = 0;

function TokenSaverForm() {
  const saved = useAi((s) => s.ai?.tokenSaver) ?? DEFAULT_SAVER;
  // Shown at once while saving; the saved settings take over when the latest save returns.
  const [pending, setPending] = useState<typeof saved | null>(null);
  const t = pending ?? saved;
  const save = (next: typeof t): void => {
    const mine = ++saverRequest;
    setPending(next);
    void call('ai.tokenSaver.set', next)
      .then((s) => {
        applyAiState(s);
        if (mine === saverRequest) setPending(null);
      })
      .catch((error) => {
        if (mine === saverRequest) setPending(null);
        toast({ tone: 'error', title: 'Couldn’t save', body: errorMessage(error) });
      });
  };
  return (
    <section className="token-saver" aria-labelledby="token-saver-title">
      <h3 className="ai-subhead" id="token-saver-title">
        Token saver
      </h3>
      <p className="field-hint">Uses fewer tokens without changing what tasks can do. Replies stay in plain English; your own messages are never rewritten.</p>
      <div className="field">
        <span className="field-label">Replies</span>
        <SegmentedControl
          size="sm"
          label="Replies"
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'brief', label: 'Brief' },
            { value: 'minimal', label: 'Minimal' },
          ]}
          value={t.replies}
          onChange={(replies) => save({ ...t, replies })}
        />
        <span className="field-hint">
          {t.replies === 'standard' ? 'As detailed as the model chooses.' : t.replies === 'brief' ? 'Answer first: no preamble, recap or filler. Risks and failures are still explained in full.' : 'Results only, at most five lines unless you ask for more.'}
        </span>
      </div>
      <Toggle checked={t.compactOutputs} onChange={(compactOutputs) => save({ ...t, compactOutputs })} label="Shorten noisy tool results" description="Logs and test output keep their errors, failures and warnings; passing tests, repeats and deep stack frames are counted instead. The full text is kept and the model can read it again." />
      <Toggle checked={t.compactHistory} onChange={(compactHistory) => save({ ...t, compactHistory })} label="Shorten older results in long tasks" description="Done in batches, so the provider’s prompt cache keeps working in between. The latest two rounds always stay in full." />
      <Toggle checked={t.promptCaching} onChange={(promptCaching) => save({ ...t, promptCaching })} label="Prompt caching" description="Anthropic and OpenAI reuse the unchanged start of each request at a lower price. Cached tokens are shown with each task." />
    </section>
  );
}
