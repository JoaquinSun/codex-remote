'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { DesktopConnection, applyStatePatches } = require('../src/desktop');
const { Bridge } = require('../src/server');

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const result = Buffer.alloc(4 + payload.length);
  result.writeUInt32LE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

function ipc() {
  const connection = new DesktopConnection();
  const sent = [];
  connection.ready = true;
  connection.clientId = 'mobile-client';
  connection.socket = { writable: true, destroyed: false, write(data) {
    sent.push(JSON.parse(data.subarray(4).toString()));
  } };
  return { connection, sent };
}

function reply(connection, request, result, error) {
  connection._receive(frame({ type: 'response', requestId: request.requestId,
    method: request.method, handledByClientId: 'desktop-owner',
    resultType: error ? 'error' : 'success', result, error }));
}

test('desktop IPC correlates out-of-order replies across fragmented UTF-8 frames', async () => {
  const { connection, sent } = ipc();
  const one = connection.request('thread-follower-read-model-settings', { conversationId: 'first' });
  const two = connection.request('thread-follower-read-model-settings', { conversationId: 'second' });
  const replies = Buffer.concat([frame({ type: 'response', requestId: sent[1].requestId,
    resultType: 'success', result: { name: '第二条 🐱' } }), frame({ type: 'response',
    requestId: sent[0].requestId, resultType: 'success', result: { name: '第一条' } })]);
  for (let offset = 0; offset < replies.length; offset += 3) connection._receive(replies.subarray(offset, offset + 3));
  assert.deepEqual(await one, { name: '第一条' });
  assert.deepEqual(await two, { name: '第二条 🐱' });
  assert.equal(connection.pending.size, 0);
});

test('desktop discovery preserves the owner id and rejects protocol incompatibility', async () => {
  const { connection, sent } = ipc();
  const owner = connection.findOwner('chat');
  await Promise.resolve();
  assert.equal(sent[0].version, 1);
  reply(connection, sent[0], { supportsUntrustedAppInput: true });
  assert.deepEqual(await owner, { supportsUntrustedAppInput: true, clientId: 'desktop-owner' });
  const unsupported = connection.request('thread-follower-start-turn', {});
  reply(connection, sent[1], null, 'request-version-mismatch');
  await assert.rejects(unsupported, /request-version-mismatch/);
  assert.equal(sent.length, 2);
});

test('an absent owner is reported without inventing desktop ownership', async () => {
  const { connection, sent } = ipc();
  const pending = connection.findOwner('chat');
  await Promise.resolve();
  reply(connection, sent[0], null, 'no-client-found');
  assert.equal(await pending, null);
});

test('an existing desktop owner is followed immediately without opening the chat again', async () => {
  const { connection, sent } = ipc();
  let opened = 0;
  connection.openThread = async () => { opened += 1; };
  const pending = connection.ensureOwner('chat');
  await new Promise(setImmediate);
  reply(connection, sent[0], { supportsUntrustedAppInput: true });
  assert.equal((await pending).clientId, 'desktop-owner');
  assert.equal(opened, 0);
  assert.equal(connection.following.get('chat'), 'desktop-owner');
  assert.equal(connection.ownerPromises.size, 0);
});

for (const absence of ['no-client-found', 'probe-timeout']) {
  test('concurrent owner readiness shares one desktop opening after ' + absence, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { connection, sent } = ipc();
    const opened = [];
    connection.openThread = async id => { opened.push(id); };
    const first = connection.ensureOwner('chat');
    const second = connection.ensureOwner('chat');
    assert.equal(first, second);
    await new Promise(setImmediate);
    assert.equal(sent.length, 1);
    if (absence === 'probe-timeout') t.mock.timers.tick(500);
    else reply(connection, sent[0], null, 'no-client-found');
    await new Promise(setImmediate);
    assert.deepEqual(opened, ['chat']);
    t.mock.timers.tick(250);
    await new Promise(setImmediate);
    reply(connection, sent[1], { supportsUntrustedAppInput: true });
    assert.equal((await first).clientId, 'desktop-owner');
    assert.equal((await second).clientId, 'desktop-owner');
    /* A late reply to the abandoned read-only probe cannot change ownership. */
    reply(connection, sent[0], null, 'no-client-found');
    assert.equal(connection.following.get('chat'), 'desktop-owner');
    assert.equal(connection.ownerPromises.size, 0);
    assert.equal(connection.pending.size, 0);
    assert.equal(sent.filter(request => request.method === 'thread-owner-discovery').length, 2);
    assert.equal(sent.filter(request => request.method === 'thread-follower-start-turn').length, 0);
  });
}

