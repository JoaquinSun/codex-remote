'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Bridge, parseArguments } = require('../src/server');
const { loadModelMap } = require('../src/models');

const MODELS = [
  { id: 'example-fast', model: 'example-fast', displayName: 'Fast', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
  { id: 'example-deep', model: 'example-deep', displayName: 'Deep', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
];

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-bridge-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bridge = Object.assign(Object.create(Bridge.prototype), {
    options: { modelFile: path.join(directory, 'models.json') },
    models: Object.create(null), modelCatalog: null, modelCatalogPromise: null,
    permissions: {}, threadSettings: new Map(), activeTurns: new Map(), loadedThreads: new Map(),
    ephemeralThreads: new Map(), stoppedTurns: new Set(), daemonTurnIds: new Set(),
    rollout: { states: new Map() }, calls: [], events: [],
    _broadcast(event) { this.events.push(event); },
  });
  bridge.connection = { ready: true, request: async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'model/list') return { data: MODELS, nextCursor: null };
    if (method === 'thread/resume') return { model: params.model || 'example-fast', reasoningEffort: params.config?.model_reasoning_effort || 'low' };
    if (method === 'turn/start') return { turn: { id: 'turn-new', status: 'inProgress', items: [] } };
    throw new Error('unexpected method: ' + method);
  } };
  return { bridge, directory };
}

async function api(bridge, endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  let status;
  let payload;
  const response = {
    writeHead(code) { status = code; },
    end(data) { payload = JSON.parse(data.toString()); },
  };
  await bridge._handleApi(request, response, new URL(endpoint, 'http://localhost'));
  return { status, body: payload };
}

test('model selector API reads all catalog pages and caches consecutive reads', async (t) => {
  const { bridge } = harness(t);
  bridge.connection.request = async (method, params) => {
    bridge.calls.push({ method, params });
    return params.cursor ? { data: [MODELS[1]], nextCursor: null } : { data: [MODELS[0]], nextCursor: 'next' };
  };
  const first = await api(bridge, '/api/models');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data.map((entry) => entry.model), ['example-fast', 'example-deep']);
  await api(bridge, '/api/models');
  assert.equal(bridge.calls.length, 2);
  assert.equal(bridge.calls[0].params.includeHidden, false);
  await api(bridge, '/api/models?refresh=1');
  assert.equal(bridge.calls.length, 4);
});

test('bridge metadata exposes the listener separately from the machine hostname', async (t) => {
  const { bridge } = harness(t);
  bridge.options.host = '127.0.0.1';
  const result = await api(bridge, '/api/meta');
  assert.equal(result.status, 200);
  assert.equal(result.body.listenHost, '127.0.0.1');
  assert.equal(typeof result.body.hostname, 'string');
  bridge.options.host = '0.0.0.0';
  assert.equal((await api(bridge, '/api/meta')).body.listenHost, '0.0.0.0');
});

test('usage endpoint returns the sanitized bridge snapshot without requiring a thread', async (t) => {
  const { bridge } = harness(t);
  let forced = false;
  bridge._readUsageSnapshot = async (refresh) => {
    forced = refresh;
    return {
      fetchedAt: 1_800_000_000_000,
      codex: {
        available: true,
        limits: [{
          limitId: 'codex',
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: null,
        }],
        resetCredits: null,
      },
      ccSwitch: {
        available: true,
        period: 'today',
        summary: { requests: 2, realTotalTokens: 4096, totalCostUsd: 0.12 },
        apps: [{ appType: 'codex', requests: 2, realTotalTokens: 4096, totalCostUsd: 0.12 }],
      },
    };
  };
  const result = await api(bridge, '/api/usage?refresh=1');
  assert.equal(result.status, 200);
  assert.equal(forced, true);
  assert.equal(result.body.codex.limits[0].primary.usedPercent, 20);
  assert.equal(result.body.ccSwitch.summary.realTotalTokens, 4096);
});

test('changing a running session saves a next-turn choice without resuming or interrupting', async (t) => {
  const { bridge } = harness(t);
  bridge.activeTurns.set('chat', 'desktop-turn');
  bridge.threadSettings.set('chat', { model: 'example-fast', effort: 'low' });
  const result = await api(bridge, '/api/threads/chat/model', { model: 'example-deep', reasoningEffort: 'high' });
  assert.equal(result.status, 200);
  assert.equal(result.body.modelSelection.model, 'example-deep');
  assert.equal(result.body.modelSelection.effective.model, 'example-fast');
  assert.equal(bridge.activeTurns.get('chat'), 'desktop-turn');
  assert.deepEqual(bridge.calls.map((call) => call.method), ['model/list']);
  assert.equal(loadModelMap(bridge.options.modelFile).chat.model, 'example-deep');
  assert.equal(bridge.events[0].type, 'model');
});

