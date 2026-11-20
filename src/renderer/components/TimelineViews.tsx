/**
 * Viewers for timelines across versions: decisions for a timeline merge (per clip, track or
 * setting, never lines of JSON), and a side-by-side diff of two cuts drawn on a common time scale.
 */
import { cx } from '../lib/util';
import { Icon } from './Icon';
import type { SequenceDiffView, TimelineConflictItemView } from '../../shared/media';

type Choice = 'ours' | 'theirs' | 'both';

const KIND: Record<TimelineConflictItemView['kind'], string> = {
  settings: 'Setting',
  track: 'Track',
  'track-delete': 'Track',
  clip: 'Clip',
  'clip-delete': 'Clip',
  overlap: 'Overlap',
};

export function TimelineDecisions({
  items,
  taken,
  oursLabel,
  theirsLabel,
  onChoose,
}: {
  items: (TimelineConflictItemView & { choice: Choice | null })[];
  taken: string[];
  oursLabel: string;
  theirsLabel: string;
  onChoose: (key: string, choice: Choice) => void;
}) {
  return (
    <div className="tl-decisions">
      <p className="muted small">Timelines are merged by clips and tracks. These need a decision; until then, {oursLabel}’s side is kept.</p>
      <ol className="tl-items">
        {items.map((it, i) => (
          <li key={it.key} className={cx('tl-item', it.choice && 'is-decided')}>
            <div className="tl-item-head">
              <span className="tl-kind">{KIND[it.kind]}</span>
              <strong>{it.label}</strong>
              {it.range && (
                <span className="muted small">
                  {it.range[0].toFixed(1)}–{it.range[1].toFixed(1)} s
                </span>
              )}
              <span className="bar-spacer" />
              <span className="muted small">{i + 1}/{items.length}</span>
            </div>
            <div className="tl-choices" role="radiogroup" aria-label={`Decision for ${it.label}`}>
              <button type="button" role="radio" aria-checked={it.choice === 'ours'} className={cx('choice-card', it.choice === 'ours' && 'is-chosen')} onClick={() => onChoose(it.key, 'ours')}>
                <strong>Keep {oursLabel}</strong>
                <span className="muted small">{it.ours}</span>
              </button>
              <button type="button" role="radio" aria-checked={it.choice === 'theirs'} className={cx('choice-card', it.choice === 'theirs' && 'is-chosen')} onClick={() => onChoose(it.key, 'theirs')}>
                <strong>Use {theirsLabel}</strong>
                <span className="muted small">{it.theirs}</span>
              </button>
              {it.allowBoth && (
                <button type="button" role="radio" aria-checked={it.choice === 'both'} className={cx('choice-card', it.choice === 'both' && 'is-chosen')} onClick={() => onChoose(it.key, 'both')}>
                  <strong>Keep both</strong>
                  <span className="muted small">{theirsLabel}’s clip goes on a new track at the same time</span>
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {taken.length > 0 && (
        <details className="tl-taken">
          <summary className="muted small">
            {taken.length} change{taken.length === 1 ? '' : 's'} from {theirsLabel} merged without a decision
          </summary>
          <ul>
            {taken.map((t, i) => (
              <li key={i} className="small">
                {t}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const STATUS: Record<SequenceDiffView['clips'][number]['status'], string> = { added: 'Added', deleted: 'Removed', moved: 'Moved', trimmed: 'Trimmed', changed: 'Changed' };

export function SequenceDiff({ diff, leftLabel, rightLabel }: { diff: SequenceDiffView; leftLabel: string; rightLabel: string }) {
  const span = Math.max(1, diff.duration[0], diff.duration[1]);
  const pct = (s: number): string => `${(s / span) * 100}%`;
  const changedTracks = diff.tracks.filter((t) => t.status !== 'same');
  return (
    <div className="seq-diff" aria-label="Timeline differences">
      <div className="seq-diff-summary">
        <div>
          <span className="muted small">{leftLabel}</span>
          <strong>
            {diff.name[0]} · {diff.duration[0].toFixed(1)} s
          </strong>
        </div>
        <Icon name="arrowRight" size={14} />
        <div>
          <span className="muted small">{rightLabel}</span>
          <strong>
            {diff.name[1]} · {diff.duration[1].toFixed(1)} s
          </strong>
        </div>
      </div>
      {diff.settings.length > 0 && (
        <ul className="seq-diff-settings">
          {diff.settings.map((s) => (
            <li key={s.field}>
              <span className="muted small">{s.field}</span> {s.left} → {s.right}
            </li>
          ))}
        </ul>
      )}
      {changedTracks.length > 0 && (
        <p className="small">
          Tracks:{' '}
          {changedTracks.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ', '}
              {t.name} ({t.status})
            </span>
          ))}
        </p>
      )}
      {diff.clips.length === 0 ? (
        <p className="muted small">No clip differences.</p>
      ) : (
        <ul className="seq-diff-clips">
          {diff.clips.map((c) => (
            <li key={c.id} className={cx('seq-diff-clip', `is-${c.status}`)}>
              <span className="seq-diff-label">
                <span className="tl-kind">{STATUS[c.status]}</span> {c.label} <span className="muted small">· {c.trackName}</span>
              </span>
              <span className="seq-diff-lane" aria-hidden="true">
                {c.left && <span className="seq-bar is-left" style={{ left: pct(c.left[0]), width: pct(c.left[1] - c.left[0]) }} />}
                {c.right && <span className="seq-bar is-right" style={{ left: pct(c.right[0]), width: pct(c.right[1] - c.right[0]) }} />}
              </span>
              <span className="muted small seq-diff-times">
                {c.left ? `${c.left[0].toFixed(1)}–${c.left[1].toFixed(1)} s` : '—'} → {c.right ? `${c.right[0].toFixed(1)}–${c.right[1].toFixed(1)} s` : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small seq-diff-legend">
        <span className="seq-bar is-left legend" /> {leftLabel} <span className="seq-bar is-right legend" /> {rightLabel}
      </p>
    </div>
  );
}