test('owner readiness fails within its deadline when the desktop never acquires the chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { connection, sent } = ipc();
  let opened = 0;
  connection.openThread = async () => { opened += 1; };
  const rejected = assert.rejects(connection.ensureOwner('chat'), error => error.statusCode === 409);
  await new Promise(setImmediate);
  for (let elapsed = 0; elapsed < 13000; elapsed += 250) {
    t.mock.timers.tick(250);
    await new Promise(setImmediate);
  }
  await rejected;
  assert.equal(opened, 1);
  assert.equal(connection.pending.size, 0);
  assert.equal(connection.ownerPromises.size, 0);
  assert.ok(sent.length <= 12);
  assert.ok(sent.every(request => request.method === 'thread-owner-discovery'));
});

test('owner readiness propagates protocol errors and allows a later fresh probe', async () => {
  const { connection, sent } = ipc();
  let opened = 0;
  connection.openThread = async () => { opened += 1; };
  const failed = connection.ensureOwner('chat');
  await new Promise(setImmediate);
  reply(connection, sent[0], null, 'request-version-mismatch');
  await assert.rejects(failed, /request-version-mismatch/);
  assert.equal(opened, 0);
  assert.equal(connection.ownerPromises.size, 0);
  const retried = connection.ensureOwner('chat');
  await new Promise(setImmediate);
  reply(connection, sent[1], {});
  assert.equal((await retried).clientId, 'desktop-owner');
  assert.equal(opened, 0);
});

test('a disconnected owner probe rejects without opening or retrying the chat', async () => {
  const { connection, sent } = ipc();
  let opened = 0;
  connection.openThread = async () => { opened += 1; };
  const pending = connection.ensureOwner('chat');
  await new Promise(setImmediate);
  connection._closed(connection.socket);
  await assert.rejects(pending, /操作结果尚未确认/);
  assert.equal(opened, 0);
  assert.equal(sent.length, 1);
  assert.equal(connection.ownerPromises.size, 0);
});

test('short discovery probes do not shorten or retry follower mutation acknowledgements', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { connection, sent } = ipc();
  const rejected = assert.rejects(connection.callThread('chat', 'thread-follower-start-turn', {}, {
    clientId: 'desktop-owner',
  }), error => error.timedOut === true);
  t.mock.timers.tick(1000);
  assert.equal(connection.pending.size, 1);
  t.mock.timers.tick(19000);
  await rejected;
  assert.equal(sent.length, 1);
  assert.equal(connection.pending.size, 0);
});

test('follower calls target the owning desktop window with the required protocol version', async () => {
  const { connection, sent } = ipc();
  const call = connection.callThread('chat', 'thread-follower-interrupt-turn', {
    expectedTurnId: 'turn-1', mode: 'user-stop',
  }, { clientId: 'desktop-owner' });
  assert.equal(sent[0].targetClientId, 'desktop-owner');
  assert.equal(sent[0].version, 4);
  assert.deepEqual(sent[0].params, { conversationId: 'chat', expectedTurnId: 'turn-1', mode: 'user-stop' });
  reply(connection, sent[0], { ok: true, interruptedTurnId: 'turn-1' });
  assert.equal((await call).ok, true);
});

test('interrupt without a locally cached turn uses the desktop current-turn protocol', async () => {
  const { connection, sent } = ipc();
  const call = connection.callThread('chat', 'thread-follower-interrupt-turn', { mode: 'user-stop' }, { clientId: 'owner' });
  assert.equal(sent[0].version, 3);
  assert.equal(sent[0].params.expectedTurnId, undefined);
  reply(connection, sent[0], { ok: true, interruptedTurnId: null });
  assert.equal((await call).ok, true);
});

