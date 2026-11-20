/**
 * What the user has selected in workspaces that keep their selection locally (Design, Assets), so
 * the Assistant can offer it as a reference chip. Video selection lives in the video store.
 */
import { create } from 'zustand';

export interface SelectionRefs {
  design: { page: string; id: string; label: string } | null;
  asset: { id: string; label: string } | null;
  /** A living object to open in Assets → Objects (set from Design). */
  openObject: string | null;
}

export const useSelectionRefs = create<SelectionRefs>(() => ({ design: null, asset: null, openObject: null }));
