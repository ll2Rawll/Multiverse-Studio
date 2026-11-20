/** Design workspace view state (open page per universe, breakpoint, left tab). */
import { create } from 'zustand';
import type { DesignBreakpoint } from '../../shared/design';

export type DesignLeftTab = 'outline' | 'add' | 'pages' | 'theme';

interface DesignUi {
  page: Record<string, string>;
  breakpoint: DesignBreakpoint;
  tab: DesignLeftTab;
}
export const useDesignUi = create<DesignUi>(() => ({ page: {}, breakpoint: 'desktop', tab: 'outline' }));
