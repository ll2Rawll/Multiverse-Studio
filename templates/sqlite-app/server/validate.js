export const STATUSES = ['want', 'reading', 'done'];

/**
 * Validates a book payload. With partial = true (PATCH) missing fields are allowed.
 * Returns { value, errors } where errors maps field -> message.
 */
export function validateBook(input, { partial = false } = {}) {
  const errors = {};
  const value = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { value, errors: { body: 'Send a JSON object.' } };
  const known = new Set(['title', 'author', 'status', 'rating', 'notes']);
  for (const key of Object.keys(input)) if (!known.has(key)) errors[key] = 'Unknown field.';

  if ('title' in input || !partial) {
    if (typeof input.title !== 'string' || input.title.trim().length === 0) errors.title = 'Enter a title.';
    else if (input.title.trim().length > 200) errors.title = 'Use 200 characters or fewer.';
    else value.title = input.title.trim();
  }
  if ('author' in input) {
    if (typeof input.author !== 'string') errors.author = 'Author must be text.';
    else if (input.author.trim().length > 120) errors.author = 'Use 120 characters or fewer.';
    else value.author = input.author.trim();
  }
  if ('status' in input) {
    if (!STATUSES.includes(input.status)) errors.status = `Status must be one of: ${STATUSES.join(', ')}.`;
    else value.status = input.status;
  }
  if ('rating' in input) {
    if (input.rating === null) value.rating = null;
    else if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) errors.rating = 'Rating must be a whole number from 1 to 5.';
    else value.rating = input.rating;
  }
  if ('notes' in input) {
    if (typeof input.notes !== 'string') errors.notes = 'Notes must be text.';
    else if (input.notes.length > 2000) errors.notes = 'Use 2000 characters or fewer.';
    else value.notes = input.notes;
  }
  if (partial && Object.keys(value).length === 0 && Object.keys(errors).length === 0) errors.body = 'Nothing to update.';
  return { value, errors };
}
