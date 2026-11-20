/** Window event that shifts the Dystopia wallpaper once when a shared change lands in alternatives. */
export const FRACTURE_PULSE_EVENT = 'mv:fracture-pulse';

export function pulseFracture(): void {
  window.dispatchEvent(new Event(FRACTURE_PULSE_EVENT));
}
