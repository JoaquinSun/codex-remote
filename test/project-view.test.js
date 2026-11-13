'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectForThread, workingProjects, includeWorkingThreads } = require('../public/project-view');

const projects = [
  { id: 'parent', name: 'Workspace', roots: [{ path: '/work/' }] },
  { id: 'web', name: 'Website', roots: [{ path: '/work/site' }, { path: '/another/site/' }] },
  { id: 'api', name: 'API', roots: [{ path: '/work/api' }] },
];

function thread(id, cwd, type = 'active', updatedAt = 100, extra = {}) {
  return { id, cwd, status: { type }, updatedAt, ...extra };
}

test('assigns a working directory to its most specific project, with explicit IDs taking precedence', () => {
  assert.equal(projectForThread(thread('a', '/work/site/src/'), projects), projects[1]);
  assert.equal(projectForThread(thread('a', '/another/site/src'), projects), projects[1]);
  assert.equal(projectForThread(thread('a', '/work/site-extra'), projects), projects[0]);
  assert.equal(projectForThread(thread('a', '/work/site', 'active', 100, { projectId: 'api' }), projects), projects[2]);
  assert.equal(projectForThread(thread('a', '/elsewhere'), projects), null);
  assert.equal(projectForThread(thread('a', '/'), [{ id: 'root', roots: [{ path: '/' }] }]).id, 'root');
});

test('groups only working chats, deduplicates them, and counts chats waiting for approval', () => {
  const running = thread('running', '/work/site');
  const groups = workingProjects([
    running, running,
    thread('waiting', '/work/site/src'),
    thread('finished', '/work/site', 'idle'),
    thread('background', '/work/api', 'idle', 200),
  ], projects, { activeTurns: { background: 'turn' }, waitingThreadIds: ['waiting'] });
  assert.deepEqual(groups.map((group) => ({ name: group.name, count: group.threads.length, waiting: group.waitingCount })), [
    { name: 'Website', count: 2, waiting: 1 },
    { name: 'API', count: 1, waiting: 0 },
  ]);
  assert.equal(groups[0].root, '/work/site');
});

test('shows unregistered workspaces and ephemeral work without inventing registered projects', () => {
  const groups = workingProjects([
    thread('a', '/private/my-repo/'),
    thread('b', '/private/my-repo', 'active', 99, { ephemeral: true }),
    thread('c', '', 'active', 200),
  ], projects);
  assert.deepEqual(groups.map((group) => ({ key: group.key, name: group.name, count: group.threads.length })), [
    { key: 'cwd:', name: '其他任务', count: 1 },
    { key: 'cwd:/private/my-repo', name: 'my-repo', count: 2 },
  ]);
});

test('removes completed or interrupted projects and keeps projects with another active chat', () => {
  const chats = [thread('first', '/work/site'), thread('second', '/work/site/src'), thread('api', '/work/api')];
  const options = { activeTurns: { first: 'one', second: 'two', api: 'three' } };
  assert.equal(workingProjects(chats, projects, options).length, 2);

  delete options.activeTurns.first;
  chats[0].status.type = 'idle';
  assert.equal(workingProjects(chats, projects, options).find((group) => group.key === 'project:web').threads.length, 1);

  delete options.activeTurns.second;
  chats[1].status.type = 'idle';
  assert.deepEqual(workingProjects(chats, projects, options).map((group) => group.name), ['API']);

  delete options.activeTurns.api;
  chats[2].status.type = 'idle';
  assert.deepEqual(workingProjects(chats, projects, options), []);
});

test('finds older working chats beyond the recent page and reuses their metadata on the next refresh', async () => {
  const recent = { data: [thread('recent', '/work/site', 'idle')], nextCursor: 'page-two' };
  const calls = [];
  const fetchPage = async (cursor) => {
    calls.push(cursor);
    if (cursor === 'page-two') return { data: [thread('unrelated', '/work', 'idle')], nextCursor: 'page-three' };
    return { data: [thread('older-active', '/work/api')], nextCursor: 'unused' };
  };
  const result = await includeWorkingThreads(recent, [], ['older-active'], fetchPage);
  assert.deepEqual(result.map((entry) => entry.id), ['recent', 'older-active']);
  assert.deepEqual(calls, ['page-two', 'page-three']);
  calls.length = 0;
  assert.deepEqual((await includeWorkingThreads(recent, result, ['older-active'], fetchPage)).map((entry) => entry.id), ['recent', 'older-active']);
  assert.deepEqual(calls, []);
  assert.deepEqual((await includeWorkingThreads(recent, result, [], fetchPage)).map((entry) => entry.id), ['recent']);
});

test('does not scan history when every active chat is already loaded and stops on repeated cursors', async () => {
  const first = { data: [thread('active', '/work/api')], nextCursor: 'repeat' };
  const calls = [];
  const fetchPage = async (cursor) => { calls.push(cursor); return { data: [], nextCursor: cursor }; };
  await includeWorkingThreads(first, [], ['active'], fetchPage);
  assert.deepEqual(calls, []);
  await includeWorkingThreads(first, [], ['missing'], fetchPage);
  assert.deepEqual(calls, ['repeat']);
});

test('preserves the recent sidebar if fetching an older working chat fails', async () => {
  const first = { data: [thread('recent', '/work')], nextCursor: 'next' };
  const result = await includeWorkingThreads(first, [], ['older'], async () => { throw new Error('offline'); });
  assert.deepEqual(result, first.data);
});

test('working projects retain catalog order when chat activity or waiting approvals change', () => {
  const chats = [thread('web-task', '/work/site', 'active', 100), thread('api-task', '/work/api', 'active', 900)];
  const names = (options) => workingProjects(chats, projects, options).map((group) => group.name);
  assert.deepEqual(names(), ['Website', 'API']);
  chats[0].updatedAt = 1000;
  assert.deepEqual(names({ waitingThreadIds: ['api-task'] }), ['Website', 'API']);
  chats[1].updatedAt = 1100;
  assert.deepEqual(names(), ['Website', 'API']);
});