test('desktop disconnect rejects unconfirmed calls without retrying them', async () => {
  const { connection, sent } = ipc();
  const pending = connection.request('thread-follower-start-turn', {});
  connection._closed(connection.socket);
  await assert.rejects(pending, /操作结果尚未确认/);
  assert.equal(sent.length, 1);
  assert.equal(connection.pending.size, 0);
  assert.equal(connection.ready, false);
});

test('invalid IPC frame lengths are rejected before a payload can be allocated', () => {
  for (const size of [0, 0xffffffff]) {
    const { connection } = ipc();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(size);
    assert.throws(() => connection._receive(header), /frame length/);
  }
});

test('desktop snapshots retain approval/settings data and discard long conversation history', () => {
  const { connection } = ipc();
  connection.follow('chat', 'owner');
  const states = [];
  connection.on('state', (id, state) => states.push({ id, state: structuredClone(state) }));
  const broadcast = (change, sourceClientId = 'owner') => connection._handleMessage({
    type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId,
    params: { hostId: 'local', conversationId: 'chat', change },
  });
  broadcast({ type: 'snapshot', revision: 1, conversationState: {
    id: 'chat', requests: [], latestModel: 'desktop-model', threadRuntimeStatus: { type: 'active' },
    turns: [{ text: 'large history'.repeat(1000) }],
  } });
  assert.equal(connection.states.get('chat').state.turns, undefined);
  broadcast({ type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'add', path: ['turns', 0, 'items', 0], value: 'tool output' },
  ] });
  assert.equal(states.length, 1);
  broadcast({ type: 'patches', baseRevision: 2, revision: 3, patches: [
    { op: 'add', path: ['requests', 0], value: { id: 23, method: 'item/commandExecution/requestApproval' } },
  ] });
  assert.equal(states[1].state.requests[0].id, 23);
  broadcast({ type: 'snapshot', revision: 4, conversationState: { id: 'impostor', requests: [] } }, 'another-owner');
  assert.equal(states.length, 2);
});

test('desktop protocol v13 restores runtime, settings and approval subscriptions', () => {
  const { connection } = ipc();
  connection.follow('chat', 'owner');
  const states = [];
  connection.on('state', (id, state) => states.push(structuredClone(state)));
  const broadcast = change => connection._handleMessage({
    type: 'broadcast', method: 'thread-stream-state-changed', version: 13, sourceClientId: 'owner',
    params: { hostId: 'local', conversationId: 'chat', change },
  });
  broadcast({ type: 'snapshot', revision: 1, conversationState: {
    id: 'chat', requests: [], latestModel: 'desktop-model',
    latestThreadSettings: { model: 'desktop-model' }, threadRuntimeStatus: { type: 'idle' },
    turns: [{ text: 'conversation history' }], turnHistory: { kind: 'canonical' },
    unconfirmedTurnSubmissions: [{ input: [{ type: 'text', text: 'pending text', text_elements: [] }] }],
  } });
  assert.equal(states.length, 1);
  assert.equal(states[0].latestThreadSettings.model, 'desktop-model');
  assert.equal(states[0].threadRuntimeStatus.type, 'idle');
  for (const field of ['turns', 'turnHistory', 'unconfirmedTurnSubmissions']) {
    assert.equal(Object.hasOwn(connection.states.get('chat').state, field), false);
  }
  broadcast({ type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'active' } },
    { op: 'add', path: ['requests', 0], value: { id: 23, method: 'item/commandExecution/requestApproval' } },
    { op: 'add', path: ['turns', 0, 'items', 0], value: 'tool output' },
  ], acceptedTextChanges: [{ text: 'history acknowledgement' }] });
  assert.equal(states.length, 2);
  assert.equal(states[1].threadRuntimeStatus.type, 'active');
  assert.equal(states[1].requests[0].id, 23);
  assert.equal(connection.states.get('chat').revision, 2);
  assert.equal(Object.hasOwn(states[1], 'acceptedTextChanges'), false);
});