test('new turns send model, effort, and permissions together', async (t) => {
  const { bridge } = harness(t);
  bridge.models.chat = { model: 'example-deep', reasoningEffort: 'high' };
  bridge.permissions.chat = 'ask';
  const result = await bridge._deliverMessage('chat', 'Do the work', [], {});
  assert.equal(result.mode, 'started');
  const resume = bridge.calls.find((call) => call.method === 'thread/resume').params;
  const turn = bridge.calls.find((call) => call.method === 'turn/start').params;
  assert.equal(resume.model, 'example-deep');
  assert.equal(resume.config.model_reasoning_effort, 'high');
  assert.equal(resume.approvalPolicy, 'on-request');
  assert.equal(turn.model, 'example-deep');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.sandboxPolicy.type, 'workspaceWrite');
});

test('follow desktop clears persisted overrides and the next message sends no model settings', async (t) => {
  const { bridge } = harness(t);
  bridge._setModel('chat', { model: 'example-deep', reasoningEffort: 'high' });
  const result = await api(bridge, '/api/threads/chat/model', { model: null });
  assert.equal(result.status, 200);
  assert.equal(result.body.modelSelection.model, null);
  assert.equal(loadModelMap(bridge.options.modelFile).chat, undefined);
  bridge.calls = [];
  await bridge._deliverMessage('chat', 'hello', [], {});
  for (const call of bridge.calls) {
    assert.ok(!Object.hasOwn(call.params, 'model'));
    assert.ok(!Object.hasOwn(call.params, 'effort'));
    assert.ok(!Object.hasOwn(call.params, 'config'));
  }
});

test('steering never applies pending model changes to the active turn', async (t) => {
  const { bridge } = harness(t);
  bridge.models.chat = { model: 'example-deep', reasoningEffort: 'high' };
  bridge.activeTurns.set('chat', 'running-turn');
  bridge.connection.request = async (method, params) => {
    bridge.calls.push({ method, params });
    return { turnId: 'running-turn' };
  };
  const result = await bridge._deliverMessage('chat', 'Adjust this work', [], { steer: true });
  assert.equal(result.mode, 'steered');
  assert.deepEqual(bridge.calls, [{ method: 'turn/steer', params: {
    threadId: 'chat', expectedTurnId: 'running-turn', input: [{ type: 'text', text: 'Adjust this work', text_elements: [] }],
  } }]);
});

test('native queued input inherits session settings while pending choices remain saved', async (t) => {
  const { bridge } = harness(t);
  bridge.models.chat = { model: 'example-deep', reasoningEffort: 'high' };
  bridge.permissions.chat = 'ask';
  bridge.connection.request = async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'thread/queue/add') {
      return { queuedSubmission: { id: 'queue-1' } };
    }
    throw new Error('already has an active writer');
  };
  const result = await bridge._deliverMessage('chat', 'Do work later', [], {});
  assert.equal(result.mode, 'queued');
  const queued = bridge.calls.find(call => call.method === 'thread/queue/add').params;
  assert.deepEqual(queued.input, [{ type: 'text', text: 'Do work later', text_elements: [] }]);
  assert.equal(queued.model, undefined);
  assert.equal(queued.approvalPolicy, undefined);
  assert.equal(bridge.models.chat.model, 'example-deep');
});

test('ephemeral model settings stay in memory and skip resume on delivery', async (t) => {
  const { bridge } = harness(t);
  bridge.ephemeralThreads.set('temporary', { id: 'temporary' });
  bridge._setModel('temporary', { model: 'example-deep', reasoningEffort: 'high' });
  bridge._setModel('saved', { model: 'example-fast', reasoningEffort: 'low' });
  assert.equal(loadModelMap(bridge.options.modelFile).temporary, undefined);
  await bridge._deliverMessage('temporary', 'hello', [], {});
  assert.deepEqual(bridge.calls.map((call) => call.method), ['turn/start']);
  assert.equal(bridge.calls[0].params.model, 'example-deep');
});

test('metadata and desktop setting updates refresh the effective model while preserving the pending choice', async (t) => {
  const { bridge } = harness(t);
  bridge.models.chat = { model: 'example-deep', reasoningEffort: 'high' };
  bridge._recordThreadSettings('chat', { thread: { model: 'example-fast', reasoningEffort: 'low' } });
  bridge._handleNotification({ method: 'thread/settings/updated', params: {
    threadId: 'chat', threadSettings: { model: 'example-fast', effort: 'high' },
  } });
  const view = bridge._modelView('chat');
  assert.equal(view.model, 'example-deep');
  assert.deepEqual(view.effective, { model: 'example-fast', reasoningEffort: 'high' });
  assert.ok(bridge.events.some((event) => event.type === 'model' && event.modelSelection.effective.reasoningEffort === 'high'));
});

