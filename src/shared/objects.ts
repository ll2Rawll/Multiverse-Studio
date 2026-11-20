/**
 * Living objects: content created once and used in pages and video scenes.
 *
 * An object is a file in the universe (`objects/<id>.mvobj.json`), so universes isolate and merge
 * objects like any other file. Placements carry the object revision they were rendered from and
 * their own instance overrides:
 * - web: a section with data-mv-object / data-mv-instance / data-mv-object-rev / data-mv-props;
 * - video: a title clip with `object: { id, instance, revision, overrides }`.
 */

export const OBJECT_TYPES = ['pricing-card', 'feature-list', 'statistic', 'call-to-action', 'title-card'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];
export const OBJECT_DIR = 'objects';
export const objectPath = (id: string): string => `${OBJECT_DIR}/${id}.mvobj.json`;
export const OBJECTS_CSS = 'objects.css';

export interface ObjectField {
  key: string;
  label: string;
  kind: 'text' | 'longtext' | 'list' | 'url';
}

export const OBJECT_TYPE_INFO: Record<ObjectType, { label: string; description: string; fields: ObjectField[]; defaults: Record<string, string | string[]> }> = {
  'pricing-card': {
    label: 'Pricing card',
    description: 'A plan with its price, what it includes and a call to action.',
    fields: [
      { key: 'plan', label: 'Plan', kind: 'text' },
      { key: 'price', label: 'Price', kind: 'text' },
      { key: 'period', label: 'Period', kind: 'text' },
      { key: 'features', label: 'Included', kind: 'list' },
      { key: 'cta', label: 'Button', kind: 'text' },
      { key: 'href', label: 'Button link', kind: 'url' },
    ],
    defaults: { plan: 'Pro', price: '$12', period: 'per month', features: ['Unlimited projects', 'Priority support'], cta: 'Start free', href: '#' },
  },
  'feature-list': {
    label: 'Feature list',
    description: 'A heading and a short list of features.',
    fields: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'items', label: 'Features', kind: 'list' },
    ],
    defaults: { heading: 'Why teams pick it', items: ['Plan the week in minutes', 'Everything in one place', 'Works offline'] },
  },
  statistic: {
    label: 'Statistic',
    description: 'One number with a label and an optional source.',
    fields: [
      { key: 'value', label: 'Value', kind: 'text' },
      { key: 'label', label: 'Label', kind: 'text' },
      { key: 'source', label: 'Source', kind: 'text' },
    ],
    defaults: { value: '42%', label: 'less time in meetings', source: '' },
  },
  'call-to-action': {
    label: 'Call to action',
    description: 'A headline, a supporting line and a button.',
    fields: [
      { key: 'headline', label: 'Headline', kind: 'text' },
      { key: 'body', label: 'Supporting line', kind: 'longtext' },
      { key: 'button', label: 'Button', kind: 'text' },
      { key: 'href', label: 'Button link', kind: 'url' },
    ],
    defaults: { headline: 'Ready when you are', body: 'Start free. No card needed.', button: 'Get started', href: '#' },
  },
  'title-card': {
    label: 'Title card',
    description: 'A title and subtitle for a page header or a video scene.',
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'subtitle', label: 'Subtitle', kind: 'text' },
    ],
    defaults: { title: 'Orbit', subtitle: 'Plan the week. Ship the work.' },
  },
};

export type ObjectProps = Record<string, string | string[]>;

export interface LivingObject {
  format: 'multiverse-object';
  version: 1;
  id: string;
  type: ObjectType;
  name: string;
  /** Bumped on every property change; placements record the revision they show. */
  revision: number;
  properties: ObjectProps;
  /** Library asset ids the object uses (images, logos). */
  assets: string[];
  targets: ('web' | 'video')[];
  /** Other objects this one depends on. */
  dependencies: string[];
  /** Target-specific overrides shared by every placement on that target in this universe. */
  overrides: { web?: ObjectProps; video?: ObjectProps };
}

export type PlacementState = 'current' | 'outdated' | 'edited';

export interface PlacementView {
  kind: 'page' | 'scene';
  /** Page path or sequence path. */
  path: string;
  instance: string;
  /** Clip id for scenes. */
  clipId: string | null;
  revision: number;
  overrides: ObjectProps;
  /** current: matches the object; outdated: shows an older revision; edited: changed by hand since. */
  state: PlacementState;
}

export interface ObjectView extends LivingObject {
  path: string;
  placements: PlacementView[];
}

export interface ObjectUsesView {
  objectId: string;
  universes: { lineId: string; name: string; revision: number | null; differsFromShared: boolean; placements: PlacementView[] }[];
}
