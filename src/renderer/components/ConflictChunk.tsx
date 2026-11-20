import { useEffect, useState } from 'react';
import { Button } from './primitives';
import { Icon } from './Icon';
import { cx } from '../lib/util';
import type { ChunkResolution, ConflictChunkView } from '../../shared/types';

/** Strip indentation shared by every line so short snippets are easy to read (display only). */
function dedent(text: string): string {
  const lines = text.split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return cut ? lines.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length))).join('\n') : text;
}

function resolvedText(chunk: Extract<ConflictChunkView, { kind: 'conflict' }>, r: ChunkResolution | null): string | null {
  if (!r) return null;
  const nl = (s: string): string => (s.length === 0 || s.endsWith('\n') ? s : `${s}\n`);
  switch (r.choice) {
    case 'ours':
      return chunk.ours;
    case 'theirs':
      return chunk.theirs;
    case 'ours-then-theirs':
      return nl(chunk.ours) + chunk.theirs;
    case 'theirs-then-ours':
      return nl(chunk.theirs) + chunk.ours;
    case 'custom':
      return r.text ?? '';
  }
}

/**
 * One conflicting region shown as a spacious comparison: both versions side by side,
 * clear choices, and an editable result. Nothing is decided automatically.
 */
export function ConflictChunk({
  chunk,
  oursLabel,
  theirsLabel,
  onResolve,
  number,
}: {
  chunk: Extract<ConflictChunkView, { kind: 'conflict' }>;
  oursLabel: string;
  theirsLabel: string;
  onResolve: (resolution: ChunkResolution) => void;
  number: number;
}) {
  const current = resolvedText(chunk, chunk.resolution);
  const [custom, setCustom] = useState(current ?? chunk.ours);
  const [editing, setEditing] = useState(chunk.resolution?.choice === 'custom');
  useEffect(() => {
    if (chunk.resolution?.choice !== 'custom') setCustom(current ?? chunk.ours);
  }, [chunk.resolution?.choice]);
  const choice = chunk.resolution?.choice ?? null;
  const pick = (c: ChunkResolution['choice']): void => {
    setEditing(false);
    onResolve({ choice: c });
  };
  return (
    <section className={cx('conflict-chunk', choice && 'is-resolved')} aria-label={`Conflict ${number}`}>
      <header className="conflict-chunk-head">
        <span className="conflict-number">
          <Icon name={choice ? 'check' : 'conflict'} size={14} /> Conflict {number}
        </span>
        <span className="muted small">{choice ? 'Decided' : 'Choose which wording to keep, or write your own'}</span>
      </header>
      <div className="conflict-sides">
        <div className={cx('conflict-side', 'side-ours', (choice === 'ours' || choice === 'ours-then-theirs' || choice === 'theirs-then-ours') && 'is-chosen')}>
          <div className="side-label">
            <span className="side-tag">Keep</span> {oursLabel}
          </div>
          <pre className="code-block">{chunk.ours ? dedent(chunk.ours) : '(removed)'}</pre>
          <Button size="sm" variant={choice === 'ours' ? 'primary' : 'secondary'} onClick={() => pick('ours')}>
            Use {oursLabel}’s version
          </Button>
        </div>
        <div className={cx('conflict-side', 'side-theirs', (choice === 'theirs' || choice === 'ours-then-theirs' || choice === 'theirs-then-ours') && 'is-chosen')}>
          <div className="side-label">
            <span className="side-tag">Incoming</span> {theirsLabel}
          </div>
          <pre className="code-block">{chunk.theirs ? dedent(chunk.theirs) : '(removed)'}</pre>
          <Button size="sm" variant={choice === 'theirs' ? 'primary' : 'secondary'} onClick={() => pick('theirs')}>
            Use {theirsLabel}’s version
          </Button>
        </div>
      </div>
      <div className="conflict-more">
        <Button size="sm" variant={choice === 'ours-then-theirs' ? 'primary' : 'quiet'} onClick={() => pick('ours-then-theirs')}>
          Keep both ({oursLabel} first)
        </Button>
        <Button size="sm" variant={choice === 'theirs-then-ours' ? 'primary' : 'quiet'} onClick={() => pick('theirs-then-ours')}>
          Keep both ({theirsLabel} first)
        </Button>
        <Button size="sm" variant={editing || choice === 'custom' ? 'primary' : 'quiet'} icon="pencil" onClick={() => setEditing(true)}>
          Write a combined result
        </Button>
        {chunk.base && (
          <details className="conflict-base">
            <summary>Show the original before either change</summary>
            <pre className="code-block">{dedent(chunk.base)}</pre>
          </details>
        )}
      </div>
      {editing && (
        <div className="conflict-custom">
          <label className="field-label" htmlFor={`custom-${number}`}>
            Combined result
          </label>
          <textarea id={`custom-${number}`} className="input textarea code-textarea" rows={Math.min(14, Math.max(3, custom.split('\n').length + 1))} value={custom} onChange={(e) => setCustom(e.target.value)} spellCheck={false} />
          <div className="inline-actions">
            <Button size="sm" variant="primary" onClick={() => onResolve({ choice: 'custom', text: custom })}>
              Use this result
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {current !== null && !editing && (
        <div className="conflict-result">
          <div className="side-label">
            <Icon name="check" size={13} /> Result
          </div>
          <pre className="code-block">{current ? dedent(current) : '(empty)'}</pre>
        </div>
      )}
    </section>
  );
}
