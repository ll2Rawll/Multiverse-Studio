/** Review work that stopped when the app last closed, and retry what can be retried safely. */
import { useState } from 'react';
import { closeDialog, openDialog, toast } from '../state/store';
import { setWorkspace } from '../state/actions';
import { openTask, setPanel } from '../state/ai';
import { dismissRecovery, useRecovery, type RecoveryItem } from '../state/recovery';
import { call, errorMessage } from '../lib/api';
import { Dialog } from '../components/Dialog';
import { Button, EmptyState } from '../components/primitives';
import { lineRef } from '../lib/util';

const TYPE_LABEL: Record<RecoveryItem['type'], string> = { task: 'AI task', media: 'Media job', export: 'Video export', deploy: 'Publish', story: 'Story run' };

function Row({ item, projectId }: { item: RecoveryItem; projectId: string }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      if (item.type === 'media') await call('media.jobs.retry', { projectId, jobId: item.id, confirmUncertain: confirm });
      else await call('publish.retry', { projectId, jobId: item.id, confirmUncertain: confirm });
      dismissRecovery(item);
      toast({ tone: 'info', title: 'Started again', body: item.title });
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t retry', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="deploy-row" data-state={item.uncertain ? 'uncertain' : 'interrupted'}>
      <div className="deploy-main">
        <span className="deploy-state">
          {TYPE_LABEL[item.type]} · {item.state}
        </span>
        <span>{item.title}</span>
        <span className="deploy-detail">{item.detail}</span>
        {item.uncertain && (
          <label className="check-row">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I checked with the provider and it did not finish
          </label>
        )}
      </div>
      <div className="conn-actions">
        {item.type === 'task' && (
          <Button
            size="sm"
            onClick={() => {
              closeDialog();
              setPanel('assistant');
              void openTask(item.id);
            }}
          >
            Open task
          </Button>
        )}
        {item.type === 'export' && (
          <Button
            size="sm"
            onClick={() => {
              closeDialog();
              setWorkspace('video');
            }}
          >
            Open Video
          </Button>
        )}
        {item.type === 'story' && (
          <Button
            size="sm"
            onClick={() => {
              closeDialog();
              setWorkspace('stories');
            }}
          >
            Open Stories
          </Button>
        )}
        {item.type === 'deploy' && item.lineId && (
          <Button size="sm" variant="quiet" onClick={() => openDialog({ kind: 'publish', ref: lineRef(item.lineId!) })}>
            Details
          </Button>
        )}
        {(item.type === 'media' || item.type === 'deploy') && (
          <Button size="sm" disabled={busy || (item.uncertain && !confirm)} onClick={() => void retry()}>
            Retry
          </Button>
        )}
        <Button size="sm" variant="quiet" onClick={() => dismissRecovery(item)} aria-label={`Dismiss ${item.title}`}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}

export function RecoveryDialog() {
  const { projectId, items } = useRecovery();
  return (
    <Dialog title="Interrupted work" description="These stopped when the app last closed. Nothing was restarted on its own, and paid requests with an unknown result are never sent again without your confirmation." size="lg" onClose={closeDialog}>
      {!projectId || items.length === 0 ? (
        <EmptyState icon="check" title="Nothing left to review" body="Your files, versions and history are intact." />
      ) : (
        <ul className="deploy-list">
          {items.map((i) => (
            <Row key={`${i.type}:${i.id}`} item={i} projectId={projectId} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}
