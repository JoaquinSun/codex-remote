'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { Bridge, parseArguments } = require('../src/server');
const { defaultAppServerSocket, findCodexBinary, startManagedAppServer } = require('../src/daemon');

function missing(code = 'ENOENT') {
  return Object.assign(new Error('connect ' + code + ' ' + defaultAppServerSocket()), { code });
}

class DataConnection extends EventEmitter {
  constructor(error) {
    super();
    this.error = error;
    this.ready = false;
    this.calls = [];
  }
  async connect() {
    if (this.error) {
      this.emit('close', this.error);
      throw this.error;
    }
    this.ready = true;
    return {};
  }
  async request(method) {
    this.calls.push(method);
    if (method === 'thread/list') return { data: [{ id: 'existing-chat', name: 'Desktop chat' }] };
    if (method === 'project/list') return { data: [{ id: 'existing-project', name: 'Desktop project' }] };
    if (method === 'model/list') return { data: [{ id: 'example-model', model: 'example-model', displayName: 'Example',
      defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
    throw new Error('Unexpected data operation: ' + method);
  }
  close() { this.ready = false; this.emit('close'); }
}

function harness(t, options = parseArguments([])) {
  const bridge = Object.assign(Object.create(Bridge.prototype), {
    options, desktop: { ready: true }, connection: null, appServerConnectPromise: null,
    daemonRecoveryRetryAt: 0, ephemeralThreads: new Map(), stoppedTurns: new Set(),
    activeTurns: new Map(), rollout: { states: new Map() },
    events: [], created: [], starts: 0,
    _broadcast(event) { this.events.push(event); },
    _createAppServerConnection() {
      const connection = new DataConnection(this.created.length ? null : missing());
      this.created.push(connection);
      return connection;
    },
    async _startDataDaemon() { this.starts++; },
  });
  t.after(() => { bridge.shuttingDown = true; clearTimeout(bridge.reconnectTimer); });
  return bridge;
}

function api(bridge, endpoint) {
  const response = {};
  const request = Readable.from([]);
  request.method = 'GET';
  const done = bridge._handleApi(request, {
    writeHead(status) { response.status = status; },
    end(body) { response.body = JSON.parse(body.toString()); },
  }, new URL(endpoint, 'http://localhost'));
  return { response, done };
}

test('concurrent history, project and model requests wait for one shared daemon recovery', async (t) => {
  const bridge = harness(t);
  let release;
  const startup = new Promise(resolve => { release = resolve; });
  bridge._startDataDaemon = async () => { bridge.starts++; await startup; };
  const threads = api(bridge, '/api/threads');
  const projects = api(bridge, '/api/projects');
  const models = api(bridge, '/api/models');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.starts, 1);
  assert.equal(threads.response.status, undefined);
  assert.equal(projects.response.status, undefined);
  assert.equal(models.response.status, undefined);
  release();
  await Promise.all([threads.done, projects.done, models.done]);
  assert.equal(threads.response.status, 200);
  assert.equal(threads.response.body.data[0].id, 'existing-chat');
  assert.equal(projects.response.status, 200);
  assert.equal(projects.response.body.data[0].id, 'existing-project');
  assert.equal(models.response.status, 200);
  assert.equal(models.response.body.data[0].model, 'example-model');
  assert.deepEqual(bridge.created[1].calls.sort(), ['model/list', 'project/list', 'thread/list']);
  assert.equal(bridge.connectionError, null);
  assert.equal(bridge.reconnectTimer, null);
});

test('a socket removed after desktop restart recovers and ignores events from the old connection', async (t) => {
  const bridge = harness(t);
  const first = await bridge._connectToAppServer();
  assert.equal(first.ready, true);
  first.close();
  let opened = 0;
  bridge._createAppServerConnection = () => new DataConnection(opened++ ? null : missing('ECONNREFUSED'));
  const next = await bridge._ensureDataConnection();
  assert.equal(next.ready, true);
  assert.equal(bridge.starts, 2);
  first.emit('error', new Error('late socket error'));
  first.emit('close');
  assert.equal(bridge.connection, next);
  assert.equal(bridge.connectionError, null);
  assert.equal(bridge.reconnectTimer, null);
});

for (const scenario of ['custom-socket', 'explicit-default-socket', 'disabled', 'desktop-offline', 'permission-denied', 'protocol-error']) {
  test('daemon recovery does not replace operator configuration or repair unrelated failures: ' + scenario, async (t) => {
    const args = scenario === 'custom-socket' ? ['--socket', '/fixture/custom.sock']
      : scenario === 'explicit-default-socket' ? ['--socket', defaultAppServerSocket()]
      : scenario === 'disabled' ? ['--no-auto-start-daemon'] : [];
    const bridge = harness(t, parseArguments(args));
    if (scenario === 'desktop-offline') bridge.desktop.ready = false;
    const error = scenario === 'permission-denied' ? missing('EPERM')
      : scenario === 'protocol-error' ? new Error('WebSocket handshake rejected: HTTP/1.1 403 Forbidden') : missing();
    bridge._createAppServerConnection = () => new DataConnection(error);
    const request = api(bridge, '/api/threads');
    await request.done;
    assert.equal(request.response.status, 503);
    assert.match(request.response.body.error, /聊天数据接口未连接/);
    assert.equal(bridge.starts, 0);
  });
}

test('failed daemon recovery reports its error and limits repeated launch attempts', async (t) => {
  const bridge = harness(t);
  bridge._createAppServerConnection = () => new DataConnection(missing());
  bridge._startDataDaemon = async () => { bridge.starts++; throw new Error('local daemon startup failed'); };
  const first = api(bridge, '/api/threads');
  await first.done;
  assert.equal(first.response.status, 503);
  assert.match(first.response.body.error, /local daemon startup failed/);
  await bridge._connectToAppServer();
  assert.equal(bridge.starts, 1);
});

test('quitting during recovery does not reconnect or schedule another daemon launch', async (t) => {
  const bridge = harness(t);
  let release;
  bridge._startDataDaemon = async () => { bridge.starts++; await new Promise(resolve => { release = resolve; }); };
  const attempt = bridge._connectToAppServer();
  await new Promise(resolve => setImmediate(resolve));
  bridge.shuttingDown = true;
  clearTimeout(bridge.reconnectTimer);
  bridge.reconnectTimer = null;
  release();
  assert.equal(await attempt, null);
  bridge._scheduleReconnect();
  assert.equal(bridge.created.length, 1);
  assert.equal(bridge.reconnectTimer, null);
});

test('default data socket respects CODEX_HOME and an explicit socket disables managed startup', () => {
  const environment = { CODEX_HOME: '/fixture/custom-codex-home' };
  const expected = '/fixture/custom-codex-home/app-server-control/app-server-control.sock';
  assert.equal(defaultAppServerSocket(environment), expected);
  assert.equal(parseArguments([], environment).socketPath, expected);
  assert.equal(parseArguments([], environment).autoStartDaemon, true);
  assert.equal(parseArguments(['--socket', expected], environment).autoStartDaemon, false);
});

test('data recovery prefers the Codex bundled in ChatGPT over a separately installed CLI', () => {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const available = new Set([bundled, '/fixture/bin/codex']);
  assert.equal(findCodexBinary({ PATH: '/fixture/bin' }, filename => available.has(filename)), bundled);
  assert.equal(findCodexBinary({ CODEX_REMOTE_CODEX: '/fixture/bin/codex' }, filename => available.has(filename)), '/fixture/bin/codex');
});

test('managed recovery starts the same Codex home with fixed arguments and no shell', async () => {
  const environment = { CODEX_HOME: '/fixture/desktop home', CODEX_REMOTE_CODEX: '/fixture/Codex CLI/codex' };
  let call;
  await startManagedAppServer({
    binary: environment.CODEX_REMOTE_CODEX, environment,
    runFile: async (binary, args, options) => { call = { binary, args, options }; },
  });
  assert.equal(call.binary, environment.CODEX_REMOTE_CODEX);
  assert.deepEqual(call.args, ['app-server', 'daemon', 'start']);
  assert.equal(call.options.env.CODEX_HOME, environment.CODEX_HOME);
  assert.equal(call.options.shell, undefined);
  assert.equal(call.options.timeout, 15000);
});

test('daemon startup timeout is surfaced instead of keeping history requests pending forever', async () => {
  await assert.rejects(startManagedAppServer({
    binary: '/fixture/codex',
    runFile: async () => { throw Object.assign(new Error('process timed out'), { killed: true }); },
  }), /启动超时/);
});
