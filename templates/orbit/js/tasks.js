// Orbit's task rules, kept free of the page so they can be tested with `npm test`.
export const STORAGE_KEY = 'orbit.tasks.v1';
export const MAX_TITLE = 120;
export const FILTERS = ['all', 'open', 'done'];

export function createTask(title, { id = Math.random().toString(36).slice(2, 10), now = Date.now() } = {}) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('A task needs a title.');
  if (clean.length > MAX_TITLE) throw new Error(`Keep titles under ${MAX_TITLE} characters.`);
  return { id, title: clean, done: false, createdAt: now };
}

export function addTask(tasks, title, options) {
  return [...tasks, createTask(title, options)];
}

export function toggleTask(tasks, id) {
  return tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
}

export function removeTask(tasks, id) {
  return tasks.filter((t) => t.id !== id);
}

export function visibleTasks(tasks, filter = 'all') {
  if (filter === 'open') return tasks.filter((t) => !t.done);
  if (filter === 'done') return tasks.filter((t) => t.done);
  return tasks;
}

export function openCount(tasks) {
  return tasks.filter((t) => !t.done).length;
}

export function countLabel(tasks) {
  return `${openCount(tasks)} open`;
}

const isTask = (t) => t && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.done === 'boolean';

// Storage can be missing or blocked (private windows, sandboxed previews): Orbit then works for the session only.
export function loadTasks(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(isTask) : [];
  } catch {
    return [];
  }
}

export function saveTasks(storage, tasks) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    return true;
  } catch {
    return false;
  }
}
