'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Bridge } = require('../src/server');
const { isBusyThreadError, isThreadNotFoundError } = require('../src/appserver');

function harness(t, request) {
  const bridge = Object.assign(Object.create(Bridge.prototype), {
    models: {}, permissions: {}, threadSettings: new Map(), activeTurns: new Map(),
    loadedThreads: new Map(), ephemeralThreads: new Map(), stoppedTurns: new Set(),
    rollout: { states: new Map() }, calls: [],
  });
  bridge.connection = { ready: true, request: async (method, params) => {
    bridge.calls.push({ method, params });
    return request(method, params);
  } };
  return bridge;
}

test('a missing thread is distinct from a running or writer-locked thread', () => {
  const missing = new Error('thread not found: chat');
  assert.equal(isBusyThreadError(missing), false);
  assert.equal(isThreadNotFoundError(missing), true);
  assert.equal(isBusyThreadError(new Error('already has an active writer')), true);
  assert.equal(isBusyThreadError(new Error('already running')), true);
});

for (const status of ['completed', 'interrupted', 'failed']) {
  test('sending after a ' + status + ' turn queues and wakes idle ownership without archiving', async (t) => {
    let resumed = 0;
    const bridge = harness(t, async (method, params) => {
      if (method === 'thread/resume') {
        if (++resumed === 1) throw new Error('already has an active writer');
        return {};
      }
      if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', status }] };
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queue-1' } };
      if (method === 'thread/queue/start') return { turn: { id: 'new-turn', status: 'inProgress' } };
      throw new Error('unexpected method: ' + method);
    });
    bridge.models.chat = { model: 'example-deep', reasoningEffort: 'high' };
    bridge.permissions.chat = 'ask';
    bridge.activeTurns.set('chat', 'old-turn');
    const result = await bridge._deliverMessage('chat', 'Continue', ['/tmp/example.png'], {});
    assert.equal(result.mode, 'started');
    assert.deepEqual(bridge.calls.map(c => c.method), [
      'thread/resume', 'thread/turns/list', 'thread/queue/add', 'thread/resume', 'thread/queue/start',
    ]);
    const resumes = bridge.calls.filter(c => c.method === 'thread/resume');
    assert.deepEqual(resumes[1].params, resumes[0].params);
    assert.equal(resumes[1].params.model, 'example-deep');
    assert.equal(resumes[1].params.sandbox, 'workspace-write');
    assert.equal(resumes[1].params.config.model_reasoning_effort, 'high');
    const queued = bridge.calls.find(c => c.method === 'thread/queue/add').params;
    assert.match(queued.clientUserMessageId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(queued.input, [{ type: 'text', text: 'Continue', text_elements: [] }, { type: 'localImage', path: '/tmp/example.png' }]);
    assert.deepEqual(bridge.calls.find(c => c.method === 'thread/queue/start').params, {
      threadId: 'chat', queuedSubmissionId: 'queue-1',
    });
    assert.equal(bridge.activeTurns.get('chat'), 'new-turn');
  });
}

for (const scenario of ['running', 'rollout-running', 'unknown', 'read-failed']) {
  test('writer conflict with ' + scenario + ' state queues without archiving', async (t) => {
    const bridge = harness(t, async (method) => {
      if (method === 'thread/resume') throw new Error('already has an active writer');
      if (method === 'thread/turns/list') {
        if (scenario === 'read-failed') throw new Error('status unavailable');
        if (scenario === 'unknown') return { data: [] };
        return { data: [{ id: 'desktop-turn', status: scenario === 'running' ? 'inProgress' : 'interrupted' }] };
      }
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queue-1' } };
      throw new Error('must not mutate the desktop thread: ' + method);
    });
    if (scenario === 'rollout-running') {
      bridge.rollout.states.set('chat', { running: true, turnId: 'desktop-turn' });
    }
    bridge.permissions.chat = 'auto';
    bridge.models.chat = { model: 'example-deep', reasoningEffort: 'high' };
    const result = await bridge._deliverMessage('chat', 'Next task', [], {});
    assert.equal(result.mode, 'queued');
    assert.equal(result.queueId, 'queue-1');
    assert.deepEqual(bridge.calls.map(c => c.method), ['thread/resume', 'thread/turns/list', 'thread/queue/add']);
  });
}

test('a thread unloaded between resume and start is resumed and retried once', async (t) => {
  let started = 0;
  const bridge = harness(t, async (method) => {
    if (method === 'thread/resume') return {};
    if (method === 'turn/start') {
      if (++started === 1) throw new Error('thread not found: chat');
      return { turn: { id: 'new-turn', status: 'inProgress' } };
    }
    throw new Error('unexpected method: ' + method);
  });
  assert.equal((await bridge._deliverMessage('chat', 'Continue', [], {})).mode, 'started');
  assert.deepEqual(bridge.calls.map(c => c.method), ['thread/resume', 'turn/start', 'thread/resume', 'turn/start']);
});

test('a persistently missing thread reports the original error without claiming it is running', async (t) => {
  const missing = new Error('thread not found: chat');
  const bridge = harness(t, async (method) => {
    if (method === 'thread/resume') return {};
    throw missing;
  });
  await assert.rejects(bridge._deliverMessage('chat', 'Continue', [], {}), error => error === missing);
  assert.equal(bridge.calls.filter(c => c.method === 'turn/start').length, 2);
});

test('a failed or timed-out start is never resubmitted or queued', async (t) => {
  const failed = new Error('turn/start timed out after 60000ms');
  const bridge = harness(t, async (method) => {
    if (method === 'thread/resume') return {};
    throw failed;
  });
  await assert.rejects(bridge._deliverMessage('chat', 'Continue', [], {}), error => error === failed);
  assert.deepEqual(bridge.calls.map(c => c.method), ['thread/resume', 'turn/start']);
});

test('queue failure preserves both errors without calling a completed thread running', async (t) => {
  const bridge = harness(t, async (method) => {
    if (method === 'thread/resume') throw new Error('already has an active writer');
    if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', status: 'completed' }] };
    if (method === 'thread/queue/add') throw new Error('queue offline');
    throw new Error('unexpected method: ' + method);
  });
  await assert.rejects(bridge._deliverMessage('chat', 'Continue', [], {}), error => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /active writer/);
    assert.match(error.message, /queue offline/);
    assert.doesNotMatch(error.message, /正在电脑上运行|等它跑完/);
    return true;
  });
});

