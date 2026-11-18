'use strict';

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

/* ChatGPT's desktop coordination protocol. These are the same follower
   requests used between its windows; the desktop keeps the thread's writer.
   The protocol is internal, so version mismatches must fail explicitly. */
const VERSIONS = {
  'thread-owner-discovery': 1,
  'thread-stream-following-changed': 1,
  'thread-stream-state-changed': 13,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-read-model-settings': 1,
  'thread-follower-update-thread-settings': 2,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1,
  'thread-follower-submit-mcp-server-elicitation-response': 1,
};
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const STATE_FIELDS = new Set(['id', 'requests', 'threadRuntimeStatus', 'latestThreadSettings',
  'latestModel', 'latestReasoningEffort', 'currentPermissions']);
/* Both verified stream versions expose the same projected settings, runtime
   and approval fields. Unrelated history and accepted-text metadata are not
   cached; unverified versions must still fail explicitly. */
const SUPPORTED_STATE_VERSIONS = new Set([11, 13]);

function projectState(state) {
  if (!state || typeof state !== 'object') throw new Error('Invalid ChatGPT conversation state');
  return Object.fromEntries(Object.entries(state).filter(([key]) => STATE_FIELDS.has(key)));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function desktopSocketPath() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const primary = path.join(home, 'ipc', 'ipc.sock');
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(os.tmpdir(), 'codex-ipc', `ipc-${process.getuid?.()}.sock`);
  return fs.existsSync(legacy) ? legacy : primary;
}

function openDesktopThread(threadId) {
  if (!UUID.test(threadId)) return Promise.reject(new Error('Invalid desktop conversation id'));
  if (process.platform !== 'darwin') return Promise.reject(new Error('自动打开桌面聊天目前需要 macOS。'));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-g', '-a', 'ChatGPT', `codex://threads/${threadId}`], {
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('打开 ChatGPT 聊天超时。'));
    }, 5000);
    child.once('error', finish);
    child.once('close', code => finish(code === 0 ? null : new Error('无法打开 ChatGPT，请先启动桌面 App。')));
  });
}

/* Immer's wire patches use arrays of keys. Reject prototype keys even though
   the socket is local: snapshots are data, never bridge configuration/code. */
function applyStatePatches(state, patches) {
  for (const patch of patches) {
    if (!['add', 'replace', 'remove'].includes(patch.op) || !Array.isArray(patch.path)) {
      throw new Error('Unsupported desktop state patch');
    }
    if (patch.path.some(key => !['string', 'number'].includes(typeof key) ||
      ['__proto__', 'prototype', 'constructor'].includes(String(key)))) {
      throw new Error('Invalid desktop state patch path');
    }
    if (patch.path.length === 0) {
      state = patch.op === 'remove' ? null : patch.value;
      continue;
    }
    let parent = state;
    for (const key of patch.path.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) {
        throw new Error('Desktop state patch has no parent');
      }
      parent = parent[key];
    }
    if (parent === null || typeof parent !== 'object') throw new Error('Invalid desktop state patch parent');
    const key = patch.path.at(-1);
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error('Invalid desktop array index');
      if (patch.op === 'add') parent.splice(index, 0, patch.value);
      else if (patch.op === 'remove') parent.splice(index, 1);
      else parent[index] = patch.value;
    } else if (patch.op === 'remove') delete parent[key];
    else parent[key] = patch.value;
  }
  return state;
}

class DesktopConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    this.socketPath = options.socketPath || desktopSocketPath();
    this.openThread = options.openThread || openDesktopThread;
    this.socket = null;
    this.ready = false;
    this.clientId = 'initializing-client';
    this.pending = new Map();
    this.following = new Map();
    this.states = new Map();
    this.ownerPromises = new Map();
    this.connecting = null;
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _connect() {
    this.buffer = Buffer.alloc(0);
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.on('data', chunk => {
      try { this._receive(chunk); } catch (error) { socket.destroy(error); }
    });
    socket.on('error', () => {}); // close rejects every pending call, including initialization
    socket.on('close', () => this._closed(socket));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => socket.destroy(new Error('ChatGPT IPC connection timed out')), 5000);
        const connected = () => { clearTimeout(timer); socket.off('error', failed); resolve(); };
        const failed = error => { clearTimeout(timer); socket.off('connect', connected); reject(error); };
        socket.once('connect', connected);
        socket.once('error', failed);
      });
      const result = await this.request('initialize', { clientType: 'codex-remote' });
      if (!result?.clientId) throw new Error('ChatGPT IPC initialization returned no client id');
      this.clientId = result.clientId;
      this.ready = true;
      this.emit('ready');
    } catch (cause) {
      socket.destroy();
      const error = new Error('未连接到 ChatGPT，请先打开桌面 App 并进入 Codex。', { cause });
      error.statusCode = 503;
      throw error;
    }
  }

  _send(message) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) throw new Error('ChatGPT IPC is disconnected');
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > MAX_FRAME_BYTES) throw new Error('ChatGPT IPC request is too large');
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
  }

  request(method, params, options = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`ChatGPT ${method} 确认超时，请刷新查看结果后再重试。`);
        error.timedOut = true;
        reject(error);
      }, options.timeoutMs ?? 20000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this._send({
          type: 'request', requestId, sourceClientId: this.clientId,
          method, params, version: method === 'thread-follower-interrupt-turn' && params.expectedTurnId == null
            ? 3 : VERSIONS[method] ?? 0,
          ...(options.targetClientId ? { targetClientId: options.targetClientId } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  _receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) throw new Error('Invalid ChatGPT IPC frame length');
      if (this.buffer.length < length + 4) return;
      const message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
      this.buffer = this.buffer.subarray(length + 4);
      this._handleMessage(message);
    }
  }

  _handleMessage(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === 'success') {
        pending.resolve(message.method === 'thread-owner-discovery'
          ? { ...message.result, clientId: message.handledByClientId } : message.result);
      } else {
        const error = new Error(message.error || 'ChatGPT request failed');
        error.desktopError = message.error;
        pending.reject(error);
      }
      return;
    }
    if (message.type === 'client-discovery-request') {
      this._send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type !== 'broadcast') return;
    if (message.method === 'thread-stream-state-changed') this._handleState(message);
    else if (message.method === 'thread-stream-following-status-requested') {
      const { conversationId, hostId } = message.params || {};
      if (hostId === 'local' && this.following.has(conversationId)) this.follow(conversationId, message.sourceClientId);
    } else if (message.method === 'client-status-changed' && message.params?.status === 'disconnected') {
      for (const [id, owner] of this.following) if (owner === message.params.clientId) {
        this.following.delete(id);
        this.states.delete(id);
      }
    }
  }

  _handleState(message) {
    const { conversationId, hostId, change } = message.params || {};
    if (hostId !== 'local' || !change || this.following.get(conversationId) !== message.sourceClientId) return;
    if (!SUPPORTED_STATE_VERSIONS.has(message.version)) {
      this.emit('protocolError', new Error(`ChatGPT 聊天状态协议已变化（收到 ${message.version}，支持 11、13），请更新桥接服务。`));
      return;
    }
    const cached = this.states.get(conversationId);
    if (change.type === 'snapshot') {
      this.states.set(conversationId, { revision: change.revision, state: projectState(change.conversationState) });
    } else if (change.type === 'patches') {
      if (!cached || cached.revision !== change.baseRevision) {
        this.states.delete(conversationId);
        this.follow(conversationId, message.sourceClientId);
        return;
      }
      const patches = (change.patches || []).filter(patch => patch.path?.length === 0 || STATE_FIELDS.has(patch.path?.[0]));
      cached.state = projectState(applyStatePatches(cached.state, patches));
      cached.revision = change.revision;
      if (!patches.length) return;
    } else return;
    this.emit('state', conversationId, this.states.get(conversationId).state);
  }

  follow(threadId, ownerId) {
    if (!this.following.has(threadId) && this.following.size >= 8) {
      for (const [id, owner] of this.following) {
        if (this.states.get(id)?.state.threadRuntimeStatus?.type === 'active') continue;
        this._sendFollowing(id, owner, false);
        this.following.delete(id);
        this.states.delete(id);
        break;
      }
    }
    this.following.set(threadId, ownerId);
    this._sendFollowing(threadId, ownerId, true);
  }

  _sendFollowing(threadId, ownerId, following) {
    this._send({
      type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this.clientId, targetClientIds: [ownerId],
      params: { hostId: 'local', conversationId: threadId, following },
    });
  }

  async findOwner(threadId, options = {}) {
    await this.connect();
    try {
      return await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, {
        timeoutMs: options.timeoutMs ?? 12000,
      });
    } catch (error) {
      if (error.desktopError === 'no-client-found') return null;
      throw error;
    }
  }

  ensureOwner(threadId) {
    if (this.ownerPromises.has(threadId)) return this.ownerPromises.get(threadId);
    const pending = this._ensureOwner(threadId).finally(() => {
      if (this.ownerPromises.get(threadId) === pending) this.ownerPromises.delete(threadId);
    });
    this.ownerPromises.set(threadId, pending);
    return pending;
  }

  async _ensureOwner(threadId) {
    /* A missing-owner discovery waits ten seconds in the desktop router.
       Only this read-only probe may time out and be repeated; follower
       mutations must keep their original acknowledgement and never retry. */
    const probe = async timeoutMs => {
      try {
        return await this.findOwner(threadId, { timeoutMs });
      } catch (error) {
        if (error.timedOut) return null;
        throw error;
      }
    };
    let owner = await probe(500);
    if (!owner) {
      await this.openThread(threadId);
      const deadline = Date.now() + 12000;
      while (!owner && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        owner = await probe(Math.min(1000, remaining));
      }
    }
    if (!owner) {
      const error = new Error('ChatGPT 尚未接入这条聊天。请在桌面 App 中打开它；旧版桥接正在运行的任务需要先完成。');
      error.statusCode = 409;
      throw error;
    }
    if (this.following.get(threadId) !== owner.clientId) this.follow(threadId, owner.clientId);
    return owner;
  }

  async callThread(threadId, method, params, owner) {
    owner = owner || await this.ensureOwner(threadId);
    return this.request(method, { conversationId: threadId, ...params }, { targetClientId: owner.clientId });
  }

  _closed(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.clientId = 'initializing-client';
    this.buffer = Buffer.alloc(0);
    this.following.clear();
    this.states.clear();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('ChatGPT 连接已断开，操作结果尚未确认，请刷新后查看。'));
    }
    this.pending.clear();
    this.emit('close');
  }

  close() {
    this.socket?.destroy();
  }
}

module.exports = { DesktopConnection, desktopSocketPath, openDesktopThread, applyStatePatches };
