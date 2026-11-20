import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.js';

const STATUS_LABEL = { want: 'Want to read', reading: 'Reading', done: 'Finished' };
const EMPTY = { title: '', author: '', status: 'want' };

function AddBook({ onAdded }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api.create(form);
      setForm(EMPTY);
      onAdded();
    } catch (err) {
      setErrors(err instanceof ApiError ? { ...err.fields, form: Object.keys(err.fields).length ? '' : err.message } : { form: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add" onSubmit={submit} noValidate>
      <label>
        Title
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? 'title-error' : undefined} />
        {errors.title && <span id="title-error" className="field-error">{errors.title}</span>}
      </label>
      <label>
        Author
        <input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} aria-invalid={Boolean(errors.author)} />
        {errors.author && <span className="field-error">{errors.author}</span>}
      </label>
      <label>
        Status
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add book'}</button>
      {errors.form && <p className="field-error" role="alert">{errors.form}</p>}
    </form>
  );
}

function BookRow({ book, onChanged }) {
  const [error, setError] = useState('');
  const run = async (fn) => {
    setError('');
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <li className="book">
      <div className="book-main">
        <strong>{book.title}</strong>
        {book.isDemo && <span className="demo">Demo</span>}
        <span className="author">{book.author || 'Unknown author'}</span>
        {book.finishedOn && <span className="author">Finished {book.finishedOn}</span>}
      </div>
      <select aria-label={`Status of ${book.title}`} value={book.status} onChange={(e) => run(() => api.update(book.id, { status: e.target.value }))}>
        {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <select aria-label={`Rating of ${book.title}`} value={book.rating ?? ''} onChange={(e) => run(() => api.update(book.id, { rating: e.target.value ? Number(e.target.value) : null }))}>
        <option value="">No rating</option>
        {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
      </select>
      <button className="quiet" onClick={() => run(() => api.remove(book.id))}>Delete</button>
      {error && <p className="field-error" role="alert">{error}</p>}
    </li>
  );
}

export function App() {
  const [filter, setFilter] = useState({ status: '', q: '' });
  const [state, setState] = useState({ kind: 'loading' });
  const [stats, setStats] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [books, s] = await Promise.all([api.list(filter), api.stats()]);
      setState({ kind: 'ready', books });
      setStats(s);
    } catch (err) {
      setState({ kind: 'error', message: err.message });
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="app">
      <header>
        <h1>Reading list</h1>
        {stats && <p className="stats">{stats.reading} reading · {stats.want} to read · {stats.done} finished</p>}
      </header>
      {stats?.demo > 0 && (
        <div className="demo-banner">
          <p>{stats.demo} demo {stats.demo === 1 ? 'book is' : 'books are'} shown so the app is not empty.</p>
          <button className="quiet" onClick={() => api.clearDemo().then(refresh)}>Remove demo data</button>
        </div>
      )}
      <AddBook onAdded={refresh} />
      <div className="filters">
        <select aria-label="Filter by status" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="">All books</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input type="search" aria-label="Search" placeholder="Search title or author" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
      </div>
      {state.kind === 'loading' && <p role="status">Loading books…</p>}
      {state.kind === 'error' && (
        <div className="error" role="alert">
          <p>{state.message}</p>
          <button onClick={refresh}>Try again</button>
        </div>
      )}
      {state.kind === 'ready' && state.books.length === 0 && <p className="empty">No books here yet. Add one above.</p>}
      {state.kind === 'ready' && state.books.length > 0 && (
        <ul className="books">
          {state.books.map((b) => <BookRow key={b.id} book={b} onChanged={refresh} />)}
        </ul>
      )}
    </main>
  );
}
