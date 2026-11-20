/** Serializable views for the Design workspace. */
export type DesignBreakpoint = 'desktop' | 'tablet' | 'mobile';

export interface DesignNodeView {
  key: string;
  mvId: string | null;
  path: string;
  tag: string;
  kind: 'section' | 'text' | 'link' | 'button' | 'image' | 'container' | 'other';
  label: string;
  text: string | null;
  editableText: boolean;
  attrs: { href?: string; src?: string; alt?: string; target?: string };
  component: string | null;
  object: string | null;
  sectionType: string | null;
  children: DesignNodeView[];
}

export interface DesignPageView {
  page: string;
  title: string;
  supported: boolean;
  reason: string | null;
  sections: DesignNodeView[];
  pages: string[];
  components: string[];
  /** Image files in this version, for image pickers. */
  images: string[];
  /** Per-element styles from design.css, by data-mv-id and breakpoint. */
  styles: Record<string, Partial<Record<DesignBreakpoint, Record<string, string>>>>;
  theme: { stylesheet: string | null; tokens: { name: string; value: string }[] };
  library: { kind: string; label: string; description: string }[];
  /** Content hashes for expected-revision checks. */
  hashes: Record<string, string | null>;
  undo: string | null;
  redo: string | null;
}

export interface CommandRunResult {
  label: string;
  hashes: Record<string, string | null>;
  undo: string | null;
  redo: string | null;
}