test('unsupported desktop stream versions reject state without replacing a verified snapshot', () => {
  const { connection } = ipc();
  connection.follow('chat', 'owner');
  const cached = { revision: 1, state: { id: 'chat', requests: [] } };
  connection.states.set('chat', cached);
  let error;
  let states = 0;
  connection.on('protocolError', value => { error = value; });
  connection.on('state', () => { states++; });
  connection._handleState({ sourceClientId: 'owner', version: 14, params: {
    hostId: 'local', conversationId: 'chat', change: {
      type: 'snapshot', revision: 2, conversationState: { id: 'chat', requests: [{ id: 99 }] },
    },
  } });
  assert.match(error.message, /聊天状态协议已变化/);
  assert.equal(connection.states.get('chat'), cached);
  assert.equal(states, 0);
});

test('out-of-sequence desktop patches request a fresh snapshot without applying stale state', () => {
  const { connection, sent } = ipc();
  connection.follow('chat', 'owner');
  connection.states.set('chat', { revision: 1, state: { id: 'chat', requests: [] } });
  connection._handleState({ sourceClientId: 'owner', version: 11, params: {
    hostId: 'local', conversationId: 'chat', change: { type: 'patches', baseRevision: 2, revision: 3, patches: [] },
  } });
  assert.equal(connection.states.has('chat'), false);
  assert.equal(sent.at(-1).params.following, true);
});

test('desktop patches support array removals and reject prototype writes', () => {
  assert.deepEqual(applyStatePatches({ requests: ['a', 'b'] }, [
    { op: 'remove', path: ['requests', 0] }, { op: 'replace', path: ['requests', 0], value: 'c' },
  ]), { requests: ['c'] });
  assert.throws(() => applyStatePatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]), /patch path/);
  assert.equal({}.polluted, undefined);
});

function bridgeHarness() {
  const calls = [];
  const bridge = Object.assign(Object.create(Bridge.prototype), {
    models: {}, permissions: {}, threadSettings: new Map(), activeTurns: new Map(),
    loadedThreads: new Map(), ephemeralThreads: new Map(), pendingApprovals: new Map(),
    stoppedTurns: new Set(), rollout: { states: new Map() }, events: [],
    _broadcast(event) { this.events.push(event); },
    connection: { ready: true, request: async method => { throw new Error('Must not take the writer: ' + method); } },
    desktop: {
      following: new Map(),
      async ensureOwner(threadId) { calls.push({ method: 'owner', threadId }); return { clientId: 'owner' }; },
      async callThread(threadId, method, params, owner) {
        calls.push({ method, threadId, params, owner });
        if (method === 'thread-follower-update-thread-settings') return { applied: true };
        if (method === 'thread-follower-interrupt-turn') return { ok: true, interruptedTurnId: params.expectedTurnId };
        return { result: { turn: { id: 'desktop-turn', status: 'inProgress' } } };
      },
    },
  });
  return { bridge, calls };
}

test('persistent phone messages run inside ChatGPT with images and a literal text payload', async () => {
  const { bridge, calls } = bridgeHarness();
  bridge.connection = null; // sending must work without the independent data backend
  const text = '请查看图片；literal `command` and $(command)';
  const result = await bridge._deliverMessage('chat', text, ['/tmp/example.png'], {});
  assert.equal(result.desktop, true);
  assert.equal(result.mode, 'started');
  assert.equal(bridge.loadedThreads.size, 0);
  assert.equal(bridge.activeTurns.get('chat'), 'desktop-turn');
  const sent = calls.find(c => c.method === 'thread-follower-start-turn').params.turnStart;
  assert.deepEqual(sent.request.input, [{ type: 'text', text, text_elements: [] }, { type: 'localImage', path: '/tmp/example.png' }]);
  assert.equal(sent.context.inheritThreadSettings, true);
  assert.equal(sent.request.model, undefined);
  assert.match(sent.request.clientUserMessageId, /^[0-9a-f-]{36}$/);
});

