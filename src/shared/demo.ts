/**
 * Reproducible demo actions for the sample project. The in-app tour performs these
 * through the normal IPC API (no shortcuts), and the automated tests run the same steps.
 */
export const DEMO = {
  productRename: { from: 'Kiln', to: 'Kilnworks' },
  heading: {
    original: 'Plan work that ships.',
    shared: 'Built for growing teams.',
    editorial: 'Built for independent makers.',
    combined: 'Built for independent makers and growing teams.',
  },
  footerKey: '#site-footer',
  combinedName: 'Minimal + Bold footer',
} as const;

export interface DemoStep {
  id: string;
  title: string;
  body: string;
  action: string;
}

export const DEMO_STEPS: DemoStep[] = [
  {
    id: 'rename',
    title: 'Make a shared change',
    body: 'Rename the product from “Kiln” to “Kilnworks” in the Shared version and save it. Every alternative that follows shared changes receives the new name, and their own layouts stay exactly as they were.',
    action: 'Rename and save',
  },
  {
    id: 'conflict',
    title: 'Create a genuine conflict',
    body: 'Editorial rewrote the hero heading as “Built for independent makers.” Now the Shared version changes the same heading to “Built for growing teams.” Minimal and Bold take it automatically; Editorial needs a decision.',
    action: 'Change the heading and save',
  },
  {
    id: 'resolve',
    title: 'Resolve the conflict',
    body: 'Open Editorial’s conflict, compare both wordings side by side, and keep one — or write a combined heading. Nothing is overwritten until you decide.',
    action: 'Open the conflict',
  },
  {
    id: 'combine',
    title: 'Combine the best parts',
    body: 'Take Bold’s footer and transplant it into a new alternative based on Minimal. You’ll review the CSS, fonts and assets it needs before anything is applied.',
    action: 'Set up the combination',
  },
  {
    id: 'export',
    title: 'Export the result',
    body: 'Export the combined alternative as an ordinary folder or ZIP that opens in any browser — no history or app data included.',
    action: 'Export…',
  },
];

export function renameProduct(html: string): string {
  return html.split(DEMO.productRename.from).join(DEMO.productRename.to);
}

export function changeHeading(html: string): string {
  return html.replace(DEMO.heading.original, DEMO.heading.shared);
}
