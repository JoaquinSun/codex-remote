'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.nodes = new Map();
    this.details = [];
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 100;
    this.open = false;
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    };
  }
  set innerHTML(value) { this.html = value; }
  get innerHTML() { return this.html || ''; }
  querySelector(selector) { return this.nodes.get(selector) || null; }
  querySelectorAll(selector) {
    return selector === 'details[open][data-item-id]' ? this.details.filter((item) => item.open) : [];
  }
  getAttribute(name) { return this.attributes[name] || null; }
  addEventListener() {}
}

function chat(items, status = 'inProgress') {
  const elements = new Map();
  const document = {
    hidden: false,
    body: new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    addEventListener() {},
  };
  const css = { escape: (value) => value };
  const context = vm.createContext({
    document,
    window: { CSS: css, addEventListener() {}, matchMedia: () => ({ matches: false }) },
    CSS: css,
    localStorage: { getItem: () => null, setItem() {} },
    CodexChatView: require('../public/chat-view'),
    CodexProjectView: require('../public/project-view'),
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {},
    history: {}, URL, console,
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const bootstrap = source.indexOf('\nloadTheme();');
  assert.ok(bootstrap > 0);
  /* Exercise the production renderer and streaming handlers with in-memory
     nodes, without opening a browser or starting network connections. */
  vm.runInContext(source.slice(0, bootstrap), context, { filename: 'app.js' });
  const state = vm.runInContext('state', context);
  state.currentThreadId = 'chat';
  state.thread = { id: 'chat', cwd: '/work/project' };
  state.turns = [{ id: 'turn', status, items }];
  if (status === 'inProgress') state.activeTurns.chat = 'turn';
  const turns = elements.get('turns');

  function mountActivity(id) {
    const details = new Element();
    const summary = new Element();
    const body = new Element();
    details.dataset.activityId = id;
    details.attributes['data-item-id'] = id;
    details.nodes.set('summary', summary);
    details.nodes.set('.activity-body', body);
    summary.innerHTML = context.renderActivitySummary(state.activityGroups.get(id));
    turns.nodes.set('[data-activity-id="' + id + '"]', details);
    turns.nodes.set('details[data-item-id="' + id + '"]', details);
    turns.details.push(details);
    return { details, summary, body };
  }

  function mountText(id, type = 'agentMessage') {
    const root = new Element();
    const body = new Element();
    root.nodes.set(type === 'reasoning' ? '.reasoning-body' : '.md', body);
    turns.nodes.set('[data-item-id="' + id + '"]', root);
    return body;
  }

  return { context, state, turns, mountActivity, mountText };
}

function item(type, id, extra = {}) { return { type, id, ...extra }; }

test('long tool sequences fold into compact rows while all text and plans remain visible in order', () => {
  const commands = Array.from({ length: 71 }, (_, index) => item('commandExecution', 'command-' + index, {
    status: 'completed', exitCode: index === 0 ? 1 : 0,
    command: 'hidden-command-' + index, aggregatedOutput: 'hidden-output-' + index,
  }));
  const { context, state, turns } = chat([
    item('userMessage', 'user', { content: [{ type: 'text', text: 'Please investigate' }] }),
    item('agentMessage', 'progress', { phase: 'commentary', text: 'I will inspect the project first.' }),
    item('reasoning', 'thought', { summary: ['The source needs a closer look.'] }),
    ...commands,
    item('fileChange', 'files', { status: 'completed', changes: [{ path: 'app.js', diff: 'hidden-diff' }] }),
    item('mcpToolCall', 'tool', { status: 'completed', result: 'hidden-tool-result' }),
    item('functionCallOutput', 'output', { text: 'hidden-tool-output-text' }),
    item('agentMessage', 'next-progress', { phase: 'commentary', text: 'The issue is in the renderer.' }),
    item('commandExecution', 'verification', { status: 'inProgress', command: 'hidden-test-command' }),
    item('agentMessage', 'answer', { phase: 'partial_answer', text: 'The text now stays visible.' }),
  ]);
  state.planSteps.set('turn', [{ step: 'Verify the message order', status: 'inProgress' }]);
  context.renderThread();
  const html = turns.innerHTML;
  assert.equal((html.match(/data-activity-id=/g) || []).length, 2);
  assert.equal((html.match(/<div class="activity-body"><\/div>/g) || []).length, 2);
  assert.ok(!/<details class="activity"[^>]*\sopen(?:\s|>)/.test(html));
  assert.match(html, /71 次执行 · 1 个文件 · 2 次工具调用 · 1 个步骤失败/);
  assert.ok(!/hidden-(?:command|output|diff|tool|test)/.test(html));
  const markers = [
    'Please investigate', 'I will inspect the project first.', 'The source needs a closer look.',
    'data-activity-id="activity-turn-command-0"', 'The issue is in the renderer.',
    'data-activity-id="activity-turn-verification"', 'Verify the message order', 'The text now stays visible.',
  ];
  let previous = -1;
  for (const marker of markers) {
    const position = html.indexOf(marker);
    assert.ok(position > previous, 'Expected visible chronological marker: ' + marker);
    previous = position;
  }
  for (const id of ['progress', 'thought', 'next-progress', 'answer']) {
    assert.equal(state.activityItems.has(id), false);
  }
});

test('commentary and reasoning deltas stay visible while terminal output accumulates in a folded group', () => {
  const { context, state, turns, mountActivity, mountText } = chat([
    item('agentMessage', 'progress', { phase: 'commentary', text: 'Visible progress: ' }),
    item('reasoning', 'thought', { summary: ['Visible reasoning: '] }),
    item('commandExecution', 'command', { status: 'inProgress', command: 'hidden-command' }),
  ]);
  context.renderThread();
  const activity = mountActivity('activity-turn-command');
  const progress = mountText('progress');
  const thought = mountText('thought', 'reasoning');
  const tail = 'full update '.repeat(30) + 'including the final words';
  context.handleNotification('item/agentMessage/delta', { threadId: 'chat', itemId: 'progress', delta: tail });
  context.flushItemDelta(state.turns[0].items[0]);
  assert.match(progress.innerHTML, /Visible progress:/);
  assert.ok(progress.innerHTML.includes(tail));
  context.handleNotification('item/reasoning/summaryTextDelta', {
    threadId: 'chat', itemId: 'thought', summaryIndex: 0, delta: 'the complete reasoning text',
  });
  context.flushItemDelta(state.turns[0].items[1]);
  assert.match(thought.innerHTML, /Visible reasoning: the complete reasoning text/);

  context.handleNotification('item/commandExecution/outputDelta', {
    threadId: 'chat', itemId: 'command', delta: 'hidden-terminal-output',
  });
  context.flushItemDelta(state.turns[0].items[2]);
  assert.equal(state.turns[0].items[2].aggregatedOutput, 'hidden-terminal-output');
  assert.equal(activity.details.open, false);
  assert.equal(activity.body.innerHTML, '');
  assert.match(activity.summary.innerHTML, /正在执行命令/);
  assert.equal(state.renderScheduled, false);
  assert.ok(!turns.innerHTML.includes('hidden-terminal-output'));
});

test('opening tool history loads only tool details and preserves the user choice through live renders', () => {
  const { context, state, turns, mountActivity } = chat([
    item('agentMessage', 'progress', { phase: 'commentary', text: 'Readable progress remains outside.' }),
    item('commandExecution', 'command', {
      status: 'inProgress', command: 'inspect-project', aggregatedOutput: 'first output',
    }),
    item('mcpToolCall', 'tool', { status: 'completed', result: 'tool-result' }),
    item('agentMessage', 'follow-up', { text: 'Readable follow-up remains outside.' }),
  ]);
  state.planSteps.set('turn', [{ step: 'Visible checklist', status: 'inProgress' }]);
  context.renderThread();
  const activity = mountActivity('activity-turn-command');
  activity.details.open = true;
  context.hydrateActivity(activity.details);
  assert.equal(activity.details.dataset.hydrated, 'true');
  assert.match(activity.body.innerHTML, /inspect-project/);
  assert.match(activity.body.innerHTML, /first output/);
  assert.match(activity.body.innerHTML, /tool-result/);
  assert.ok(!/Readable|Visible checklist/.test(activity.body.innerHTML));

  state.turns[0].items[1].aggregatedOutput += '\nlatest output';
  state.turns[0].items[1].status = 'completed';
  context.renderThread();
  assert.match(turns.innerHTML, /data-activity-id="activity-turn-command" open data-hydrated="true"/);
  assert.match(turns.innerHTML, /latest output/);
  assert.match(turns.innerHTML, /Readable progress remains outside/);
  assert.match(turns.innerHTML, /Visible checklist/);
  assert.ok(!turns.innerHTML.includes('正在处理'));

  activity.details.open = false;
  context.renderThread();
  assert.ok(!/<details class="activity"[^>]*\sopen(?:\s|>)/.test(turns.innerHTML));
  assert.ok(!/inspect-project|latest output|tool-result/.test(turns.innerHTML));
  assert.match(turns.innerHTML, /Readable follow-up remains outside/);
});

test('a text-only turn displays its plan without creating an empty folded execution group', () => {
  const { context, state, turns } = chat([
    item('userMessage', 'user', { content: [{ type: 'text', text: 'Make a plan' }] }),
    item('agentMessage', 'progress', { phase: 'commentary', text: 'Here is the approach.' }),
    item('reasoning', 'thought', { content: ['A readable explanation.'] }),
    item('agentMessage', 'answer', { phase: 'final_answer', text: 'Ready to proceed.' }),
  ], 'completed');
  state.planSteps.set('turn', [{ step: 'Keep all text visible', status: 'completed' }]);
  context.renderThread();
  assert.match(turns.innerHTML, /Keep all text visible/);
  assert.match(turns.innerHTML, /Here is the approach/);
  assert.match(turns.innerHTML, /A readable explanation/);
  assert.match(turns.innerHTML, /Ready to proceed/);
  assert.ok(!turns.innerHTML.includes('<details'));
  assert.equal(state.activityGroups.size, 0);
});