test('model settings cache does not retain full thread history from legacy reads', (t) => {
  const { bridge } = harness(t);
  bridge._recordThreadSettings('chat', {
    thread: { model: 'example-fast', reasoningEffort: 'high', turns: [{ items: [{ text: 'large history'.repeat(10000) }] }] },
    approvalPolicy: 'on-request',
  });
  const settings = bridge.threadSettings.get('chat');
  assert.equal(settings.model, 'example-fast');
  assert.equal(settings.effort, 'high');
  assert.equal(settings.approvalPolicy, 'on-request');
  assert.equal(settings.thread, undefined);
  assert.ok(JSON.stringify(settings).length < 200);
});

test('reading model metadata alone does not invent an effective permission profile', (t) => {
  const { bridge } = harness(t);
  bridge.permissions.chat = 'full';
  bridge._recordThreadSettings('chat', { thread: { model: 'example-fast', reasoningEffort: 'high' } });
  assert.deepEqual(bridge._permissionView('chat'), { mode: 'full', effective: null });
  bridge._recordThreadSettings('chat', { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' });
  assert.equal(bridge._permissionView('chat').effective.mode, 'ask');
});

test('new chat applies the chosen model before the first turn and saves it for later messages', async (t) => {
  const { bridge, directory } = harness(t);
  bridge.releaseThreadLock = async () => true;
  bridge.connection.request = async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'model/list') return { data: MODELS, nextCursor: null };
    if (method === 'thread/start') return { thread: { id: 'new-chat', cwd: params.cwd, model: params.model }, model: params.model, reasoningEffort: params.config.model_reasoning_effort };
    if (method === 'thread/name/set') return {};
    throw new Error('unexpected method: ' + method);
  };
  const result = await api(bridge, '/api/new-thread', { cwd: directory, model: 'example-deep', reasoningEffort: 'high' });
  assert.equal(result.status, 200);
  const created = bridge.calls.find(call => call.method === 'thread/start');
  assert.equal(created.params.model, 'example-deep');
  assert.equal(created.params.historyMode, 'paginated');
  assert.equal(created.params.config.model_reasoning_effort, 'high');
  assert.equal(loadModelMap(bridge.options.modelFile)['new-chat'].model, 'example-deep');
  assert.equal(bridge._modelView('new-chat').effective.reasoningEffort, 'high');
});

test('a persistent chat with no supplied name survives handoff and a new data connection', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { bridge, directory } = harness(t);
  const thread = { id: 'empty-chat', cwd: directory, name: null };
  let indexed;
  let subscribed = true;
  bridge.connection.request = async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'thread/start') {
      assert.equal(params.historyMode, 'paginated');
      return { thread };
    }
    if (method === 'thread/turns/list') {
      if (!indexed) throw new Error('thread empty-chat is not materialized yet; thread/turns/list is unavailable before first user message');
      return { data: [] };
    }
    if (method === 'thread/name/set') {
      indexed = Object.assign({}, thread, { name: params.name });
      return {};
    }
    if (method === 'thread/unsubscribe') {
      subscribed = false;
      return { status: 'unsubscribed' };
    }
    if (method === 'thread/read') {
      assert.equal(subscribed, false);
      if (!indexed) throw new Error('thread not loaded: empty-chat');
      return { thread: indexed };
    }
    throw new Error('unexpected method: ' + method);
  };
  const created = await api(bridge, '/api/new-thread', { cwd: directory });
  assert.equal(created.status, 200);
  assert.equal(created.body.thread.id, 'empty-chat');
  assert.equal(created.body.thread.name, '新对话');
  assert.equal(bridge.loadedThreads.has('empty-chat'), false);
  assert.deepEqual(bridge.calls.map(call => call.method), ['thread/start', 'thread/name/set', 'thread/turns/list', 'thread/unsubscribe']);
  /* A restarted bridge has no loaded-thread or settings cache to fall back on. */
  const { bridge: restarted } = harness(t);
  restarted.connection.request = bridge.connection.request;
  const opened = await api(restarted, '/api/threads/empty-chat');
  assert.equal(opened.status, 200);
  assert.equal(opened.body.thread.cwd, directory);
  assert.deepEqual(opened.body.thread.turns, []);
  assert.equal(opened.body.hasMore, false);
  assert.equal(opened.body.running, false);
  for (const suffix of ['', '?light=1']) {
    const live = await api(restarted, '/api/threads/empty-chat/live' + suffix);
    assert.equal(live.status, 200);
    assert.equal(live.body.turn, null);
    assert.equal(live.body.error, null);
    assert.equal(live.body.running, false);
  }
});

