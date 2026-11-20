export class ApiError extends Error {
  constructor(message, status, fields) {
    super(message);
    this.status = status;
    this.fields = fields ?? {};
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { ...options, headers: options.body ? { 'content-type': 'application/json' } : undefined });
  } catch {
    throw new ApiError('Cannot reach the API. Is it running (npm run dev)?', 0);
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status}).`, res.status, body.fields);
  return body;
}

export const api = {
  list: ({ status, q } = {}) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    return request(`/api/books?${params}`).then((b) => b.books);
  },
  stats: () => request('/api/stats'),
  create: (book) => request('/api/books', { method: 'POST', body: JSON.stringify(book) }).then((b) => b.book),
  update: (id, patch) => request(`/api/books/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((b) => b.book),
  remove: (id) => request(`/api/books/${id}`, { method: 'DELETE' }),
  clearDemo: () => request('/api/demo', { method: 'DELETE' }),
};
