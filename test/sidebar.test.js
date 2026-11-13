'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.scrollTop = 0;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    };
  }
  set innerHTML(value) { this.html = value; this.children = []; this.scrollTop = 0; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this.scrollTop = 0; }
  addEventListener(event, handler) { this.events[event] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll() { return []; }
}

function sidebar() {
  const elements = new Map();
  const storage = new Map();
  const document = {
    hidden: false,
    body: new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() { return new Element(); },
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    CodexProjectView: require('../public/project-view'),
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {},
    history: {}, URL, console,
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const bootstrap = source.indexOf('\nloadTheme();');
  assert.ok(bootstrap > 0);
  /* Run the actual page code with a small in-memory DOM, without starting its
     network connections or timers. Events exercise the production handlers. */
  vm.runInContext(source.slice(0, bootstrap), context, { filename: 'app.js' });
  const state = vm.runInContext('state', context);
  state.connected = true;
  state.models = [{ model: 'example' }];
  state.projects = [
    { id: 'web', name: 'Website', roots: [{ path: '/work/site' }] },
    { id: 'idle', name: 'Idle project', roots: [{ path: '/work/idle' }] },
  ];
  state.threads = [
    { id: 'one', name: 'First task', cwd: '/work/site', updatedAt: 100, status: { type: 'idle' } },
    { id: 'two', name: 'Second task', cwd: '/work/site', updatedAt: 200, status: { type: 'idle' } },
  ];
  const workingButtons = () => elements.get('working-projects-list').children.map((item) => item.children[0]);
  return { context, state, elements, workingButtons };
}

test('sidebar events update working projects, approvals, completion, and collapsed group counts', () => {
  const { context, state, elements, workingButtons } = sidebar();
  state.collapsedGroups = ['project:web'];
  context.renderList();
  assert.equal(elements.get('working-projects-count').textContent, '0');

  context.handleNotification('turn/started', { threadId: 'one', turn: { id: 'first-turn' } });
  context.handleNotification('turn/started', { threadId: 'two', turn: { id: 'second-turn' } });
  assert.equal(elements.get('working-projects-count').textContent, '1');
  assert.equal(workingButtons().length, 1);
  assert.match(workingButtons()[0].innerHTML, /Website.*2 进行中/);
  assert.ok(elements.get('thread-list').children.some((head) => head.className?.includes('collapsed') &&
    head.children.some((badge) => badge.className === 'group-working' && badge.textContent === '2 进行中')));

  context.handleEvent({ type: 'approval', request: { requestId: 'approval', params: { threadId: 'two' } } });
  assert.equal(workingButtons()[0].children[0].textContent, '1 待审批');
  context.handleEvent({ type: 'approval-resolved', requestId: 'approval' });
  assert.equal(workingButtons()[0].children.length, 0);

  context.handleNotification('turn/completed', { threadId: 'one', turn: { id: 'first-turn', status: 'completed' } });
  assert.match(workingButtons()[0].innerHTML, /1 进行中/);
  context.handleNotification('turn/completed', { threadId: 'two', turn: { id: 'second-turn', status: 'interrupted' } });
  assert.equal(workingButtons().length, 0);
  assert.equal(elements.get('working-projects-empty').hidden, false);
  assert.equal(elements.get('working-projects-empty').textContent, '暂无正在工作的项目');
});

test('working project shortcuts survive search and reconnect and open the most recent active chat', () => {
  const { context, state, elements, workingButtons } = sidebar();
  context.handleEvent({ type: 'hello', connected: true, activeTurns: { one: 'turn-one', two: 'turn-two' } });
  state.threadQuery = 'no results';
  context.renderList();
  assert.equal(elements.get('list-empty').hidden, false);
  assert.equal(workingButtons().length, 1);

  let opened;
  context.openThread = (id) => { opened = id; };
  workingButtons()[0].events.click();
  assert.equal(opened, 'two');

  context.handleEvent({ type: 'status', connected: false });
  assert.equal(workingButtons().length, 0);
  assert.equal(elements.get('working-projects-empty').textContent, '连接后显示工作项目');
  context.handleEvent({ type: 'hello', connected: true, activeTurns: { one: 'turn-one' } });
  assert.equal(workingButtons().length, 1);
  assert.match(workingButtons()[0].innerHTML, /1 进行中/);
});

test('a delayed sidebar response cannot revive a completed project', async () => {
  const { context, state, workingButtons } = sidebar();
  context.handleNotification('turn/started', { threadId: 'one', turn: { id: 'turn-one' } });
  const staleThreads = structuredClone(state.threads);
  let respond;
  context.fetch = async () => new Promise((resolve) => {
    respond = () => resolve({ ok: true, json: async () => ({ data: staleThreads, nextCursor: null }) });
  });
  const loading = context.loadThreads();
  context.handleNotification('turn/completed', { threadId: 'one', turn: { id: 'turn-one', status: 'completed' } });
  assert.equal(workingButtons().length, 0);
  respond();
  await loading;
  assert.equal(workingButtons().length, 0);
  assert.equal(state.threads.find((thread) => thread.id === 'one').status.type, 'idle');
});

test('project groups and working shortcuts keep their positions as different chats update', () => {
  const { context, state, elements, workingButtons } = sidebar();
  state.collapsedGroups = ['project:web', 'project:idle'];
  state.threads.push({ id: 'three', name: 'Another project task', cwd: '/work/idle', updatedAt: 300,
    status: { type: 'idle' } });
  const projectNames = () => elements.get('thread-list').children
    .filter((head) => head.className?.includes('group-head'))
    .map((head) => /group-name">([^<]+)/.exec(head.innerHTML)[1]);
  const workingNames = () => workingButtons().map((button) => /working-project-name">([^<]+)/.exec(button.innerHTML)[1]);
  context.renderList();
  assert.deepEqual(projectNames(), ['Website', 'Idle project']);
  context.handleNotification('turn/started', { threadId: 'one', turn: { id: 'turn-one' } });
  context.handleNotification('turn/started', { threadId: 'three', turn: { id: 'turn-three' } });
  for (const [id, updatedAt] of [['one', 900], ['three', 1000], ['one', 1100]]) {
    state.threads.find((thread) => thread.id === id).updatedAt = updatedAt;
    context.renderList();
    assert.deepEqual(projectNames(), ['Website', 'Idle project']);
    assert.deepEqual(workingNames(), ['Website', 'Idle project']);
  }
  context.handleNotification('turn/completed', { threadId: 'one', turn: { id: 'turn-one', status: 'completed' } });
  assert.deepEqual(projectNames(), ['Website', 'Idle project']);
  assert.deepEqual(workingNames(), ['Idle project']);
});

test('background conversation updates retain both sidebar scroll positions', () => {
  const { context, state, elements } = sidebar();
  context.renderList();
  elements.get('thread-list').scrollTop = 180;
  elements.get('working-projects-list').scrollTop = 40;
  context.handleNotification('turn/started', { threadId: 'one', turn: { id: 'turn-one' } });
  assert.equal(elements.get('thread-list').scrollTop, 180);
  assert.equal(elements.get('working-projects-list').scrollTop, 40);
  state.threadQuery = 'task';
  context.renderList();
  assert.equal(elements.get('thread-list').scrollTop, 180);
});

test('concurrent image batches share the six-image limit', async () => {
  const { context, state, elements } = sidebar();
  state.currentThreadId = 'one';
  context.fileToDataUrl = async (file) => 'data:image/png;base64,' + file.name;
  context.downscaleDataUrl = async (dataUrl) => dataUrl;
  const files = Array.from({ length: 8 }, (_, index) => ({ name: 'image-' + index, type: 'image/png' }));
  await Promise.all([context.handleAttachFiles(files.slice(0, 4)), context.handleAttachFiles(files.slice(4))]);
  assert.equal(state.attachments.length, 6);
  assert.deepEqual(Array.from(state.attachments, (image) => image.name), files.slice(0, 6).map((file) => file.name));
  assert.match(elements.get('toast').textContent, /最多一次 6 张图片/);
});

test('switching away and back cancels an image still being read', async () => {
  const { context, state } = sidebar();
  state.currentThreadId = 'one';
  let finishReading;
  let beganReading;
  const reading = new Promise((resolve) => { beganReading = resolve; });
  context.fileToDataUrl = () => new Promise((resolve) => { finishReading = resolve; beganReading(); });
  context.downscaleDataUrl = async (dataUrl) => dataUrl;
  const importing = context.handleAttachFiles([{ name: 'slow.png', type: 'image/png' }]);
  await reading;
  context.saveDraft('one');
  state.currentThreadId = 'two';
  context.restoreDraft('two');
  state.currentThreadId = 'one';
  context.restoreDraft('one');
  finishReading('data:image/png;base64,example');
  await importing;
  assert.equal(state.attachments.length, 0);
  assert.equal(state.drafts.get('one').attachments.length, 0);
});