test('the phone HTTP send endpoint reaches ChatGPT when the independent data service is offline', async () => {
  const { bridge } = bridgeHarness();
  bridge.connection = null;
  const request = Readable.from([Buffer.from(JSON.stringify({ text: 'Continue' }))]);
  request.method = 'POST';
  let status, payload;
  const response = {
    writeHead(value) { status = value; },
    end(value) { payload = JSON.parse(value.toString()); },
  };
  await bridge._handleApi(request, response, new URL('http://localhost/api/threads/chat/message'));
  assert.equal(status, 200);
  assert.equal(payload.desktop, true);
});

test('bridge health distinguishes an available data service from an offline ChatGPT desktop', () => {
  const { bridge } = bridgeHarness();
  bridge.connection.ready = true;
  bridge.desktop.ready = false;
  assert.equal(bridge._isConnected(), false);
  bridge.desktop.ready = true;
  assert.equal(bridge._isConnected(), true);
});

test('explicit mobile preferences are confirmed in ChatGPT before a message starts', async () => {
  const { bridge, calls } = bridgeHarness();
  bridge.models.chat = { model: 'chosen-model', reasoningEffort: 'high' };
  bridge.permissions.chat = 'ask';
  await bridge._deliverMessage('chat', 'Continue', [], {});
  assert.deepEqual(calls.map(c => c.method), ['owner', 'thread-follower-update-thread-settings', 'thread-follower-start-turn']);
  const settings = calls[1].params.threadSettings;
  assert.equal(settings.model, 'chosen-model');
  assert.equal(settings.effort, 'high');
  assert.equal(settings.approvalPolicy, 'on-request');
  assert.equal(settings.sandboxPolicy.type, 'workspaceWrite');
});

test('unconfirmed desktop preference changes prevent sending the message', async () => {
  const { bridge, calls } = bridgeHarness();
  bridge.models.chat = { model: 'chosen-model' };
  bridge.desktop.callThread = async (id, method) => { calls.push({ method }); return { applied: false }; };
  await assert.rejects(bridge._deliverMessage('chat', 'Continue', [], {}), /本次消息尚未发送/);
  assert.equal(calls.some(c => c.method === 'thread-follower-start-turn'), false);
});

test('steering goes through the desktop owner without applying next-turn preferences', async () => {
  const { bridge, calls } = bridgeHarness();
  bridge.models.chat = { model: 'chosen-model' };
  const result = await bridge._deliverMessage('chat', 'Adjust', [], { steer: true });
  assert.equal(result.mode, 'steered');
  assert.deepEqual(calls.map(c => c.method), ['owner', 'thread-follower-steer-turn']);
});

test('desktop steering supplies a restorable draft and inherits the active chat workspace', async () => {
  const { bridge, calls } = bridgeHarness();
  const text = '改按这条执行 🐱\nKeep `literal` and $(text).';
  const startedAt = Date.now();
  bridge.connection = null;
  bridge.desktop.callThread = async (id, method, params) => {
    calls.push({ method, params });
    /* The native steer preparation reads these before sending turn/steer. */
    const cwd = params.restoreMessage.cwd ?? '/active-desktop-workspace';
    const roots = params.restoreMessage.context.workspaceRoots ?? [cwd];
    assert.deepEqual(roots, ['/active-desktop-workspace']);
    return { result: { turnId: 'active-desktop-turn' } };
  };
  const result = await bridge._deliverMessage('chat', text, ['/tmp/example.png'], { steer: true });
  const sent = calls.find(call => call.method === 'thread-follower-steer-turn').params;
  assert.equal(result.turnId, 'active-desktop-turn');
  assert.equal(sent.restoreMessage.id, sent.clientUserMessageId);
  assert.equal(sent.restoreMessage.text, text);
  assert.equal(sent.restoreMessage.context.prompt, text);
  assert.deepEqual(sent.restoreMessage.context.commentAttachments, []);
  assert(sent.restoreMessage.createdAt >= startedAt);
  assert.equal(sent.restoreMessage.context.collaborationMode, undefined);
  assert.equal(sent.model, undefined);
  assert.deepEqual(sent.input, [{ type: 'text', text, text_elements: [] }, { type: 'localImage', path: '/tmp/example.png' }]);
});

