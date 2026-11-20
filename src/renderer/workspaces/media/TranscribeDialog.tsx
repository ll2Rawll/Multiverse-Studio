/** Transcribe one media file: shows exactly what is sent (a small audio extract, never the picture) before sending. */
import { useState } from 'react';
import { useStudio } from '../../state/store';
import { startJob } from '../../state/media';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/primitives';
import { JobReview, usePlan } from './JobReview';
import type { MediaAssetView } from '../../../shared/video';

export function TranscribeDialog({ asset, onClose }: { asset: MediaAssetView; onClose: () => void }) {
  const projectId = useStudio((s) => s.project!.id);
  const [language, setLanguage] = useState('');
  const job = { kind: 'transcription' as const, request: { assetId: asset.id, language: /^[a-z]{2,3}$/.test(language) ? language : null } };
  const review = usePlan(projectId, job);
  return (
    <Dialog
      title={`Transcribe ${asset.name}`}
      description="Timed segments are saved with the media, for captions and AI edits."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="text" disabled={!review.plan} onClick={() => void startJob(projectId, job).then((j) => j && onClose())}>
            Transcribe
          </Button>
        </>
      }
    >
      <label className="prop-row">
        <span className="prop-label">Language</span>
        <input className="input" aria-label="Language code" placeholder="Detect automatically (or en, de, ja…)" value={language} onChange={(e) => setLanguage(e.target.value.trim().toLowerCase())} maxLength={3} />
      </label>
      <JobReview {...review} />
    </Dialog>
  );
}
