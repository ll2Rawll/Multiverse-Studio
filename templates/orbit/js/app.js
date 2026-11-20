import { addTask, countLabel, FILTERS, loadTasks, removeTask, saveTasks, toggleTask, visibleTasks } from './tasks.js';

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

let tasks = loadTasks(storage);
let filter = 'all';

const form = document.getElementById('new-task');
const input = document.getElementById('task-title');
const list = document.getElementById('task-list');
const count = document.querySelector('[data-testid="count"]');
const empty = document.getElementById('empty');
const error = document.getElementById('task-error');
const saved = document.getElementById('saved-note');

function commit(next) {
  tasks = next;
  const kept = saveTasks(storage, tasks);
  saved.textContent = kept ? 'Saved in this browser.' : 'This browser blocks storage, so tasks last until you close the page.';
  render();
}

function render() {
  list.replaceChildren(
    ...visibleTasks(tasks, filter).map((t) => {
      const li = document.createElement('li');
      li.className = t.done ? 'task is-done' : 'task';
      li.dataset.testid = 'task';
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = t.done;
      box.addEventListener('change', () => commit(toggleTask(tasks, t.id)));
      const title = document.createElement('span');
      title.textContent = t.title;
      label.append(box, title);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'task-delete';
      del.setAttribute('aria-label', `Delete “${t.title}”`);
      del.textContent = '×';
      del.addEventListener('click', () => commit(removeTask(tasks, t.id)));
      li.append(label, del);
      return li;
    }),
  );
  count.textContent = countLabel(tasks);
  empty.hidden = tasks.length > 0;
  for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  try {
    commit(addTask(tasks, input.value));
    input.value = '';
    error.textContent = '';
  } catch (err) {
    error.textContent = err.message;
  }
  input.focus();
});

for (const b of document.querySelectorAll('[data-filter]')) {
  b.addEventListener('click', () => {
    if (FILTERS.includes(b.dataset.filter)) filter = b.dataset.filter;
    render();
  });
}

render();