test('image-only desktop steering includes an empty draft and retains the image input', async () => {
  const { bridge, calls } = bridgeHarness();
  await bridge._deliverMessage('chat', '', ['/tmp/example.png'], { steer: true });
  const sent = calls.find(call => call.method === 'thread-follower-steer-turn').params;
  assert.equal(sent.restoreMessage.text, '');
  assert.equal(sent.restoreMessage.context.prompt, '');
  assert.equal(sent.restoreMessage.id, sent.clientUserMessageId);
  assert.deepEqual(sent.input, [{ type: 'localImage', path: '/tmp/example.png' }]);
});

/* ChatGPT's native continuation-marker scan runs on the optimistic user input
   before app-server can fill in defaults. Missing text_elements crashes the
   conversation renderer, even though turn/start accepts that same payload. */
function desktopHasContinuationInput(input) {
  return input?.some(part => part.type === 'text' &&
    part.text_elements.some(({ placeholder }) => placeholder === 'aeon-continuation')) === true;
}

for (const steer of [false, true]) {
  test(`desktop ${steer ? 'steering' : 'sending'} input survives native message rendering`, async () => {
    const { bridge, calls } = bridgeHarness();
    const text = '检查手机命令 🐱\nKeep `literal` and $(text) unchanged.';
    const result = await bridge._deliverMessage('chat', text, ['/tmp/example.png'], { steer });
    const sent = calls.find(call => call.method === (steer
      ? 'thread-follower-steer-turn' : 'thread-follower-start-turn'));
    const input = steer ? sent.params.input : sent.params.turnStart.request.input;
    assert.equal(desktopHasContinuationInput(input), false);
    assert.equal(input[0].text, text);
    assert.deepEqual(input[1], { type: 'localImage', path: '/tmp/example.png' });
    assert.equal(result.mode, steer ? 'steered' : 'started');
  });
}

test('an image-only desktop message survives native message rendering', async () => {
  const { bridge, calls } = bridgeHarness();
  await bridge._deliverMessage('chat', '', ['/tmp/example.png'], {});
  const input = calls.find(call => call.method === 'thread-follower-start-turn').params.turnStart.request.input;
  assert.equal(desktopHasContinuationInput(input), false);
  assert.deepEqual(input, [{ type: 'localImage', path: '/tmp/example.png' }]);
});

test('an uncertain native send is never retried through an independent runtime or queue', async () => {
  const { bridge, calls } = bridgeHarness();
  bridge.desktop.callThread = async (id, method) => { calls.push({ method }); throw new Error('confirmation timed out'); };
  await assert.rejects(bridge._deliverMessage('chat', 'Continue', [], {}), /confirmation timed out/);
  assert.equal(calls.filter(c => c.method === 'thread-follower-start-turn').length, 1);
});

test('new-chat metadata releases its writer before the desktop is asked to open it', async () => {
  const { bridge, calls } = bridgeHarness();
  bridge.loadedThreads.set('chat', 0);
  bridge.releaseThreadLock = async id => { calls.push({ method: 'release' }); bridge.loadedThreads.delete(id); return true; };
  await bridge._deliverMessage('chat', 'Continue', [], {});
  assert.deepEqual(calls.map(c => c.method), ['release', 'owner', 'thread-follower-start-turn']);
});

test('interrupt targets the actual desktop turn without taking over its runtime', async () => {
  const { bridge, calls } = bridgeHarness();
  bridge.activeTurns.set('chat', 'active-turn');
  assert.equal((await bridge._interruptDesktopThread('chat')).ok, true);
  assert.equal(calls[1].params.expectedTurnId, 'active-turn');
  assert.equal(calls[1].params.mode, 'user-stop');
  assert.equal(bridge.activeTurns.has('chat'), false);
});

