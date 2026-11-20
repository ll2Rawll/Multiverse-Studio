/** Errors with a stable code and a message written for people, not developers. */
export class StudioError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StudioError';
  }
}

export function notFound(what: string): StudioError {
  return new StudioError('not-found', `${what} could not be found.`);
}
