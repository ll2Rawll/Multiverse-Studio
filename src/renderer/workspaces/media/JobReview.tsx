/**
 * What a media job will send, shown before anything leaves the computer: the connection and model,
 * each item that is uploaded with its size, and the cost — "Unknown" unless the provider gives a
 * price this app can read. Nothing is estimated or invented.
 */
import { useEffect, useState } from 'react';
import { planJob, type JobInput } from '../../state/media';
import { openDialog } from '../../state/store';
import { Button } from '../../components/primitives';
import { Icon } from '../../components/Icon';
import { bytes } from '../../lib/util';
import type { MediaJobPlan } from '../../../shared/media';

export function usePlan(projectId: string, job: JobInput | null): { plan: MediaJobPlan | null; problem: string | null; loading: boolean } {
  const [state, setState] = useState<{ plan: MediaJobPlan | null; problem: string | null; loading: boolean }>({ plan: null, problem: null, loading: false });
  const key = job ? JSON.stringify(job) : '';
  useEffect(() => {
    if (!job) return setState({ plan: null, problem: null, loading: false });
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    void planJob(projectId, job).then((r) => live && setState(typeof r === 'string' ? { plan: null, problem: r, loading: false } : { plan: r, problem: null, loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);
  return state;
}

export function JobReview({ plan, problem, loading }: { plan: MediaJobPlan | null; problem: string | null; loading: boolean }) {
  if (loading && !plan) return <p className="muted small">Checking the configuration…</p>;
  if (problem)
    return (
      <div className="review-problem" role="alert">
        <Icon name="warning" size={15} />
        <div>
          <p>{problem}</p>
          <Button size="sm" variant="quiet" icon="settings" onClick={() => openDialog({ kind: 'settings', tab: 'models' })}>
            Open AI settings
          </Button>
        </div>
      </div>
    );
  if (!plan) return null;
  return (
    <div className="job-review" aria-label="What will be sent">
      <dl className="review-facts">
        <div>
          <dt>Where</dt>
          <dd>
            {plan.connectionName}
            {plan.local ? ' · on this computer' : ''}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="mono-ish">{plan.model}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{plan.estimatedUsd === null ? 'Unknown' : `About $${plan.estimatedUsd.toFixed(2)} (estimate)`}</dd>
        </div>
      </dl>
      <h4 className="review-head">{plan.local ? 'Stays on this computer' : plan.sends.length ? 'Sent to the provider' : 'Nothing is uploaded'}</h4>
      {plan.sends.length > 0 && (
        <ul className="review-sends">
          {plan.sends.map((s) => (
            <li key={s.name}>
              <span>{s.name}</span>
              <span className="muted small">
                {s.bytes === null ? '' : `${bytes(s.bytes)} · `}
                {s.note}
              </span>
            </li>
          ))}
        </ul>
      )}
      {plan.notes.map((n) => (
        <p key={n} className="muted small review-note">
          {n}
        </p>
      ))}
    </div>
  );
}