test('desktop approval cards resolve through their owner and disappear after desktop decisions', async () => {
  const { bridge, calls } = bridgeHarness();
  const state = { requests: [{ id: 23, method: 'item/commandExecution/requestApproval', params: { command: 'pwd' } }] };
  bridge._handleDesktopState('chat', state);
  assert.equal(bridge.pendingApprovals.size, 1);
  await bridge._respondToApproval('desktop:chat:23', { decision: 'accept' });
  assert.equal(calls[0].method, 'thread-follower-command-approval-decision');
  assert.deepEqual(calls[0].params, { requestId: 23, decision: 'accept' });
  bridge._handleDesktopState('chat', state);
  bridge._handleDesktopState('chat', { requests: [] });
  assert.equal(bridge.pendingApprovals.size, 0);
});

test('a failed metadata writer release stays tracked for a later cleanup attempt', async () => {
  const { bridge } = bridgeHarness();
  bridge.loadedThreads.set('chat', 0);
  bridge._latestTurn = async () => null;
  bridge.connection.request = async () => { throw new Error('temporary failure'); };
  const original = console.error;
  console.error = () => {};
  try { assert.equal(await bridge.releaseThreadLock('chat', { force: true }), false); }
  finally { console.error = original; }
  assert.equal(bridge.loadedThreads.has('chat'), true);
});

for (const status of ['notLoaded', 'notSubscribed', 'unsubscribed']) {
  test('a confirmed ' + status + ' subscription releases metadata without archiving', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { bridge, calls } = bridgeHarness();
    bridge.loadedThreads.set('chat', 0);
    bridge._latestTurn = async () => null;
    bridge.connection.request = async (method, params) => {
      calls.push({ method, params });
      return { status };
    };
    assert.equal(await bridge.releaseThreadLock('chat', { force: true }), true);
    assert.deepEqual(calls, [{ method: 'thread/unsubscribe', params: { threadId: 'chat' } }]);
    assert.equal(bridge.loadedThreads.has('chat'), false);
  });
}

test('an unconfirmed unsubscribe stays tracked and cannot trigger an archive fallback', async (t) => {
  t.mock.method(console, 'error', () => {});
  const failures = [
    null,
    new Error('connection closed before thread/unsubscribe completed'),
    Object.assign(new Error('thread/unsubscribe timed out after 60000ms'), { timedOut: true }),
  ];
  for (const failure of failures) {
    const { bridge, calls } = bridgeHarness();
    bridge.loadedThreads.set('chat', 0);
    bridge._latestTurn = async () => null;
    bridge.connection.request = async (method, params) => {
      calls.push({ method, params });
      if (failure) throw failure;
      return { status: 'unknown' };
    };
    assert.equal(await bridge.releaseThreadLock('chat', { force: true }), false);
    assert.deepEqual(calls.map(call => call.method), ['thread/unsubscribe']);
    assert.equal(bridge.loadedThreads.has('chat'), true);
  }
});

test('an explicitly unsupported unsubscribe uses the legacy writer handoff', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { bridge, calls } = bridgeHarness();
  bridge.loadedThreads.set('chat', 0);
  bridge._latestTurn = async () => null;
  bridge.connection.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/unsubscribe') {
      throw Object.assign(new Error('method not found'), { rpcError: { code: -32601 } });
    }
    return {};
  };
  assert.equal(await bridge.releaseThreadLock('chat', { force: true }), true);
  assert.deepEqual(calls.map(call => call.method), ['thread/unsubscribe', 'thread/archive', 'thread/unarchive']);
  assert.equal(bridge.loadedThreads.has('chat'), false);
});

for (const running of ['cached-turn', 'latest-turn', 'rollout']) {
  test('metadata handoff preserves a running ' + running, async () => {
    const { bridge, calls } = bridgeHarness();
    bridge.loadedThreads.set('chat', 0);
    bridge._latestTurn = async () => running === 'latest-turn' ? { id: 'running-turn', status: 'inProgress' } : null;
    if (running === 'cached-turn') bridge.activeTurns.set('chat', 'running-turn');
    if (running === 'rollout') bridge.rollout.states.set('chat', { running: true, turnId: 'running-turn' });
    assert.equal(await bridge.releaseThreadLock('chat', { force: true }), false);
    assert.equal(bridge.loadedThreads.has('chat'), true);
    assert.deepEqual(calls, []);
  });
}