test('a completed desktop-owned session accepts queued input even when its writer stays locked', async (t) => {
  const bridge = harness(t, async (method) => {
    if (method === 'thread/resume') throw new Error('already has an active writer');
    if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', status: 'completed' }] };
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queue-1' } };
    throw new Error('must not archive or start on another owner: ' + method);
  });
  const result = await bridge._deliverMessage('chat', 'Continue', [], {});
  assert.equal(result.mode, 'queued');
  assert.equal(result.queueId, 'queue-1');
  assert.deepEqual(bridge.calls.map(c => c.method), ['thread/resume', 'thread/turns/list', 'thread/queue/add', 'thread/resume']);
});

test('a lost wake acknowledgement preserves queued success without submitting twice', async (t) => {
  let resumed = 0;
  const bridge = harness(t, async (method) => {
    if (method === 'thread/resume') {
      if (++resumed === 1) throw new Error('already has an active writer');
      return {};
    }
    if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', status: 'completed' }] };
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queue-1' } };
    if (method === 'thread/queue/start') throw new Error('timed out');
    throw new Error('unexpected method: ' + method);
  });
  assert.equal((await bridge._deliverMessage('chat', 'Continue', [], {})).mode, 'queued');
  assert.equal(bridge.calls.filter(c => c.method === 'thread/queue/add').length, 1);
});

test('an uncertain queue-add result is never submitted a second time', async (t) => {
  const bridge = harness(t, async (method) => {
    if (method === 'thread/resume') throw new Error('already running');
    if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', status: 'inProgress' }] };
    if (method === 'thread/queue/add') throw new Error('timed out after accepting input');
    throw new Error('unexpected method: ' + method);
  });
  await assert.rejects(bridge._deliverMessage('chat', 'Continue', [], {}), /timed out after accepting input/);
  assert.equal(bridge.calls.filter(c => c.method === 'thread/queue/add').length, 1);
});

test('native queue delivery supports image input while a desktop turn is active', async (t) => {
  const bridge = harness(t, async (method) => {
    if (method === 'thread/resume') throw new Error('already has an active writer');
    if (method === 'thread/turns/list') return { data: [{ id: 'desktop-turn', status: 'inProgress' }] };
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queue-image' } };
    throw new Error('unexpected method: ' + method);
  });
  assert.equal((await bridge._deliverMessage('chat', 'Inspect', ['/tmp/example.png'], {})).queueId, 'queue-image');
  assert.deepEqual(bridge.calls.find(c => c.method === 'thread/queue/add').params.input, [
    { type: 'text', text: 'Inspect', text_elements: [] }, { type: 'localImage', path: '/tmp/example.png' },
  ]);
});

test('an unsupported native queue reports recovery without launching another process', async (t) => {
  const bridge = harness(t, async () => {
    const error = new Error('method not found');
    error.rpcError = { code: -32601 };
    throw error;
  });
  await assert.rejects(bridge._queueInput('chat', [{ type: 'text', text: 'literal `text` and $(text)' }]), /不支持消息排队/);
  assert.equal(bridge.calls.length, 1);
});
