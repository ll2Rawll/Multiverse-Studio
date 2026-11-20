import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTask, countLabel, createTask, loadTasks, removeTask, saveTasks, STORAGE_KEY, toggleTask, visibleTasks } from '../js/tasks.js';

const opts = (id) => ({ id, now: 0 });

test('a task needs a title, trimmed and of a sensible length', () => {
  assert.equal(createTask('  Write   the brief ', opts('a')).title, 'Write the brief');
  assert.throws(() => createTask('   '), /needs a title/);
  assert.throws(() => createTask('x'.repeat(121)), /under 120/);
});

test('adding, completing and removing tasks updates the open count', () => {
  let tasks = addTask([], 'Write the brief', opts('a'));
  tasks = addTask(tasks, 'Book the room', opts('b'));
  assert.equal(countLabel(tasks), '2 open');
  tasks = toggleTask(tasks, 'a');
  assert.equal(countLabel(tasks), '1 open');
  assert.deepEqual(visibleTasks(tasks, 'done').map((t) => t.id), ['a']);
  assert.deepEqual(visibleTasks(tasks, 'open').map((t) => t.id), ['b']);
  tasks = removeTask(tasks, 'b');
  assert.equal(countLabel(tasks), '0 open');
});

test('storage that is missing, blocked or corrupt never breaks the app', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadTasks(null), []);
  assert.deepEqual(loadTasks(blocked), []);
  assert.equal(saveTasks(blocked, []), false);
  const memory = new Map([[STORAGE_KEY, '{not json']]);
  const store = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  assert.deepEqual(loadTasks(store), []);
  assert.equal(saveTasks(store, [createTask('Plan', opts('p'))]), true);
  assert.equal(loadTasks(store)[0].title, 'Plan');
});
