import { useState } from 'react';
import { useStudio, set, get, openDialog, toast } from '../state/store';
import { exportRef, saveShared, selectLine } from '../state/actions';
import { call, errorMessage } from '../lib/api';
import { Button, IconButton } from '../components/primitives';
import { Icon } from '../components/Icon';
import { DEMO, DEMO_STEPS, changeHeading, renameProduct } from '../../shared/demo';
import { lineRef } from '../lib/util';
import { SHARED_LINE_ID } from '../../shared/types';

async function editShared(transform: (html: string) => string, message: string): Promise<void> {
  const project = get().project!;
  const file = await call('files.read', { projectId: project.id, ref: lineRef(SHARED_LINE_ID), path: 'index.html' });
  const next = transform(file.text ?? '');
  if (next === file.text) {
    toast({ tone: 'info', title: 'Already done', body: 'The Shared version already has this change.' });
    return;
  }
  await call('files.write', { projectId: project.id, lineId: SHARED_LINE_ID, path: 'index.html', text: next });
  set({ workspace: 'explore', exploreView: 'grid' });
  await saveShared(message);
}

/** The sample project's guided tour: every step uses the same API as the interface. */
async function runStep(id: string): Promise<void> {
  const project = get().project!;
  const byName = (name: string) => project.alternatives.find((a) => a.name === name);
  switch (id) {
    case 'rename':
      await editShared(renameProduct, `Rename the product to ${DEMO.productRename.to}`);
      return;
    case 'conflict':
      await editShared(changeHeading, 'New hero heading for growing teams');
      return;
    case 'resolve': {
      const editorial = get().project!.alternatives.find((a) => a.status === 'conflicted') ?? byName('Editorial');
      if (!editorial || editorial.status !== 'conflicted') {
        toast({ tone: 'info', title: 'No conflict waiting', body: 'Run the previous step first, or the conflict is already resolved.' });
        return;
      }
      selectLine(editorial.id);
      openDialog({ kind: 'conflicts', lineId: editorial.id });
      return;
    }
    case 'combine': {
      const minimal = byName('Minimal');
      const bold = byName('Bold');
      if (!minimal || !bold) {
        toast({ tone: 'info', title: 'Minimal and Bold are needed for this step' });
        return;
      }
      const analysis = await call('combine.analyzeSection', {
        projectId: project.id,
        source: lineRef(bold.id),
        sourcePath: 'index.html',
        sectionKey: DEMO.footerKey,
        destination: lineRef(minimal.id),
        destPath: 'index.html',
      });
      set({
        workspace: 'compare',
        compare: { ...get().compare, mode: 'combine' },
        combine: {
          destination: { kind: 'new', base: lineRef(minimal.id), name: DEMO.combinedName, color: 'teal', description: 'Minimal with Bold’s footer', following: true },
          source: lineRef(bold.id),
          files: {},
          sections: [
            {
              source: lineRef(bold.id),
              sourcePath: 'index.html',
              sectionKey: DEMO.footerKey,
              destPath: 'index.html',
              target: analysis.suggestedTarget,
              cssRuleIds: analysis.cssRules.filter((r) => r.defaultSelected).map((r) => r.id),
              includeVariables: true,
              assets: analysis.assets.map((a) => ({ path: a.path, action: a.defaultAction })),
              destCssPath: analysis.destCssPath,
            },
          ],
          edits: {},
          description: '',
          stage: 'review',
          tab: 'sections',
          result: null,
        },
      });
      return;
    }
    case 'export': {
      const combined = get().project!.alternatives.find((a) => a.name === DEMO.combinedName) ?? get().project!.alternatives.at(-1);
      if (combined) exportRef(lineRef(combined.id), combined.name);
      return;
    }
  }
}

export function Tour() {
  const tour = useStudio((s) => s.tour);
  const [busy, setBusy] = useState(false);
  const step = DEMO_STEPS[tour.step]!;
  const go = (i: number): void => set((s) => ({ tour: { ...s.tour, step: Math.max(0, Math.min(DEMO_STEPS.length - 1, i)) } }));
  const doIt = async (): Promise<void> => {
    setBusy(true);
    try {
      await runStep(step.id);
      // Step out of the way so the result is visible; the pill brings the tour back.
      set((s) => ({ tour: { ...s.tour, done: [...new Set([...s.tour.done, step.id])], minimized: true } }));
    } catch (error) {
      toast({ tone: 'error', title: 'That step did not complete', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  const done = tour.done.includes(step.id);
  if (tour.minimized) {
    const next = DEMO_STEPS[Math.min(DEMO_STEPS.length - 1, done ? tour.step + 1 : tour.step)]!;
    return (
      <button
        type="button"
        className="tour-pill material-modal"
        onClick={() => set((s) => ({ tour: { ...s.tour, minimized: false, step: done && s.tour.step < DEMO_STEPS.length - 1 ? s.tour.step + 1 : s.tour.step } }))}
      >
        <Icon name="tour" size={15} />
        <span>
          Sample tour · {done && tour.step === DEMO_STEPS.length - 1 ? 'All steps done' : `Next: ${next.title}`}
        </span>
        <Icon name="chevronRight" size={14} />
      </button>
    );
  }
  return (
    <aside className="tour material-modal" aria-label="Sample project tour" aria-live="polite">
      <header className="tour-head">
        <span className="tour-kicker">
          <Icon name="tour" size={14} /> Sample tour · {tour.step + 1} of {DEMO_STEPS.length}
        </span>
        <IconButton icon="close" size="sm" label="Close tour" onClick={() => set((s) => ({ tour: { ...s.tour, open: false } }))} />
      </header>
      <ol className="tour-dots" aria-hidden="true">
        {DEMO_STEPS.map((s, i) => (
          <li key={s.id} className={i === tour.step ? 'is-current' : tour.done.includes(s.id) ? 'is-done' : ''} />
        ))}
      </ol>
      <h2>{step.title}</h2>
      <p>{step.body}</p>
      <div className="tour-actions">
        <Button variant={done ? 'secondary' : 'primary'} icon={done ? 'check' : 'play'} disabled={busy} onClick={() => void doIt()}>
          {busy ? 'Working…' : done ? 'Done — run again' : step.action}
        </Button>
        <span className="bar-spacer" />
        <IconButton icon="chevronLeft" size="sm" label="Previous step" disabled={tour.step === 0} onClick={() => go(tour.step - 1)} />
        <IconButton icon="chevronRight" size="sm" label="Next step" disabled={tour.step === DEMO_STEPS.length - 1} onClick={() => go(tour.step + 1)} />
      </div>
    </aside>
  );
}
