/**
 * AI timeline edits. Quick edits run locally (pause detection, captions from a saved transcript,
 * music ducking, trimming, a portrait copy). Free-form requests go to the configured model with a
 * text description of the timeline — never media files. Every edit is a proposal first; applying
 * saves a checkpoint and makes one undoable step, and the result is ordinary, editable clips.
 */
import { useState } from 'react';
import { useStudio, set as setStudio, toast } from '../../state/store';
import { useVideo, loadVideo, getVideo } from '../../state/video';
import { useAi } from '../../state/ai';
import { call, errorMessage } from '../../lib/api';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/primitives';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/util';
import type { TimelineOp, TimelineProposalView } from '../../../shared/media';

const VARIANTS = ['Version A: favour pace — keep it tight and energetic.', 'Version B: favour clarity — keep breathing room and the strongest lines.'];

function routeLabel(): string | null {
  const ai = useAi.getState().ai;
  const r = ai?.routing.coding ?? ai?.routing.assistant;
  if (!ai || !r) return null;
  const c = ai.connections.find((x) => x.id === r.connectionId);
  const m = c?.models.find((x) => x.id === r.modelId);
  return c && m ? `${m.label} on ${c.name}${c.local ? ' (this computer)' : ''}` : null;
}

function Proposal({ p, onApply, onDiscard, busy, single }: { p: TimelineProposalView; onApply: (asAlternative: string | null) => void; onDiscard: () => void; busy: boolean; single: boolean }) {
  const [altName, setAltName] = useState(p.newSequences.length ? 'Portrait cut' : 'AI cut');
  const [asAlt, setAsAlt] = useState(!single);
  const empty = p.steps.length === 0;
  return (
    <section className="proposal" aria-label="Proposed edit">
      <h3 className="proposal-title">{p.summary}</h3>
      <p className="proposal-delta">
        <span>
          {p.before.seconds.toFixed(1)} s · {p.before.clips} clips
        </span>
        <Icon name="arrowRight" size={13} />
        <span>
          {p.after.seconds.toFixed(1)} s · {p.after.clips} clips
        </span>
        {p.newSequences.map((n) => (
          <span key={n} className="chip">
            New sequence: {n}
          </span>
        ))}
      </p>
      {p.steps.length > 0 && (
        <ol className="proposal-steps">
          {p.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {p.warnings.map((w) => (
        <p key={w} className="proposal-warning">
          <Icon name="warning" size={13} /> {w}
        </p>
      ))}
      {p.sent.length > 0 && (
        <p className="muted small">
          Sent: {p.sent.join(' ')}
          {p.usage && ` Tokens: ${p.usage.inputTokens ?? 'unknown'} in, ${p.usage.outputTokens ?? 'unknown'} out.`}
        </p>
      )}
      {empty && (
        <div className="proposal-actions">
          <Button size="sm" onClick={onDiscard}>
            Back
          </Button>
        </div>
      )}
      {!empty && (
        <div className="proposal-actions">
          <label className="check-row">
            <input type="checkbox" checked={asAlt} onChange={(e) => setAsAlt(e.target.checked)} />
            <span>As a new alternative</span>
          </label>
          {asAlt && <input className="input proposal-name" aria-label="Alternative name" value={altName} onChange={(e) => setAltName(e.target.value)} maxLength={80} />}
          <span className="bar-spacer" />
          <Button size="sm" variant="quiet" onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" variant="primary" icon="check" disabled={busy || (asAlt && !altName.trim())} onClick={() => onApply(asAlt ? altName.trim() : null)}>
            Apply
          </Button>
        </div>
      )}
    </section>
  );
}

export function AiEditDialog({ onClose }: { onClose: () => void }) {
  const projectId = useStudio((s) => s.project!.id);
  const lineId = useStudio((s) => s.selectedLineId);
  const seq = useVideo((s) => s.sequence)!;
  const [instruction, setInstruction] = useState('');
  const [twoWays, setTwoWays] = useState(false);
  const [minPause, setMinPause] = useState(0.7);
  const [target, setTarget] = useState(30);
  const audioTracks = seq.tracks.filter((t) => t.kind === 'audio');
  const [music, setMusic] = useState(audioTracks.at(-1)?.id ?? '');
  const [proposals, setProposals] = useState<TimelineProposalView[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = routeLabel();

  const analyze = async (op: TimelineOp, options: Record<string, string | number | boolean> = {}): Promise<void> => {
    setWorking(op);
    setError(null);
    try {
      setProposals([await call('video.ai.analyze', { projectId, lineId, sequenceId: seq.id, op, options })]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  };
  const ask = async (): Promise<void> => {
    if (!instruction.trim()) return;
    setWorking('ai');
    setError(null);
    try {
      const prompts = twoWays ? VARIANTS.map((v) => `${instruction.trim()}\n\n${v}`) : [instruction.trim()];
      const out: TimelineProposalView[] = [];
      // One after another: each proposal is validated against the same starting timeline.
      for (const p of prompts) out.push(await call('video.ai.plan', { projectId, lineId, sequenceId: seq.id, instruction: p }));
      setProposals(out);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  };
  const apply = async (p: TimelineProposalView, asAlternative: string | null): Promise<void> => {
    setWorking('apply');
    try {
      const r = await call('video.ai.apply', { projectId, proposalId: p.id, ...(asAlternative ? { asAlternative: { name: asAlternative } } : {}) });
      toast({ tone: 'success', title: asAlternative ? `Created “${asAlternative}”` : `Applied: ${r.label}`, body: asAlternative ? 'The edit is in the new alternative; this version is unchanged.' : 'A checkpoint was saved first. Undo (Ctrl+Z) reverts the whole edit.' });
      const rest = proposals.filter((x) => x.id !== p.id);
      if (asAlternative && rest.length) {
        // The other variant stays open to be applied as its own alternative.
        setProposals(rest);
        return;
      }
      for (const x of rest) void call('video.ai.discard', { projectId, proposalId: x.id });
      if (asAlternative) setStudio({ selectedLineId: r.lineId });
      else await loadVideo(projectId, getVideo().lineId ?? lineId);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  };
  const discard = (p: TimelineProposalView): void => {
    void call('video.ai.discard', { projectId, proposalId: p.id });
    setProposals((list) => list.filter((x) => x.id !== p.id));
  };
  const close = (): void => {
    for (const p of proposals) void call('video.ai.discard', { projectId, proposalId: p.id });
    if (working === 'ai') void call('video.ai.cancel', { projectId });
    onClose();
  };

  return (
    <Dialog title={`Edit “${seq.name}” with AI`} description="Edits are proposed first. Nothing changes until you apply one." size="lg" onClose={close} className="ai-edit-dialog">
      {proposals.length === 0 ? (
        <div className="ai-edit">
          <section className="ai-quick" aria-label="Quick edits">
            <h3 className="panel-subhead">Quick edits · on this computer</h3>
            <div className="quick-grid">
              <div className="quick-card">
                <strong>Remove long pauses</strong>
                <span className="muted small">Finds silence in the sound and cuts it out of that track.</span>
                <label className="quick-inline">
                  Longer than
                  <input className="input num-input" type="number" min={0.3} max={10} step={0.1} aria-label="Minimum pause in seconds" value={minPause} onChange={(e) => setMinPause(Number(e.target.value))} /> s
                </label>
                <Button size="sm" disabled={Boolean(working)} onClick={() => void analyze('remove-pauses', { minPause })}>
                  {working === 'remove-pauses' ? 'Listening…' : 'Find pauses'}
                </Button>
              </div>
              <div className="quick-card">
                <strong>Captions from transcript</strong>
                <span className="muted small">Uses saved transcripts of the clips’ media. Transcribe a clip from its inspector first.</span>
                <Button size="sm" disabled={Boolean(working)} onClick={() => void analyze('captions')}>
                  Add captions
                </Button>
              </div>
              <div className="quick-card">
                <strong>Lower music during speech</strong>
                <span className="muted small">Uses transcript timings, or detects speech from the sound.</span>
                <select className="input" aria-label="Music track" value={music} onChange={(e) => setMusic(e.target.value)} disabled={!audioTracks.length}>
                  {audioTracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <Button size="sm" disabled={Boolean(working) || !music} onClick={() => void analyze('duck', { musicTrackId: music, level: 0.3 })}>
                  Lower to 30%
                </Button>
              </div>
              <div className="quick-card">
                <strong>Trim to length</strong>
                <span className="muted small">Ends the edit at this length; earlier clips are untouched.</span>
                <label className="quick-inline">
                  <input className="input num-input" type="number" min={1} max={3600} aria-label="Target length in seconds" value={target} onChange={(e) => setTarget(Number(e.target.value))} /> s
                </label>
                <Button size="sm" disabled={Boolean(working)} onClick={() => void analyze('trim', { seconds: target })}>
                  Trim
                </Button>
              </div>
              <div className="quick-card">
                <strong>Portrait version</strong>
                <span className="muted small">A 1080×1920 copy with pictures scaled to fill the frame.</span>
                <Button size="sm" disabled={Boolean(working)} onClick={() => void analyze('portrait')}>
                  Make portrait copy
                </Button>
              </div>
            </div>
          </section>
          <section className="ai-ask" aria-label="Ask for an edit">
            <h3 className="panel-subhead">Describe an edit</h3>
            <textarea className="input textarea" rows={3} aria-label="Edit instruction" placeholder="Put the product name over the opening shot and keep the cut under 30 seconds" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            <label className="check-row">
              <input type="checkbox" checked={twoWays} onChange={(e) => setTwoWays(e.target.checked)} />
              <span>Propose two different versions (each can become its own alternative)</span>
            </label>
            <p className="muted small">
              {route ? (
                <>
                  Sends {twoWays ? <strong>2 requests</strong> : 'one request'} to {route}: a text description of this timeline (clip names, times, titles and any transcript text) and your request. No media files. Cost: Unknown.
                </>
              ) : (
                'No model is assigned to the coding agent or the assistant yet. Assign one in Settings → Models.'
              )}
            </p>
            <div className="gen-actions">
              <Button variant="primary" icon="wand" disabled={!instruction.trim() || Boolean(working) || !route} onClick={() => void ask()}>
                {working === 'ai' ? 'Planning…' : 'Propose edit'}
              </Button>
            </div>
          </section>
        </div>
      ) : (
        <div className={cx('proposals', proposals.length > 1 && 'is-pair')}>
          {proposals.map((p) => (
            <Proposal key={p.id} p={p} single={proposals.length === 1} busy={working === 'apply'} onApply={(alt) => void apply(p, alt)} onDiscard={() => discard(p)} />
          ))}
        </div>
      )}
      {error && (
        <p className="info-banner" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
