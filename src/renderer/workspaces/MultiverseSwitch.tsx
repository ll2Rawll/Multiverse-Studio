import { useEffect, useRef } from 'react';
import { useStudio } from '../state/store';
import { setWorkspace } from '../state/actions';
import { SegmentedControl } from '../components/primitives';

/** Switching views remounts the workspace; keyboard focus follows to the new view's switch. */
let refocusSwitch = false;

/** Title and view switch shared by the two Multiverse views. */
export function MultiverseHeading() {
  const workspace = useStudio((s) => s.workspace);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!refocusSwitch) return;
    refocusSwitch = false;
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, []);
  return (
    <>
      <h1 className="workspace-title" data-text="Multiverse">
        Multiverse
      </h1>
      <div ref={ref} className="multiverse-switch-wrap">
        <SegmentedControl
          size="sm"
          label="Multiverse view"
          className="multiverse-switch"
          options={[
            { value: 'explore', label: 'Explore', icon: 'grid' },
            { value: 'compare', label: 'Compare & Combine', icon: 'compare' },
          ]}
          value={workspace === 'compare' ? 'compare' : 'explore'}
          onChange={(v) => {
            refocusSwitch = Boolean(ref.current?.contains(document.activeElement));
            setWorkspace(v);
          }}
        />
      </div>
      <span className="toolbar-divider" aria-hidden="true" />
    </>
  );
}