test('unmaterialized paginated metadata opens with empty history and no live error', async (t) => {
  const { bridge } = harness(t);
  bridge.connection.request = async (method) => {
    if (method === 'thread/read') return { thread: { id: 'empty-chat', cwd: '/tmp', name: null } };
    throw new Error('thread empty-chat is not materialized yet; thread/turns/list is unavailable before first user message');
  };
  const opened = await api(bridge, '/api/threads/empty-chat');
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.thread.turns, []);
  assert.equal(opened.body.hasMore, false);
  const live = await api(bridge, '/api/threads/empty-chat/live');
  assert.equal(live.status, 200);
  assert.equal(live.body.turn, null);
  assert.equal(live.body.error, null);
});

test('an unconfirmed persistent name cannot report creation success or release its writer', async (t) => {
  const { bridge, directory } = harness(t);
  bridge.connection.request = async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'empty-chat', cwd: directory } };
    throw Object.assign(new Error('thread/name/set timed out after 60000ms'), { timedOut: true });
  };
  const created = await api(bridge, '/api/new-thread', { cwd: directory });
  assert.equal(created.status, 502);
  assert.match(created.body.error, /建档未确认/);
  assert.equal(bridge.loadedThreads.has('empty-chat'), true);
  assert.deepEqual(bridge.calls.map(call => call.method), ['thread/start', 'thread/name/set']);
});

test('new ephemeral chats retain their in-memory history and subscription', async (t) => {
  const { bridge, directory } = harness(t);
  bridge.connection.request = async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'temporary', cwd: params.cwd } };
    throw new Error('unexpected method: ' + method);
  };
  assert.equal((await api(bridge, '/api/new-thread', { cwd: directory, ephemeral: true })).status, 200);
  assert.deepEqual(bridge.calls.map(call => call.method), ['thread/start']);
  assert.equal(bridge.calls[0].params.ephemeral, true);
  assert.equal(bridge.calls[0].params.historyMode, undefined);
  assert.equal(bridge.ephemeralThreads.has('temporary'), true);
  assert.equal(bridge.loadedThreads.has('temporary'), true);
});

test('empty-history handling preserves real missing-thread and history-service errors', async (t) => {
  for (const failure of ['thread not loaded: missing', 'history service unavailable']) {
    const { bridge } = harness(t);
    bridge.connection.request = async (method) => {
      if (method === 'thread/read' && failure === 'history service unavailable') return { thread: { id: 'missing' } };
      throw new Error(failure);
    };
    const read = await api(bridge, '/api/threads/missing');
    assert.equal(read.status, 500);
    assert.equal(read.body.error, failure);
    await assert.rejects(bridge._latestTurn('missing'), error => error.message === failure);
  }
});

test('an empty-history error cannot invent metadata when thread/read itself fails', async (t) => {
  const { bridge } = harness(t);
  const failure = new Error('thread missing is not materialized yet; thread/turns/list is unavailable before first user message');
  bridge.connection.request = async () => { throw failure; };
  await assert.rejects(bridge._readThreadWindow('missing', 10), error => error === failure);
});

test('legacy history reads still work when pagination is explicitly unsupported', async (t) => {
  const { bridge } = harness(t);
  const turn = { id: 'old-turn', status: 'completed', items: [] };
  bridge.connection.request = async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'thread/turns/list') throw new Error('method not found');
    if (method === 'thread/read') return { thread: { id: 'legacy', turns: params.includeTurns ? [turn] : [] } };
    throw new Error('unexpected method: ' + method);
  };
  const result = await bridge._readThreadWindow('legacy', 10);
  assert.equal(result.windowed, false);
  assert.deepEqual(result.thread.turns, [turn]);
  assert.equal(result.thread.hasMoreTurns, false);
  assert.deepEqual(bridge.calls.map(call => call.method), ['thread/read', 'thread/turns/list', 'thread/read']);
});

test('invalid model or effort returns 400 and cannot replace the saved choice', async (t) => {
  const { bridge } = harness(t);
  bridge._setModel('chat', { model: 'example-fast', reasoningEffort: 'low' });
  for (const choice of [{ model: 'missing' }, { model: 'example-fast', reasoningEffort: 'ultra' }]) {
    assert.equal((await api(bridge, '/api/threads/chat/model', choice)).status, 400);
  }
  assert.equal(bridge.models.chat.model, 'example-fast');
});

test('a failed disk write returns an error and leaves the prior choice intact', async (t) => {
  const { bridge, directory } = harness(t);
  bridge.models.chat = { model: 'example-fast', reasoningEffort: 'low' };
  const blocked = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocked, 'file');
  bridge.options.modelFile = path.join(blocked, 'models.json');
  const result = await api(bridge, '/api/threads/chat/model', { model: 'example-deep' });
  assert.equal(result.status, 500);
  assert.equal(bridge.models.chat.model, 'example-fast');
});

test('model preferences file can be isolated when running a separate bridge', () => {
  assert.equal(parseArguments(['--model-file', '/tmp/model-settings.json']).modelFile, '/tmp/model-settings.json');
});
