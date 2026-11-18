'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { AppServerConnection, isBusyThreadError, isThreadNotFoundError, isFreshThreadError } = require('./appserver');
const { defaultAppServerSocket, startManagedAppServer } = require('./daemon');
const { DesktopConnection } = require('./desktop');
const { RolloutWatcher } = require('./rollout');
const { tailscaleClientInfo, warmTailscaleStatus } = require('./tailscale');
const { normalizeRateLimits, readCCSwitchUsage } = require('./usage');
const {
  normalizeMode,
  profileList,
  threadParams: permissionThreadParams,
  turnParams: permissionTurnParams,
  sandboxLabel,
  reviewerLabel,
  modeFromSettings,
  loadPermissionMap,
  savePermissionMap,
} = require('./permissions');
const {
  normalizeSelection,
  normalizeCatalog,
  validateSelection,
  threadParams: modelThreadParams,
  turnParams: modelTurnParams,
  effectiveModel,
  loadModelMap,
  saveModelMap,
} = require('./models');

const COOKIE_NAME = 'codex_remote_token';
/* Give the rollout a moment to flush before handing the writer lock back. */
const RELEASE_DELAY_MS = 4000;
/* Grace period before the background sweep may hand a lock back. */
const LOAD_GRACE_MS = 15000;
const UPLOAD_DIR = path.join(os.homedir(), '.codex-remote', 'uploads');
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_PORT = 8787;
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.codex-remote', 'token');
const DEFAULT_NAME_FILE = path.join(os.homedir(), '.codex-remote', 'name');
const DEFAULT_PERMISSION_FILE = path.join(os.homedir(), '.codex-remote', 'permissions.json');
const DEFAULT_MODEL_FILE = path.join(os.homedir(), '.codex-remote', 'models.json');
const MODEL_CATALOG_TTL_MS = 60000;
/* turn/steer 的 expectedTurnId 对不上（这一轮刚好跑完、或者已经换轮了）时的报错都长这样；
   这些情况下引导没意义，退回正常发送即可。 */
const STEER_MISS_PATTERN = /expectedturnid|expected turn|no active turn|not active|turn not found|already (?:finished|completed)/i;
const BRIDGE_VERSION = '1.12.4';
/* 延时探测别被 Codex 的忙闲拖住：HTTP 最多等 350ms，超了先用上一次采样；
   采样 1.5 秒内算新鲜，不必重复问 daemon。 */
const DAEMON_PROBE_DEADLINE_MS = 350;
const DAEMON_SAMPLE_TTL_MS = 1500;
/* Codex quota does not need latency-style polling. Cache both quota and the
   read-only CC Switch daily aggregate so opening the panel is instantaneous. */
const USAGE_SNAPSHOT_TTL_MS = 30000;
/* 临时会话的对话内容不落盘、也不支持 thread/read(includeTurns)，
   所以桥接层自己按序缓存它的事件，重开页面时前端再回放一遍。 */
const EPHEMERAL_EVENT_LIMIT = 4000;

/* 一次实测：某段会话 thread/read 回来 11MB，其中光 MCP 工具结果就有 4.7MB
   （联网搜索、文件读取，单条最大 65KB）。手机上 JSON.parse 这种体积要几百毫秒，
   而 6 秒一次的后台轮询还会反复付这笔钱 —— 表现就是「在输入框里打字特别卡」。
   所以桥接侧就把超长文本剪掉：保留开头和结尾（报错一般在结尾），中间省略。
   完整内容电脑上的 Codex 里还有，不影响那边的显示。 */
const SLIM_TOOL_RESULT_TEXT = 6000;
const SLIM_AGGREGATED_OUTPUT = 8000;
const SLIM_REASONING = 8000;
const SLIM_DIFF = 20000;
/* 兜底：结构里任何别的地方冒出超长字符串（比如内联的 base64 图）也不放过 */
const SLIM_ANY_STRING = 40000;
/* 默认只给手机最近这么多条记录，更早的靠前端「显示更早的」按需再拉。 */
const THREAD_ITEM_LIMIT = 500;
const THREAD_ITEM_LIMIT_MAX = 20000;

function isUnmaterializedHistoryError(error) {
  return /is not materialized yet;\s*thread\/turns\/list is unavailable before first user message\b/i.test(error?.message || '');
}

function clipForPhone(text, limit) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.5);
  const tail = limit - head;
  return (
    value.slice(0, head) +
    '\n…（已省略 ' +
    (value.length - limit) +
    ' 个字符，完整内容请在电脑上看）…\n' +
    value.slice(value.length - tail)
  );
}

function slimString(value, limit) {
  if (typeof value !== 'string') return value;
  return value.length > limit ? clipForPhone(value, limit) : value;
}

/* 结构里任何地方的超长字符串都剪一刀，防止以后新字段把 payload 撑爆 */
function slimLongStrings(value, depth) {
  if (depth > 8) return value;
  if (typeof value === 'string') return slimString(value, SLIM_ANY_STRING);
  if (Array.isArray(value)) {
    let changed = false;
    const copy = value.map((entry) => {
      const next = slimLongStrings(entry, depth + 1);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? copy : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = slimLongStrings(entry, depth + 1);
      if (next !== entry) changed = true;
      copy[key] = next;
    }
    return changed ? copy : value;
  }
  return value;
}

/* 只处理桥接自己发出去的那份拷贝，绝不改 daemon 传来的原对象。 */
function slimItemForPhone(item) {
  if (!item || typeof item !== 'object') return item;
  const out = Object.assign({}, item);

  if (typeof out.aggregatedOutput === 'string') {
    out.aggregatedOutput = slimString(out.aggregatedOutput, SLIM_AGGREGATED_OUTPUT);
  }
  if (Array.isArray(out.summary)) out.summary = out.summary.map((p) => slimString(p, SLIM_REASONING));
  if (out.type === 'reasoning' && Array.isArray(out.content)) {
    out.content = out.content.map((p) => slimString(p, SLIM_REASONING));
  }
  if (out.result && typeof out.result === 'object' && Array.isArray(out.result.content)) {
    out.result = Object.assign({}, out.result, {
      content: out.result.content.map((part) => {
        if (!part || typeof part !== 'object') return part;
        const copy = Object.assign({}, part);
        if (typeof copy.text === 'string') copy.text = slimString(copy.text, SLIM_TOOL_RESULT_TEXT);
        if (typeof copy.data === 'string') copy.data = slimString(copy.data, SLIM_TOOL_RESULT_TEXT);
        return copy;
      }),
    });
  }
  if (Array.isArray(out.changes)) {
    out.changes = out.changes.map((change) => {
      if (!change || typeof change !== 'object') return change;
      const copy = Object.assign({}, change);
      if (typeof copy.diff === 'string') copy.diff = slimString(copy.diff, SLIM_DIFF);
      return copy;
    });
  }
  return slimLongStrings(out, 0);
}

/* 只保留最近 limit 条记录：daemon 会把整段会话都给出来，31 分钟的会话实测
   2963 条，前端整块重画一次就是 10MB 的 DOM，手机上根本跟不上。 */
function limitThreadTurns(turns, limit) {
  const list = Array.isArray(turns) ? turns : [];
  let remaining = limit;
  let omitted = 0;
  const kept = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const turn = list[i];
    /* 没有 items 字段的 turn（老会话的 bare read）原样留着，别当成「被裁掉」 */
    if (!Array.isArray(turn && turn.items)) {
      kept.unshift(turn);
      continue;
    }
    const items = turn.items;
    const keptItems = [];
    for (let j = items.length - 1; j >= 0; j -= 1) {
      if (remaining > 0) {
        keptItems.unshift(slimItemForPhone(items[j]));
        remaining -= 1;
      } else {
        omitted += 1;
      }
    }
    /* 整轮的记录都被挤出去了就不返回这个 turn */
    if (keptItems.length === 0) continue;
    kept.unshift(Object.assign({}, turn, { items: keptItems }));
  }
  return { turns: kept, omitted };
}

/* 流式通知里也带 item（item/started、item/completed），同样要剪一刀，
   否则一条 65KB 的工具结果照样会塞进手机内存。 */
function slimNotificationParams(params) {
  if (!params || typeof params !== 'object' || !params.item) return params;
  return Object.assign({}, params, { item: slimItemForPhone(params.item) });
}

/* 运行中轮询只带最近一轮；一条工具输出/思考也可能很长，跟整段读取用同一套剪裁，
   免得每 2 秒都把几十 KB 推到手机上。 */
function slimTurnForPhone(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  if (!Array.isArray(turn.items)) return turn;
  return Object.assign({}, turn, { items: turn.items.slice(-400).map(slimItemForPhone) });
}

function clampItemLimit(raw) {
  const value = Number.parseInt(String(raw === undefined || raw === null ? '' : raw), 10);
  if (!Number.isFinite(value) || value <= 0) return THREAD_ITEM_LIMIT;
  return Math.min(value, THREAD_ITEM_LIMIT_MAX);
}

/* 一次开多少轮。轮数越多读得越慢（60 轮约 3 秒），首屏默认 20 轮足够铺满一屏。 */
const THREAD_TURN_LIMIT = 20;
const THREAD_TURN_LIMIT_MAX = 200;

function clampTurnLimit(raw) {
  const value = Number.parseInt(String(raw === undefined || raw === null ? '' : raw), 10);
  if (!Number.isFinite(value) || value <= 0) return THREAD_TURN_LIMIT;
  return Math.min(value, THREAD_TURN_LIMIT_MAX);
}

const CLIENT_ACCEPTS_GZIP = Symbol('clientAcceptsGzip');
/* 小于这个体积不值得压：gzip 对短 JSON 反而可能更大。 */
const GZIP_MIN_BYTES = 1024;

/* 手机上的「连接延时」经常高得离谱，根因多半不在程序里，而是手机走了
   Tailscale 之类的远端路径（本机实测过 relay "tok"，单程 200ms 起）。
   这里把客户端是从哪条路进来的算出来，界面才能给出「改用局域网地址」的提示。 */
function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function ipv4Octets(value) {
  const parts = String(value || '').replace(/^::ffff:/, '').split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets;
}

function isLanIpv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  /* Clash / Surge 这类代理的 TUN fake-ip 段，落在这里说明是本机直连。 */
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/* Tailscale / CGNAT 段（100.64.0.0/10）。 */
function isTailscaleIpv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function classifyRemoteAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '');
  if (!address) return 'unknown';
  if (address === '127.0.0.1' || address === '::1') return 'local';
  if (isTailscaleIpv4(address)) return 'tailscale';
  if (isLanIpv4(address)) return 'lan';
  return 'other';
}

/* 挑一个「真的在局域网里」的地址，跳过 Tailscale 和代理 TUN 的地址。 */
function preferredLanAddress(addresses) {
  const real = addresses.filter(
    (value) => isLanIpv4(value) && !isTailscaleIpv4(value) &&
      !/^198\.1[89]\./.test(value) && !/^169\.254\./.test(value)
  );
  return real[0] || null;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function parseArguments(argv, environment = process.env) {
  const options = {
    port: DEFAULT_PORT,
    host: '0.0.0.0',
    socketPath: defaultAppServerSocket(environment),
    autoStartDaemon: true,
    tokenFile: DEFAULT_TOKEN_FILE,
    name: process.env.CODEX_REMOTE_NAME || '',
    nameFile: DEFAULT_NAME_FILE,
    permissionFile: DEFAULT_PERMISSION_FILE,
    modelFile: DEFAULT_MODEL_FILE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--port' && next) {
      options.port = Number(next);
      index += 1;
    } else if (argument === '--host' && next) {
      options.host = next;
      index += 1;
    } else if (argument === '--socket' && next) {
      options.socketPath = next;
      options.autoStartDaemon = false;
      index += 1;
    } else if (argument === '--no-auto-start-daemon') {
      options.autoStartDaemon = false;
    } else if (argument === '--token-file' && next) {
      options.tokenFile = next;
      index += 1;
    } else if (argument === '--name' && next) {
      options.name = next;
      index += 1;
    } else if (argument === '--name-file' && next) {
      options.nameFile = next;
      index += 1;
    } else if (argument === '--permission-file' && next) {
      options.permissionFile = next;
      index += 1;
    } else if (argument === '--model-file' && next) {
      options.modelFile = next;
      index += 1;
    }
  }

  return options;
}

function roundMs(startedAt) {
  return Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 10) / 10;
}

/* Several machines can run this bridge at once; the name is what tells them
   apart in the browser tab and header. Precedence: --name / CODEX_REMOTE_NAME,
   then the persisted name file, then the machine's hostname. */
/* 手机上手打路径基本都会写 ~/…，而 path.resolve 不认 ~，会把 "~" 当成普通目录名，
   于是会话跑到 …/app/~/Documents/… 这种鬼地方，也就永远归不到项目底下。
   项目创建那里本来就展开了，这里抽出来给新建会话一起用。 */
function expandUserPath(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(1));
  return raw;
}

function sanitizeBridgeName(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function readBridgeName(options) {
  const fromOption = sanitizeBridgeName(options.name);
  if (fromOption) return fromOption;

  try {
    const fromFile = sanitizeBridgeName(fs.readFileSync(options.nameFile, 'utf8'));
    if (fromFile) return fromFile;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return sanitizeBridgeName(os.hostname().replace(/\.local$/i, '')) || 'Codex Remote';
}

function writeBridgeName(nameFile, name) {
  if (!nameFile) return;
  fs.mkdirSync(path.dirname(nameFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(nameFile, `${name}\n`, { mode: 0o600 });
}

function loadOrCreateToken(tokenFile) {
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function sniffImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if ((buffer[0] === 0x49 && buffer[1] === 0x49) || (buffer[0] === 0x4d && buffer[1] === 0x4d)) return 'image/tiff';
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return 'image/x-icon';
  return null;
}

function detectImageMime(buffer, ext) {
  const sniffed = sniffImageType(buffer);
  if (sniffed) return sniffed;
  if (ext === '.svg') return 'image/svg+xml';
  const generic = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
  return generic[ext] || null;
}

function sendJson(response, statusCode, payload) {
  /* 有些 daemon 方法（比如 turn/interrupt）成功时不带返回体，JSON.stringify(undefined)
     是 undefined，Buffer.from 会直接抛，结果把一个成功的操作报成 500。 */
  const raw = Buffer.from(JSON.stringify(payload === undefined ? null : payload), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  /* 一次完整会话读取实测 1.6MB，压完 424KB（level 4，约 14ms）——在中继链路上
     省下的是几秒的传输时间，值得用同步压缩换这点阻塞。 */
  if (response[CLIENT_ACCEPTS_GZIP] && raw.length >= GZIP_MIN_BYTES) {
    const compressed = zlib.gzipSync(raw, { level: 4 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = compressed.length;
    response.writeHead(statusCode, headers);
    response.end(compressed);
    return;
  }
  headers['Content-Length'] = raw.length;
  response.writeHead(statusCode, headers);
  response.end(raw);
}

async function readJsonBody(request, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

class Bridge {
  constructor(options) {
    this.options = options;
    this.token = loadOrCreateToken(options.tokenFile);
    this.bridgeName = readBridgeName(options);
    this.startedAt = Date.now();
    this.desktop = new DesktopConnection();
    this.desktop.on('state', (threadId, state) => this._handleDesktopState(threadId, state));
    this.desktop.on('protocolError', error => console.error(error.message));
    this.desktop.on('ready', () => {
      this._broadcast({ type: 'status', connected: this._isConnected(), desktopConnected: true });
      this._connectToAppServer();
    });
    this.desktop.on('close', () => {
      if (this.shuttingDown) return;
      this._broadcast({ type: 'status', connected: false, desktopConnected: false, error: 'ChatGPT 桌面连接已断开' });
      this._scheduleDesktopReconnect();
    });
    this.connection = null;
    this.appServerConnectPromise = null;
    this.daemonRecoveryRetryAt = 0;
    this.connectionError = 'starting';
    this.notifications = null;
    this.eventClients = new Set();
    this.pendingApprovals = new Map();
    this.activeTurns = new Map();
    /* 手机上点了中断的那一轮：rollout 里可能还留着 task_started 没写 task_complete，
       这里记一笔，别让它把「已中断」又翻回运行中。 */
    this.stoppedTurns = new Set();
    this.daemonTurnIds = new Set();
    /* Threads this bridge caused the daemon to load. The daemon keeps an
       exclusive writer lock on every loaded thread. Persistent conversations
       now run in ChatGPT; this map only tracks metadata creation and temporary
       conversations. Release metadata ownership before opening the desktop. */
    this.loadedThreads = new Map();
    /* 手机端发起的「临时对话」：ephemeral 会话不写盘，所以它不会出现在
       thread/list 里，daemon 只把它记在当前连接的内存中。这里自己留一份
       索引，侧边栏才能把它列出来、也才知道发消息时不能去 resume。 */
    this.ephemeralThreads = new Map();
    /* 每个会话的权限档位（用户显式设置过的才在这里），存在 ~/.codex-remote/permissions.json */
    this.permissions = loadPermissionMap(options.permissionFile);
    this.models = loadModelMap(options.modelFile);
    this.modelCatalog = null;
    this.modelCatalogPromise = null;
    /* daemon 报回来的「实际生效」设置，用来在电脑上改过之后仍然显示真实状态 */
    this.threadSettings = new Map();
    this.reconnectTimer = null;
    /* 最近一次「电脑 ↔ Codex」探测结果；busy 时拿它兜底，别让 /api/ping 跟着卡 */
    this.daemonLatency = null;
    this.daemonProbe = null;
    /* 探测失败（Codex 忙/卡住）之后先别连着再问，避免探测本身把 daemon 压得更忙 */
    this.daemonProbeBackoffUntil = 0;
    this.usageSnapshot = null;
    this.usageSnapshotPromise = null;
    this.rollout = new RolloutWatcher();
    this.rollout.start((threadId, snapshot, previous) => this._handleRolloutState(threadId, snapshot, previous));
  }

  /* Codex 忙的时候（正跑着好几轮），thread/loaded/list 会被排在后面，三次探测
     可能要好几秒 —— 那是 Codex 忙，不是链路慢。探测放到后台跑（同一时间只有
     一份），HTTP 最多等 deadlineMs，等不到就用上一次的采样，数字照常更新。 */
  async _daemonLatencySample(deadlineMs) {
    /* 上一轮探测刚失败过：先用手里的旧采样，过几秒再试，别在 Codex 忙的时候添乱 */
    if (!this.daemonProbe && Date.now() < this.daemonProbeBackoffUntil && this.daemonLatency) {
      return null;
    }
    if (!this.daemonProbe) {
      const probe = (async () => {
        const samples = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const probeStart = process.hrtime.bigint();
          await this.connection.request('thread/loaded/list', {}, { timeoutMs: 1200 });
          samples.push(roundMs(probeStart));
        }
        return { ok: true, ms: Math.min(...samples), error: null, at: Date.now() };
      })()
        .catch((error) => ({ ok: false, ms: null, error: error.message, at: Date.now() }))
        .then((sample) => {
          if (sample.ok) {
            this.daemonLatency = sample;
            this.daemonProbeBackoffUntil = 0;
          } else {
            /* 保留上一次成功的采样，界面继续显示它；同时退避几秒 */
            this.daemonProbeBackoffUntil = Date.now() + 5000;
          }
          return sample;
        })
        .finally(() => {
          this.daemonProbe = null;
        });
      this.daemonProbe = probe;
    }
    const current = this.daemonProbe;
    let timer = null;
    try {
      return await Promise.race([
        current,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), deadlineMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _readCodexRateLimits() {
    if (!this.connection || !this.connection.ready) {
      return { available: false, reason: 'disconnected', limits: [], resetCredits: null };
    }
    try {
      const result = await this.connection.request('account/rateLimits/read', {}, { timeoutMs: 5000 });
      const normalized = normalizeRateLimits(result);
      return normalized.available
        ? normalized
        : Object.assign(normalized, { reason: 'notAvailable' });
    } catch (error) {
      const message = error?.message || String(error);
      return {
        available: false,
        reason: /not supported|unknown method|method not found/i.test(message)
          ? 'unsupported'
          : 'queryFailed',
        limits: [],
        resetCredits: null,
      };
    }
  }

  async _readUsageSnapshot(force = false) {
    if (
      !force &&
      this.usageSnapshot &&
      Date.now() - this.usageSnapshot.fetchedAt < USAGE_SNAPSHOT_TTL_MS
    ) {
      return this.usageSnapshot;
    }
    if (this.usageSnapshotPromise) return this.usageSnapshotPromise;

    this.usageSnapshotPromise = Promise.all([
      this._readCodexRateLimits(),
      readCCSwitchUsage(),
    ])
      .then(([codex, ccSwitch]) => {
        this.usageSnapshot = { fetchedAt: Date.now(), codex, ccSwitch };
        return this.usageSnapshot;
      })
      .finally(() => {
        this.usageSnapshotPromise = null;
      });
    return this.usageSnapshotPromise;
  }

  async start() {
    const server = http.createServer((request, response) => {
      this._handleRequest(request, response).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { error: error.message });
        else response.end();
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, resolve);
    });

    /* Node 默认空闲 5 秒就关连接，而界面每 5 秒才探一次延时 —— 于是每次探测
       都得新建 TCP 连接，白白多一整个 RTT（远端路径上一两百毫秒）。把连接留热，
       探测数字才是真实往返，其它 API 调用也各少一个 RTT。 */
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 70000;

    this.httpServer = server;
    this._connectToAppServer();
    this.desktop.connect().catch(() => this._scheduleDesktopReconnect());

    this.releaseTimer = setInterval(() => {
      for (const threadId of [...this.loadedThreads.keys()]) {
        this.releaseThreadLock(threadId).catch(() => {});
      }
    }, 20000);

    const shutdown = () => {
      this.shuttingDown = true;
      clearTimeout(this.reconnectTimer);
      clearTimeout(this.desktopReconnectTimer);
      this.desktop.close();
      this.releaseAllThreadLocks().then(() => process.exit(0)).catch(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return server;
  }

  _createAppServerConnection() {
    return new AppServerConnection(this.options.socketPath);
  }

  _startDataDaemon() {
    return startManagedAppServer();
  }

  async _openDataConnection() {
    const connection = this._createAppServerConnection();
    this.connection = connection;
    this.modelCatalog = null;
    this.modelCatalogPromise = null;

    const current = () => this.connection === connection && !this.shuttingDown;
    connection.on('notification', (message) => { if (current()) this._handleNotification(message); });
    connection.on('serverRequest', (message) => { if (current()) this._handleServerRequest(message); });
    connection.on('error', (error) => {
      if (!current()) return;
      this.connectionError = error.message;
      this._broadcast({ type: 'status', connected: this._isConnected(), error: error.message });
    });
    connection.on('close', () => {
      if (!current()) return;
      this.connectionError = 'disconnected';
      this.usageSnapshot = null;
      this._broadcast({ type: 'status', connected: false, error: 'disconnected' });
      this._scheduleReconnect();
    });

    await connection.connect();
    if (!current()) {
      connection.close();
      return null;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connectionError = null;
    this.daemonRecoveryRetryAt = 0;
    this._broadcast({ type: 'status', connected: this._isConnected(), userAgent: connection.userAgent });
    return connection;
  }

  _connectToAppServer() {
    if (this.shuttingDown) return Promise.resolve(null);
    if (this.connection?.ready) return Promise.resolve(this.connection);
    if (this.appServerConnectPromise) return this.appServerConnectPromise;
    const pending = (async () => {
      try {
        return await this._openDataConnection();
      } catch (error) {
        const canRestore = ['ENOENT', 'ECONNREFUSED'].includes(error.code) &&
          this.options.autoStartDaemon !== false &&
          this.options.socketPath === defaultAppServerSocket() &&
          this.desktop?.ready && !this.shuttingDown &&
          Date.now() >= (this.daemonRecoveryRetryAt || 0);
        if (!canRestore) throw error;
        this.daemonRecoveryRetryAt = Date.now() + 30000;
        this.connectionError = '本地聊天数据服务正在启动';
        this._broadcast({ type: 'status', connected: false, error: this.connectionError });
        await this._startDataDaemon();
        if (this.shuttingDown) return null;
        return await this._openDataConnection();
      }
    })().catch((error) => {
      if (!this.shuttingDown) {
        this.connectionError = error.message;
        this._broadcast({ type: 'status', connected: false, error: error.message });
        this._scheduleReconnect();
      }
      return null;
    }).finally(() => {
      if (this.appServerConnectPromise === pending) this.appServerConnectPromise = null;
    });
    this.appServerConnectPromise = pending;
    return pending;
  }

  _scheduleReconnect() {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectToAppServer();
    }, 3000);
    this.reconnectTimer.unref?.();
  }

  async _ensureDataConnection() {
    if (!this.connection?.ready) await this._connectToAppServer();
    return this._requireConnection();
  }

  _isConnected() {
    return Boolean(this.connection?.ready && (!this.desktop || this.desktop.ready));
  }

  _scheduleDesktopReconnect() {
    if (this.shuttingDown || this.desktopReconnectTimer) return;
    this.desktopReconnectTimer = setTimeout(() => {
      this.desktopReconnectTimer = null;
      this.desktop.connect().catch(() => this._scheduleDesktopReconnect());
    }, 3000);
  }

  rolloutRunningTurns() {
    const result = {};
    for (const [threadId, snapshot] of this.rollout.states) {
      if (snapshot.running) result[threadId] = snapshot.turnId || 'rollout-' + threadId;
    }
    return result;
  }

  _handleRolloutState(threadId, snapshot, previous) {
    const daemonOwns =
      this.activeTurns.has(threadId) ||
      (snapshot.turnId && this.daemonTurnIds.has(snapshot.turnId));
    if (daemonOwns) return;

    const syntheticTurn = {
      id: snapshot.turnId || 'rollout-' + threadId,
      rootTurnId: snapshot.turnId || 'rollout-' + threadId,
      items: [],
      status: snapshot.running ? 'inProgress' : 'completed',
      itemsView: snapshot.running ? 'notLoaded' : 'full',
      error: null,
    };

    const wasRunning = Boolean(previous && previous.running);
    if (snapshot.running && !wasRunning) {
      this._broadcast({ type: 'notification', method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } });
      this._broadcast({ type: 'notification', method: 'turn/started', params: { threadId, turn: syntheticTurn } });
    } else if (!snapshot.running && wasRunning) {
      this._broadcast({ type: 'notification', method: 'turn/completed', params: { threadId, turn: syntheticTurn } });
      this._broadcast({ type: 'notification', method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
    }
  }

  /* 桌面端那一轮由它自己的连接持有，daemon 对 turns/list 的 status 并不可靠：
     实测 turn 还在追加 item 时，turns/list 会报 interrupted（手机会因此以为跑完了）。
     rollout 里的 task_started / task_complete 才是这一轮的真相，两边取并集。 */
  _rolloutRunningTurn(threadId) {
    if (!threadId) return null;
    const snapshot = this.rollout.states.get(threadId);
    if (!snapshot || !snapshot.running) return null;
    if (snapshot.turnId) {
      if (this.stoppedTurns.has(threadId + ':' + snapshot.turnId)) return null;
    }
    return snapshot.turnId || null;
  }

  _markTurnStopped(threadId, turnId) {
    if (!threadId || !turnId) return;
    this.stoppedTurns.add(threadId + ':' + turnId);
    if (this.stoppedTurns.size > 200) {
      const oldest = this.stoppedTurns.values().next();
      if (!oldest.done) this.stoppedTurns.delete(oldest.value);
    }
  }

  /* 把「rollout 说还在跑」这件事翻译成 turn 状态，前端只认 status === 'inProgress'。 */
  _applyRunningTurn(threadId, turn) {
    if (!turn || typeof turn !== 'object' || turn.status === 'inProgress') return turn;
    const rolloutTurnId = this._rolloutRunningTurn(threadId);
    if (!rolloutTurnId) return turn;
    if (turn.id && turn.id !== rolloutTurnId) return turn;
    if (turn.id) this.activeTurns.set(threadId, turn.id);
    return Object.assign({}, turn, { status: 'inProgress' });
  }

  _handleNotification(message) {
    const params = message.params || {};

    const ephemeralEntry = params.threadId ? this.ephemeralThreads.get(params.threadId) : null;
    if (ephemeralEntry) {
      const events = ephemeralEntry.events || (ephemeralEntry.events = []);
      /* 存剪过的那一份：一条工具结果原始能到 65KB，4000 条事件全留着就是几百 MB
         的常驻内存，而发给手机端的本来就是剪过的。 */
      events.push({ method: message.method, params: slimNotificationParams(params) });
      if (events.length > EPHEMERAL_EVENT_LIMIT) events.splice(0, events.length - EPHEMERAL_EVENT_LIMIT);
    }

    if (message.method === 'turn/started' && params.threadId && params.turn?.id) {
      this.activeTurns.set(params.threadId, params.turn.id);
      this.daemonTurnIds.add(params.turn.id);
      if (this.ephemeralThreads.has(params.threadId)) this._rememberEphemeral(params.threadId);
    } else if (message.method === 'turn/completed' && params.threadId) {
      if (this.activeTurns.get(params.threadId) === params.turn?.id) {
        this.activeTurns.delete(params.threadId);
      }
      const threadId = params.threadId;
      if (this.ephemeralThreads.has(threadId)) this._rememberEphemeral(threadId);
      setTimeout(() => {
        this.releaseThreadLock(threadId).catch(() => {});
      }, RELEASE_DELAY_MS);
    } else if (message.method === 'serverRequest/resolved') {
      const requestId = String(params.requestId ?? '');
      if (this.pendingApprovals.delete(requestId)) {
        this._broadcast({ type: 'approval-resolved', requestId });
      }
    } else if (message.method === 'thread/settings/updated' && params.threadId) {
      /* 电脑上改了模型/权限，这里跟着更新，手机上的档位显示才不会说谎 */
      this._recordThreadSettings(params.threadId, params.threadSettings);
      this._broadcast({
        type: 'permission',
        threadId: params.threadId,
        permission: this._permissionView(params.threadId),
      });
      this._broadcast({ type: 'model', threadId: params.threadId, modelSelection: this._modelView(params.threadId) });
    } else if (message.method === 'account/rateLimits/updated') {
      /* The notification can be a partial single-bucket update. Invalidate the
         complete snapshot and let clients re-read the authoritative map. */
      this.usageSnapshot = null;
      this._broadcast({ type: 'usage-invalidated' });
    }

    this._broadcast({
      type: 'notification',
      method: message.method,
      params: slimNotificationParams(message.params),
    });
  }

  _handleServerRequest(message) {
    const requestId = String(message.id);
    const record = {
      requestId,
      method: message.method,
      params: message.params ?? {},
      receivedAt: Date.now(),
    };
    this.pendingApprovals.set(requestId, record);
    this._broadcast({ type: 'approval', request: record });
  }

  _handleDesktopState(threadId, state) {
    if (!state) return;
    this._recordThreadSettings(threadId, state.latestThreadSettings || {
      model: state.latestModel, reasoningEffort: state.latestReasoningEffort,
    });
    const status = state.threadRuntimeStatus;
    if (status?.type === 'idle' || status?.type === 'notLoaded') this.activeTurns.delete(threadId);
    if (status) this._broadcast({ type: 'notification', method: 'thread/status/changed', params: { threadId, status } });
    this._broadcast({ type: 'model', threadId, modelSelection: this._modelView(threadId) });
    this._broadcast({ type: 'permission', threadId, permission: this._permissionView(threadId) });

    const seen = new Set();
    for (const request of state.requests || []) {
      if (request.id === undefined || !request.method) continue;
      const requestId = `desktop:${threadId}:${request.id}`;
      seen.add(requestId);
      if (this.pendingApprovals.has(requestId)) continue;
      const record = {
        requestId, desktop: true, desktopRequestId: request.id, threadId,
        method: request.method, params: { ...request.params, threadId }, receivedAt: Date.now(),
      };
      this.pendingApprovals.set(requestId, record);
      this._broadcast({ type: 'approval', request: record });
    }
    for (const [requestId, record] of this.pendingApprovals) {
      if (record.desktop && record.threadId === threadId && !seen.has(requestId)) {
        this.pendingApprovals.delete(requestId);
        this._broadcast({ type: 'approval-resolved', requestId });
      }
    }
  }

  _observeDesktopThread(threadId) {
    if (!this.desktop || this.ephemeralThreads.has(threadId) || this.desktop.following.has(threadId)) return;
    /* Observation never opens a window or takes the writer. */
    this.desktop.findOwner(threadId).then(owner => {
      if (owner) this.desktop.follow(threadId, owner.clientId);
    }).catch(() => {});
  }

  _broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.eventClients) {
      try {
        client.write(payload);
      } catch (error) {
        this.eventClients.delete(client);
      }
    }
  }

  async _handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    response[CLIENT_ACCEPTS_GZIP] = /\bgzip\b/i.test(request.headers['accept-encoding'] || '');

    const urlToken = url.searchParams.get('token');
    if (urlToken !== null) {
      if (!safeEqual(urlToken, this.token)) {
        sendJson(response, 401, { error: 'invalid token' });
        return;
      }
      url.searchParams.delete('token');
      const location = `${url.pathname}${url.search}`;
      response.writeHead(302, {
        Location: location,
        'Set-Cookie': `${COOKIE_NAME}=${this.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      });
      response.end();
      return;
    }

    if (!this._isAuthorized(request, url)) {
      sendJson(response, 401, { error: 'unauthorized', hint: 'open /?token=<token> once' });
      return;
    }

    if (url.pathname === '/events') {
      this._handleEventStream(request, response);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await this._handleApi(request, response, url);
      return;
    }

    this._serveStatic(response, url.pathname);
  }

  _isAuthorized(request, url) {
    const header = request.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const cookie = readCookie(request.headers.cookie, COOKIE_NAME);
    return (
      safeEqual(bearer, this.token) ||
      safeEqual(cookie, this.token) ||
      safeEqual(url.searchParams.get('token'), this.token)
    );
  }

  _handleEventStream(request, response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    this.eventClients.add(response);
    const helloActiveTurns = Object.assign({}, this.activeTurns, this.rolloutRunningTurns());
    response.write(
      `data: ${JSON.stringify({
        type: 'hello',
        connected: this._isConnected(),
        userAgent: this.connection?.userAgent ?? null,
        error: this.connectionError,
        pendingApprovals: [...this.pendingApprovals.values()],
        activeTurns: helloActiveTurns,
      })}\n\n`
    );

    const heartbeat = setInterval(() => {
      try {
        response.write(': keepalive\n\n');
      } catch (error) {
        clearInterval(heartbeat);
      }
    }, 25000);

    request.on('close', () => {
      clearInterval(heartbeat);
      this.eventClients.delete(response);
    });
  }

  _markThreadLoaded(threadId) {
    if (threadId) this.loadedThreads.set(threadId, Date.now());
  }

  _rememberEphemeral(threadId, extra = {}) {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.ephemeralThreads.get(threadId) || {};
    this.ephemeralThreads.set(threadId, Object.assign({}, existing, extra, {
      id: threadId,
      ephemeral: true,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    }));
  }

  /* 临时会话在 thread/list 里不存在，这里把它拼回列表，侧边栏才看得到 */
  _mergeEphemeralThreads(threads) {
    if (this.ephemeralThreads.size === 0) return threads;
    const seen = new Set(threads.map((thread) => thread.id));
    const extras = [];
    for (const entry of this.ephemeralThreads.values()) {
      if (seen.has(entry.id)) continue;
      extras.push({
        id: entry.id,
        cwd: entry.cwd || '',
        name: entry.name || '',
        preview: entry.preview || '',
        ephemeral: true,
        status: this.activeTurns.has(entry.id) ? { type: 'active' } : { type: 'notLoaded' },
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    return extras.concat(threads);
  }

  async releaseThreadLock(threadId, options = {}) {
    if (!threadId || !this.loadedThreads.has(threadId)) return false;
    /* 临时会话不写盘，由桥接独占，不需要把写锁让给桌面端。 */
    if (this.ephemeralThreads.has(threadId)) return false;
    if (this.activeTurns.has(threadId)) return false;
    /* Never yank the lock out from under an in-flight resume/turn-start pair. */
    if (!options.force && Date.now() - this.loadedThreads.get(threadId) < LOAD_GRACE_MS) return false;
    const snapshot = this.rollout.states.get(threadId);
    if (snapshot && snapshot.running) return false;
    if (!this.connection || !this.connection.ready) return false;

    /* 放锁前再跟 daemon 对一次最新一轮。桥接没收到桌面端那一轮的 turn 通知，
       只看本地缓存就可能把正在跑的会话卸载——之后 turn/interrupt 会报
       "thread not found"，表现就是手机上一直中断不了。 */
    let latest;
    try {
      latest = await this._latestTurn(threadId);
    } catch (error) {
      if (/thread not found/i.test(error.message || '')) {
        this.loadedThreads.delete(threadId);
        return true;
      }
      return false;
    }
    if (latest && latest.status === 'inProgress') {
      if (latest.id) this.activeTurns.set(threadId, latest.id);
      return false;
    }

    try {
      try {
        const result = await this.connection.request('thread/unsubscribe', { threadId });
        if (!['notLoaded', 'notSubscribed', 'unsubscribed'].includes(result?.status)) {
          throw new Error('ChatGPT 未确认取消聊天订阅。');
        }
      } catch (error) {
        /* Older data servers need the legacy handoff. An uncertain result
           must stay tracked, never trigger another mutation as a fallback. */
        const unsupported = error.rpcError?.code === -32601 ||
          /unknown method|method not found|unknown variant.*thread\/unsubscribe/i.test(error.message || '');
        if (error.timedOut || !unsupported) throw error;
        await this.connection.request('thread/archive', { threadId });
        await this.connection.request('thread/unarchive', { threadId });
      }
      this.loadedThreads.delete(threadId);
      console.log(`released writer lock for ${threadId}`);
      return true;
    } catch (error) {
      console.error(`failed to release writer lock for ${threadId}: ${error.message}`);
      return false;
    }
  }

  async releaseAllThreadLocks() {
    const ids = [...this.loadedThreads.keys()];
    for (const threadId of ids) {
      await this.releaseThreadLock(threadId, { force: true });
    }
  }

  _requireConnection() {
    if (!this.connection || !this.connection.ready) {
      const error = new Error(
        `聊天数据接口未连接（${this.connectionError || 'unknown'}）。请打开 ChatGPT 并检查配置的 app-server socket。`
      );
      error.statusCode = 503;
      throw error;
    }
    return this.connection;
  }

  /* A thread that has never been named nor run has no turns in the daemon index
     yet, and `thread/read` with turns fails with "list_turns is not supported
     yet". Fall back to the turn-less read so brand new chats still open. */
  /* daemon 侧实际生效的权限设置。thread/start、thread/resume 的返回值和
     thread/settings/updated 通知里都有，攒起来给手机显示真实状态。 */
  _recordThreadSettings(threadId, settings) {
    if (!threadId || !settings) return;
    const source = settings.threadSettings || settings;
    const merged = Object.assign({}, this.threadSettings.get(threadId));
    /* A legacy thread/read can contain megabytes of turns. Cache only the
       settings used by the composer, never the full response or history. */
    for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'sandboxPolicy', 'modelProvider', 'effort', 'reasoningEffort']) {
      if (Object.hasOwn(source, key)) merged[key] = source[key];
    }
    const model = effectiveModel(source, settings.thread);
    if (model) {
      merged.model = model.model;
      merged.effort = model.reasoningEffort;
    }
    this.threadSettings.set(threadId, merged);
  }

  async _listModels(refresh = false) {
    const connection = await this._ensureDataConnection();
    if (!refresh && this.modelCatalog && Date.now() - this.modelCatalog.at < MODEL_CATALOG_TTL_MS) {
      return this.modelCatalog.data;
    }
    if (this.modelCatalogPromise) return this.modelCatalogPromise;
    const pending = (async () => {
      const entries = [];
      const cursors = new Set();
      let cursor = null;
      do {
        const result = await connection.request('model/list', Object.assign(
          { limit: 100, includeHidden: false }, cursor ? { cursor } : {}
        ), { timeoutMs: 10000 });
        if (Array.isArray(result.data)) entries.push(...result.data);
        cursor = result.nextCursor || null;
        if (cursor && cursors.has(cursor)) throw new Error('model/list returned a repeated cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const data = normalizeCatalog(entries);
      if (this.connection === connection) this.modelCatalog = { at: Date.now(), data };
      return data;
    })();
    this.modelCatalogPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.modelCatalogPromise === pending) this.modelCatalogPromise = null;
    }
  }

  async _validateModelSelection(value) {
    const selection = normalizeSelection(value);
    if (!selection.model) return selection;
    return validateSelection(selection, await this._listModels());
  }

  _modelView(threadId, thread) {
    return Object.assign({ model: null, reasoningEffort: null }, this.models[threadId], {
      effective: effectiveModel(this.threadSettings.get(threadId), thread),
    });
  }

  _setModel(threadId, selection) {
    const next = Object.assign(Object.create(null), this.models);
    if (selection.model) next[threadId] = selection;
    else delete next[threadId];
    if (!this.ephemeralThreads.has(threadId)) {
      const persisted = Object.fromEntries(Object.entries(next).filter(([id]) => !this.ephemeralThreads.has(id)));
      saveModelMap(this.options.modelFile, persisted);
    }
    this.models = next;
    const modelSelection = this._modelView(threadId);
    this._broadcast({ type: 'model', threadId, modelSelection });
    return modelSelection;
  }

  _permissionView(threadId) {
    const mode = this.permissions[threadId] || 'default';
    const settings = this.threadSettings.get(threadId) || null;
    const hasPermissions = settings && (settings.approvalPolicy != null || settings.sandbox != null || settings.sandboxPolicy != null);
    return {
      mode,
      effective: hasPermissions
        ? {
            approvalPolicy: settings.approvalPolicy || null,
            sandbox: sandboxLabel(settings.sandbox || settings.sandboxPolicy),
            reviewer: reviewerLabel(settings.approvalsReviewer),
            mode: modeFromSettings(settings),
          }
        : null,
    };
  }

  _setPermission(threadId, mode) {
    const normalized = normalizeMode(mode);
    if (normalized === 'default') delete this.permissions[threadId];
    else this.permissions[threadId] = normalized;
    try {
      savePermissionMap(this.options.permissionFile, this.permissions);
    } catch (error) {
      /* 落盘失败不该拦住这次设置，内存里已经生效 */
    }
    return this._permissionView(threadId);
  }

  /* 内存里的 activeTurns 只是缓存：daemon 不一定每次都发 turn/completed（实测被中断
     的那一轮就没有），漏一次这里就会一直以为会话还在跑，引导/中断和「跑完自动发」都会
     卡住。每次真读会话都拿服务端的 turn 状态校准一次。 */
  _reconcileActiveTurn(threadId, turns) {
    /* 空数组说明这次读压根没带 turn 信息（临时会话不支持 includeTurns、老会话
       "list_turns is not supported yet"），不能当成「没在跑」——否则会把正在跑的
       会话误判成空闲，引导会退化成再开一轮，两个 turn 并行。 */
    if (!threadId || !Array.isArray(turns) || turns.length === 0) return;
    /* 桌面端在跑的那一轮，daemon 可能报 interrupted；rollout 说在跑就别清缓存 */
    const rolloutTurnId = this._rolloutRunningTurn(threadId);
    if (rolloutTurnId) {
      this.activeTurns.set(threadId, rolloutTurnId);
      return;
    }
    const running = [...turns].reverse().find((turn) => turn && turn.status === 'inProgress');
    if (running && running.id) this.activeTurns.set(threadId, running.id);
    else if (!running) this.activeTurns.delete(threadId);
  }

  async _readThread(threadId) {
    try {
      const result = await this.connection.request('thread/read', { threadId, includeTurns: true });
      this._recordThreadSettings(threadId, result);
      this._reconcileActiveTurn(threadId, result && result.thread && result.thread.turns);
      return result;
    } catch (error) {
      const message = error && error.message ? error.message : '';
      /* 两种情况都要退回「不带 turn」的读取：老会话报 "list_turns is not
         supported yet"，临时会话报 "ephemeral threads do not support
         includeTurns"。临时会话的 turn 由 _mergeEphemeralEvents 之外的事件
         日志补回（见 GET /api/threads/:id）。 */
      if (!/not supported/i.test(message) && !/do not support/i.test(message)) throw error;
      const bare = await this.connection.request('thread/read', { threadId });
      this._recordThreadSettings(threadId, bare);
      return Object.assign({}, bare, {
        thread: Object.assign({}, bare && bare.thread, {
          turns: (bare && bare.thread && bare.thread.turns) || [],
        }),
      });
    }
  }

  /* 长会话不要整段读：thread/read includeTurns 会把这个 84MB 的 rollout 全解析一遍
     （实测 4–9 秒），而 thread/turns/list 取最近 10 轮只要 8ms。这里按「最近 N 轮」
     开窗，元数据单独读（4ms），再用 nextCursor 判断后面还有没有。 */
  async _readThreadWindow(threadId, turnLimit) {
    let meta;
    try {
      meta = await this.connection.request('thread/read', { threadId });
      this._recordThreadSettings(threadId, meta);
      const list = await this.connection.request('thread/turns/list', {
        threadId,
        limit: turnLimit,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      const turns = Array.isArray(list && list.data) ? list.data.slice().reverse() : [];
      this._reconcileActiveTurn(threadId, turns);
      return {
        thread: Object.assign({}, meta && meta.thread, {
          turns,
          hasMoreTurns: Boolean(list && list.nextCursor),
        }),
        windowed: true,
      };
    } catch (error) {
      /* Paginated metadata is already persistent, but the first turn does
         not exist until the first user message. Keep the verified metadata
         and show an empty history without hiding genuine missing threads. */
      if (meta?.thread && isUnmaterializedHistoryError(error)) {
        return {
          thread: Object.assign({}, meta.thread, { turns: [], hasMoreTurns: false }),
          windowed: true,
        };
      }
      const message = error && error.message ? error.message : '';
      if (!/not supported|do not support|unknown method|method not found|no rollout found/i.test(message)) {
        throw error;
      }
      const result = await this._readThread(threadId);
      return {
        thread: Object.assign({}, result && result.thread, { hasMoreTurns: false }),
        windowed: false,
      };
    }
  }

  /* 只取最近一轮。桌面端点开一个会话时，它那一轮由桌面自己的连接持有；
     桥接这边拿不到 item 的实时通知，但可以用这个轻量接口读到进行到哪了。
     比整套 thread/read 小得多（itemsView=notLoaded 时只有 turn 元数据）。 */
  async _latestTurn(threadId, itemsView = 'notLoaded') {
    try {
      const result = await this.connection.request('thread/turns/list', {
        threadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView,
      });
      const latest = Array.isArray(result?.data) ? result.data[0] : null;
      if (latest && latest.id) {
        const rolloutTurnId = this._rolloutRunningTurn(threadId);
        if (latest.status === 'inProgress' || rolloutTurnId === latest.id) {
          this.activeTurns.set(threadId, latest.id);
        } else if (this.activeTurns.get(threadId) === latest.id) {
          this.activeTurns.delete(threadId);
        }
      }
      return latest || null;
    } catch (error) {
      const message = error && error.message ? error.message : '';
      if (/no rollout found/i.test(message) || isUnmaterializedHistoryError(error)) return null;
      if (!/not supported|unknown method|method not found/i.test(message)) throw error;
      const read = await this._readThread(threadId);
      const turns = read?.thread?.turns ?? [];
      return turns.length ? turns[turns.length - 1] : null;
    }
  }

  async _handleApi(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean);

    try {
      if (segments[1] === 'meta' && segments.length === 2) {
        if (request.method === 'GET') {
          sendJson(response, 200, {
            name: this.bridgeName,
            hostname: os.hostname(),
            host: os.hostname().replace(/\.local$/i, ''),
            listenHost: this.options.host,
            platform: process.platform,
            version: BRIDGE_VERSION,
            startedAt: this.startedAt,
            connected: this._isConnected(),
            dataConnected: Boolean(this.connection?.ready),
            desktopConnected: Boolean(this.desktop?.ready),
            executionBackend: 'chatgpt-desktop',
          });
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request, 8 * 1024);
          const name = sanitizeBridgeName(body.name);
          if (!name) {
            sendJson(response, 400, { error: 'name is required' });
            return;
          }
          try {
            writeBridgeName(this.options.nameFile, name);
          } catch (error) {
            sendJson(response, 500, { error: 'could not persist name: ' + error.message });
            return;
          }
          this.bridgeName = name;
          sendJson(response, 200, { ok: true, name });
          return;
        }
      }

      if (segments[1] === 'status' && segments.length === 2) {
        sendJson(response, 200, {
          connected: this._isConnected(),
          dataConnected: Boolean(this.connection?.ready),
          userAgent: this.connection?.userAgent ?? null,
          socketPath: this.options.socketPath,
          desktopConnected: Boolean(this.desktop?.ready),
          desktopSocketPath: this.desktop?.socketPath ?? null,
          error: this.connectionError || (this.desktop && !this.desktop.ready ? 'ChatGPT 桌面未连接' : null),
        });
        return;
      }

      if (segments[1] === 'usage' && segments.length === 2 && request.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        sendJson(response, 200, await this._readUsageSnapshot(force));
        return;
      }

      /* 给手机端的「连接延时」按钮用：一次请求同时量出浏览器↔桥接和桥接↔Codex 两段。
         thread/loaded/list 是最便宜的调用（无副作用、通常 1ms 以内），适合当探针。 */
      if (segments[1] === 'ping' && segments.length === 2 && request.method === 'GET') {
        const startedAt = process.hrtime.bigint();
        const payload = {
          ok: true,
          now: Date.now(),
          version: BRIDGE_VERSION,
          connected: this._isConnected(),
          clients: this.eventClients.size,
          daemon: { ok: false, ms: null, error: null },
        };
        if (payload.connected) {
          const cached = this.daemonLatency;
          if (cached && Date.now() - cached.at < DAEMON_SAMPLE_TTL_MS) {
            payload.daemon = {
              ok: cached.ok,
              ms: cached.ms,
              error: cached.error,
              cached: false,
              busy: false,
            };
          } else {
            /* 连着问三次取最小值：单次调用偶尔会被 daemon 的其它活儿拖慢，
               这不是链路延时，取最小值更接近真实往返。等不到就用上次的。 */
            const sample = await this._daemonLatencySample(DAEMON_PROBE_DEADLINE_MS);
            if (sample && sample.ok) {
              payload.daemon = { ok: true, ms: sample.ms, error: null, cached: false };
            } else if (cached) {
              /* 这次没测到（Codex 忙 / 探测卡住）：显示上次的，并标明「忙」，
                 别让界面误报成 Codex 掉线 */
              payload.daemon = {
                ok: true,
                ms: cached.ms,
                error: null,
                cached: true,
                busy: !(sample && sample.ok),
              };
            } else {
              payload.daemon = {
                ok: false,
                ms: null,
                error: (sample && sample.error) || 'Codex 正忙，稍后再测',
                cached: false,
                busy: true,
              };
            }
          }
        } else {
          payload.daemon.error = this.connectionError || 'app-server not connected';
        }
        /* 手机是从哪条路进来的。走 tailscale 且不是局域网时，顺手给出局域网直连地址
           （带 token，点一下就能免重新登录切过去）。 */
        const remoteAddress = request.socket?.remoteAddress || null;
        const path = classifyRemoteAddress(remoteAddress);
        const lanAddress = preferredLanAddress(localAddresses());
        payload.client = {
          ip: remoteAddress,
          path,
          lanAddress,
          lanUrl:
            lanAddress && path !== 'lan' && path !== 'local'
              ? `http://${lanAddress}:${this.options.port}/?token=${this.token}`
              : null,
        };
        /* 只看 IP 段分不出「Tailscale 直连」和「DERP 中继」；走 Tailscale 时
           顺便读一下 Peer 的真实状态，界面才能说清楚该不该继续折腾。 */
        if (path === 'tailscale') {
          payload.client.tailscale = tailscaleClientInfo(remoteAddress);
        }
        /* 服务端自己处理这次请求花了多久：手机端用它把「链路往返」从总耗时里减掉，
           免得 Codex 一忙，连链路延时也跟着看起来变高。 */
        payload.serverMs = roundMs(startedAt);
        sendJson(response, 200, payload);
        return;
      }

      if (segments[1] === 'upload' && segments.length === 2 && request.method === 'POST') {
        const body = await readJsonBody(request, 32 * 1024 * 1024);
        const dataUrl = String(body.dataUrl || '');
        const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
        if (!match) {
          sendJson(response, 400, { error: 'dataUrl must be a base64 image' });
          return;
        }
        const mime = match[1].toLowerCase();
        const buffer = Buffer.from(match[2], 'base64');
        const ext = detectImageMime(buffer, IMAGE_EXT[mime] || '');
        if (!ext) {
          sendJson(response, 415, { error: 'unsupported or invalid image' });
          return;
        }
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const file = path.join(UPLOAD_DIR, `upload-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${IMAGE_EXT[mime] || '.png'}`);
        fs.writeFileSync(file, buffer);
        sendJson(response, 200, { path: file, bytes: buffer.length, mime });
        return;
      }

      if (segments[1] === 'file' && segments.length === 2 && request.method === 'GET') {
        this._serveImage(request, response, url);
        return;
      }

      /* 档位设置不需要连着 daemon，先把它们处理掉 */
      if (segments[1] === 'permissions' && segments.length === 2 && request.method === 'GET') {
        sendJson(response, 200, { profiles: profileList(), modes: this.permissions });
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'permissions' && request.method === 'POST') {
        const body = await readJsonBody(request, 8 * 1024);
        const permission = this._setPermission(segments[2], body.mode);
        /* 立刻生效靠的是下一条消息（_deliverMessage 会把档位带下去）；
           这里只回执，不去 resume——否则会抢走电脑的写锁。 */
        sendJson(response, 200, Object.assign({ ok: true }, permission));
        return;
      }

      if (segments[1] === 'models' && segments.length === 2 && request.method === 'GET') {
        sendJson(response, 200, { data: await this._listModels(url.searchParams.get('refresh') === '1') });
        return;
      }

      if (segments[1] === 'threads' && segments.length === 4 && segments[3] === 'model' && request.method === 'POST') {
        const body = await readJsonBody(request, 8 * 1024);
        const selection = await this._validateModelSelection(body);
        /* Save a next-turn choice without resuming or taking the desktop's writer lock. */
        const modelSelection = this._setModel(segments[2], selection);
        sendJson(response, 200, { ok: true, modelSelection });
        return;
      }

      /* Desktop operations do not depend on the separate history/data socket.
         Only data API calls require it, at the point a request is made. */
      const connection = { request: async (...args) => (await this._ensureDataConnection()).request(...args) };

      if (segments[1] === 'new-thread' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
        const mode = normalizeMode(body.permission);
        const selection = await this._validateModelSelection({ model: body.model, reasoningEffort: body.reasoningEffort });
        /* 临时对话 = daemon 的 ephemeral 会话：不落盘、不进历史，关掉就没了 */
        const ephemeral = body.ephemeral === true;
        const requested = expandUserPath(body.cwd);
        let cwd = requested ? path.resolve(requested) : path.join(os.homedir(), 'Documents', 'Codex', 'chat');
        try {
          fs.mkdirSync(cwd, { recursive: true });
        } catch (error) {
          /* 用户自己填的路径建不出来就说清楚；默默丢到 home 目录只会让人更困惑 */
          if (requested) {
            const failure = new Error(`工作文件夹不可用：${cwd}（${error.message}）`);
            failure.statusCode = 400;
            throw failure;
          }
          cwd = os.homedir();
        }
        const created = await connection.request(
          'thread/start',
          Object.assign({ cwd }, ephemeral ? { ephemeral: true } : { historyMode: 'paginated' },
            permissionThreadParams(mode), modelThreadParams(selection))
        );
        const threadId = created?.thread?.id;
        this._markThreadLoaded(threadId);
        if (!threadId) {
          const error = new Error('thread/start did not return a thread id');
          error.statusCode = 502;
          throw error;
        }
        if (ephemeral) this._rememberEphemeral(threadId, { cwd, name });
        if (mode !== 'default') this._setPermission(threadId, mode);
        this._recordThreadSettings(threadId, created);
        if (selection.model) this._setModel(threadId, selection);
        /* The daemon drops an unmaterialized empty chat when its creating
           connection closes. Saving a name indexes it without starting a
           model turn, including when the user leaves the name field blank. */
        const savedName = name || (ephemeral ? '' : '新对话');
        if (savedName) {
          try {
            await connection.request('thread/name/set', { threadId, name: savedName });
          } catch (error) {
            if (!ephemeral) {
              const failure = new Error(`新对话建档未确认：${error.message}。请刷新列表查看创建结果。`, { cause: error });
              failure.statusCode = 502;
              throw failure;
            }
            /* Temporary names are best-effort; their metadata stays in memory. */
          }
        }
        /* Nothing is running in a brand new chat, so the writer lock can go
           back right away and the desktop app can open it immediately.
           临时会话桌面端看不到，写锁自己留着。 */
        if (!ephemeral) await this.releaseThreadLock(threadId, { force: true });
        sendJson(response, 200, { thread: Object.assign({}, created.thread, savedName ? { name: savedName } : {}) });
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'name' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
        if (!name) {
          sendJson(response, 400, { error: 'name is required' });
          return;
        }
        const result = await connection.request('thread/name/set', { threadId: segments[2], name });
        sendJson(response, 200, Object.assign({ ok: true, name }, result || {}));
        return;
      }

      if (segments[1] === 'threads' && segments.length === 2 && request.method === 'GET') {
        const params = {
          limit: Number(url.searchParams.get('limit') || 30),
          archived: url.searchParams.get('archived') === 'true',
        };
        const searchTerm = url.searchParams.get('search');
        if (searchTerm) params.searchTerm = searchTerm;
        const cursor = url.searchParams.get('cursor');
        if (cursor) params.cursor = cursor;
        const result = await connection.request('thread/list', params);
        const data = this._mergeEphemeralThreads(Array.isArray(result.data) ? result.data : []);
        /* 侧边栏的「运行中」也认 rollout：桌面端在跑时 daemon 的 status 可能还是 idle */
        for (const thread of data) {
          if (thread && this._rolloutRunningTurn(thread.id)) {
            thread.status = Object.assign({}, thread.status, { type: 'active' });
          }
        }
        sendJson(response, 200, Object.assign({}, result, { data }));
        return;
      }

      /* 项目 = daemon 里的一份 {name, roots[]} 记录；会话按 cwd 落在项目根目录下。
         桌面端侧边栏的「项目」分组就是这个。 */
      if (segments[1] === 'projects' && segments.length === 2) {
        if (request.method === 'GET') {
          const result = await connection.request('project/list', {});
          sendJson(response, 200, { data: Array.isArray(result.data) ? result.data : [] });
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
          const raw = typeof body.path === 'string' ? body.path.trim() : '';
          if (!name) {
            sendJson(response, 400, { error: 'name is required' });
            return;
          }
          if (!raw) {
            sendJson(response, 400, { error: 'path is required' });
            return;
          }
          const rootPath = path.resolve(expandUserPath(raw));
          const created = await connection.request('project/create', {
            name,
            roots: [{ path: rootPath }],
            idempotencyKey: crypto.randomUUID(),
          });
          sendJson(response, 200, created);
          return;
        }
      }

      /* 结束临时对话：daemon 那边它本来就是内存里的，断开即可；这里把它从
         侧边栏索引里摘掉。 */
      if (segments[1] === 'ephemeral' && segments[2] === 'close' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const threadId = String(body.threadId || '');
        this.ephemeralThreads.delete(threadId);
        this.activeTurns.delete(threadId);
        delete this.models[threadId];
        this.threadSettings.delete(threadId);
        try {
          await connection.request('thread/unsubscribe', { threadId });
        } catch (error) {
          /* best-effort：daemon 侧不是所有版本都支持 */
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'attach' && request.method === 'POST') {
        const threadId = segments[2];
        const result = await this._attachThread(threadId);
        sendJson(response, 200, result);
        return;
      }

      /* 运行中的轻量回读：只取最近一轮（带 items），给手机做 2 秒一次的
         实时刷新。整段 thread/read 可能有一两 MB，不能拿来做轮询。 */
      if (segments[1] === 'threads' && segments[3] === 'live' && request.method === 'GET') {
        const threadId = segments[2];
        let turn = null;
        let liveError = null;
        /* light=1 只回 turn 元数据，不带 items：会话空闲时手机用它探测「有没有新一轮」，
           不用每 6 秒把几百条记录重新传一遍。 */
        const light = url.searchParams.get('light') === '1';
        try {
          turn = light
            ? await this._latestTurn(threadId, 'notLoaded')
            : slimTurnForPhone(await this._latestTurn(threadId, 'full'));
        } catch (error) {
          liveError = error.message;
        }
        /* 只信 daemon 的 status 会把桌面端还在跑的轮次报成已完成；rollout 说在跑时
           以 rollout 为准，并把 status 改写成 inProgress 给前端用。 */
        turn = this._applyRunningTurn(threadId, turn);
        if (light && turn) {
          turn = {
            id: turn.id,
            status: turn.status,
            startedAt: turn.startedAt,
            completedAt: turn.completedAt,
            error: turn.error || null,
          };
        }
        const rolloutTurnId = this._rolloutRunningTurn(threadId);
        const running = Boolean(turn && turn.status === 'inProgress') || Boolean(rolloutTurnId);
        const activeTurnId = (turn && turn.id) || rolloutTurnId;
        if (running && activeTurnId) this.activeTurns.set(threadId, activeTurnId);
        else if (turn) this.activeTurns.delete(threadId);
        sendJson(response, 200, {
          turn,
          running,
          turnId: running ? activeTurnId : null,
          attached: this.loadedThreads.has(threadId) || Boolean(this.desktop?.following.has(threadId)),
          modelSelection: this._modelView(threadId),
          error: liveError,
        });
        return;
      }

      if (segments[1] === 'threads' && segments.length === 3 && request.method === 'GET') {
        const threadId = segments[2];
        this._observeDesktopThread(threadId);
        const ephemeralEntry = this.ephemeralThreads.get(threadId);
        const limit = clampItemLimit(url.searchParams.get('limit'));
        const turnLimit = clampTurnLimit(url.searchParams.get('turns'));
        const result = await this._readThreadWindow(threadId, turnLimit);
        const trimmed = limitThreadTurns(result && result.thread && result.thread.turns, limit);
        const trimmedResult = Object.assign({}, result, {
          thread: Object.assign({}, result && result.thread, {
            turns: trimmed.turns,
            omittedItems: trimmed.omitted,
          }),
        });
        /* daemon 有时把还在跑的 turn 报成 interrupted，用 rollout 补一次状态，
           否则刷新页面后会把「运行中」当成已经跑完，连计时和中断按钮都不见了。 */
        const rolloutTurnId = this._rolloutRunningTurn(threadId);
        if (rolloutTurnId && Array.isArray(trimmedResult.thread.turns)) {
          trimmedResult.thread.turns = trimmedResult.thread.turns.map((turn) => {
            if (!turn || turn.id !== rolloutTurnId || turn.status === 'inProgress') return turn;
            return Object.assign({}, turn, { status: 'inProgress' });
          });
          if (!this.activeTurns.has(threadId)) this.activeTurns.set(threadId, rolloutTurnId);
        }
        if (this.activeTurns.get(threadId) && trimmedResult.thread) {
          trimmedResult.thread.status = Object.assign({}, trimmedResult.thread.status, {
            type: 'active',
          });
        }
        const payload = Object.assign({}, trimmedResult, {
          permission: this._permissionView(threadId),
          modelSelection: this._modelView(threadId, trimmedResult.thread),
          attached: this.loadedThreads.has(threadId) || Boolean(this.desktop?.following.has(threadId)),
          activeTurnId: this.activeTurns.get(threadId) || null,
          running: Boolean(this.activeTurns.get(threadId)),
          hasMore:
            Boolean(trimmedResult.thread && trimmedResult.thread.hasMoreTurns) ||
            trimmed.omitted > 0,
        });
        if (ephemeralEntry) {
          /* daemon 读不回临时会话的内容，把桥接缓存的事件一并交给前端回放 */
          payload.events = (ephemeralEntry.events || []).map((entry) =>
            Object.assign({}, entry, { params: slimNotificationParams(entry.params) })
          );
          if (ephemeralEntry.name && !(payload.thread && payload.thread.name)) {
            payload.thread = Object.assign({}, payload.thread, { name: ephemeralEntry.name });
          }
        }
        sendJson(
          response,
          200,
          payload
        );
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'message' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const threadId = segments[2];
        const text = String(body.text ?? '').trim();
        const images = Array.isArray(body.images)
          ? body.images.filter((value) => typeof value === 'string' && value.length > 0).slice(0, 8)
          : [];
        if (!text && images.length === 0) {
          sendJson(response, 400, { error: 'text or images are required' });
          return;
        }
        const outcome = await this._deliverMessage(threadId, text, images, { steer: body.steer === true });
        sendJson(response, 200, outcome);
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'interrupt' && request.method === 'POST') {
        const threadId = segments[2];
        if (this.desktop && !this.ephemeralThreads.has(threadId)) {
          const result = await this._interruptDesktopThread(threadId);
          sendJson(response, 200, result);
          return;
        }
        let turnId = await this._activeTurnId(threadId);
        if (!turnId) {
          /* 桌面端刚开跑，桥接还没加入这个 thread；先 attach 再找 active turn */
          await this._attachThread(threadId);
          turnId = await this._activeTurnId(threadId);
        }
        if (!turnId) {
          sendJson(response, 200, { ok: true, alreadyStopped: true });
          return;
        }
        try {
          const result = await connection.request('turn/interrupt', { threadId, turnId });
          this.activeTurns.delete(threadId);
          this._markTurnStopped(threadId, turnId);
          sendJson(response, 200, result);
        } catch (error) {
          const message = error && error.message ? error.message : '';
          if (!/active writer|thread not found/i.test(message)) throw error;

          /* 这个 thread 可能是被桌面端占着、或者刚被别的客户端 unload 了。
             重新加入一次再中断；attach 本身不会 archive 正在跑的会话。 */
          await this._attachThread(threadId);
          turnId = await this._activeTurnId(threadId);
          if (!turnId) {
            sendJson(response, 200, { ok: true, alreadyStopped: true });
            return;
          }
          try {
            const result = await connection.request('turn/interrupt', { threadId, turnId });
            this.activeTurns.delete(threadId);
            this._markTurnStopped(threadId, turnId);
            sendJson(response, 200, result);
          } catch (retryError) {
            const retryMessage = retryError && retryError.message ? retryError.message : '';
            const wrapped = new Error(
              '手机接管后仍无法中断这一轮：' + retryMessage + '。请在电脑上点停止后再试。'
            );
            wrapped.statusCode = 409;
            throw wrapped;
          }
        }
        return;
      }

      if (segments[1] === 'approvals' && segments.length === 2 && request.method === 'GET') {
        sendJson(response, 200, { data: [...this.pendingApprovals.values()] });
        return;
      }

      if (segments[1] === 'approvals' && segments[3] === 'respond' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const result = await this._respondToApproval(segments[2], body);
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.message });
    }
  }

  /* 这一轮正在跑的 turn id：内存里有就用内存的，没有再读会话找 inProgress 的那轮。
     interrupt 和 steer 都要先知道「现在跑的是哪一轮」。 */
  async _activeTurnId(threadId) {
    const cached = this.activeTurns.get(threadId);
    if (cached) return cached;
    const rolloutTurnId = this._rolloutRunningTurn(threadId);
    if (rolloutTurnId) {
      this.activeTurns.set(threadId, rolloutTurnId);
      return rolloutTurnId;
    }
    let latest = null;
    try {
      latest = await this._latestTurn(threadId);
    } catch (error) {
      if (!isFreshThreadError(error)) throw error;
    }
    if (latest && latest.status === 'inProgress' && latest.id) {
      this.activeTurns.set(threadId, latest.id);
      return latest.id;
    }
    this.activeTurns.delete(threadId);
    return null;
  }

  /* Explicit takeover for older app servers that can release idle ownership.
     Sending uses the shared input queue instead: newer ChatGPT app writers
     reject archive too, even after a turn has completed. */
  async _attachThread(threadId) {
    if (this.desktop && !this.ephemeralThreads.has(threadId)) {
      await this.desktop.ensureOwner(threadId);
      const turnId = this.activeTurns.get(threadId) || this._rolloutRunningTurn(threadId) ||
        (this.connection?.ready ? await this._activeTurnId(threadId) : null);
      return { attached: true, desktop: true, running: Boolean(turnId), turnId };
    }
    const connection = this._requireConnection();
    if (this.ephemeralThreads.has(threadId)) {
      const turnId = this.activeTurns.get(threadId) || null;
      return { attached: true, running: Boolean(turnId), turnId, ephemeral: true };
    }
    let resumeError = await this._resumeThread(threadId, {});
    if (resumeError && /active writer/i.test(resumeError.message || '')) {
      let latest = null;
      try {
        latest = await this._latestTurn(threadId);
      } catch (error) {
        /* Unconfirmed state cannot authorize releasing a writer lock. */
      }
      const idle = latest && ['completed', 'interrupted', 'failed'].includes(latest.status);
      if (idle && !this._rolloutRunningTurn(threadId)) {
        this.activeTurns.delete(threadId);
        try {
          await connection.request('thread/archive', { threadId });
          await connection.request('thread/unarchive', { threadId });
        } catch (error) {
          const wrapped = new Error('恢复空闲会话失败：' + error.message);
          wrapped.statusCode = 409;
          throw wrapped;
        }
        resumeError = await this._resumeThread(threadId, {});
      }
    }
    if (resumeError && !isFreshThreadError(resumeError)) {
      const error = new Error('接管失败：' + resumeError.message);
      error.statusCode = 409;
      throw error;
    }

    const latest = await this._latestTurn(threadId);
    const turnId =
      (latest && latest.status === 'inProgress' && latest.id ? latest.id : null) ||
      this._rolloutRunningTurn(threadId);
    if (turnId) this.activeTurns.set(threadId, turnId);
    else this.activeTurns.delete(threadId);
    this._markThreadLoaded(threadId);
    return { attached: true, running: Boolean(turnId), turnId };
  }

  async _queueInput(threadId, input) {
    try {
      const result = await this._requireConnection().request('thread/queue/add', {
        threadId,
        clientUserMessageId: crypto.randomUUID(),
        input,
      });
      return { queueId: result?.queuedSubmission?.id || null, native: true };
    } catch (error) {
      const unsupported = error.rpcError?.code === -32601 ||
        /unknown method|method not found|unknown variant.*thread\/queue\/add|(?:method|thread\/queue\/add).*not supported/i.test(error.message || '');
      if (!unsupported) throw error;
      const unavailable = new Error('当前聊天数据接口不支持消息排队。请更新 ChatGPT 和配置的后台服务后重试。');
      unavailable.statusCode = 409;
      throw unavailable;
    }
  }

  async _deliverDesktopMessage(threadId, input, images, options) {
    /* New-chat metadata may still be loaded by the data connection. Do not
       run a turn there: ChatGPT must acquire the session and own its tools. */
    if (this.loadedThreads.has(threadId) && !await this.releaseThreadLock(threadId, { force: true })) {
      const error = new Error('这条聊天仍由旧的桥接任务持有，请等任务结束后在 ChatGPT 中打开。');
      error.statusCode = 409;
      throw error;
    }
    const owner = await this.desktop.ensureOwner(threadId);
    if (options?.steer) {
      const clientUserMessageId = crypto.randomUUID();
      const text = input.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const result = await this.desktop.callThread(threadId, 'thread-follower-steer-turn', {
        input, clientUserMessageId,
        /* Native steering reads cwd/context before contacting app-server and
           keeps this draft for its optimistic message. A null cwd inherits
           the desktop chat's workspace without querying the data backend. */
        restoreMessage: {
          id: clientUserMessageId, text, cwd: null, createdAt: Date.now(),
          context: { prompt: text, commentAttachments: [] },
          responsesapiClientMetadata: { source: 'codex' },
        },
      }, owner);
      const turnId = result?.result?.turnId || this.activeTurns.get(threadId) || null;
      return { mode: 'steered', turnId, turn: result?.result?.turn ?? null, images, desktop: true };
    }
    const mode = this.permissions[threadId] || 'default';
    const selection = this.models[threadId] || null;
    const settings = Object.assign({}, permissionTurnParams(mode), modelTurnParams(selection));
    if (Object.keys(settings).length) {
      const updated = await this.desktop.callThread(threadId, 'thread-follower-update-thread-settings', {
        threadSettings: settings,
      }, owner);
      if (updated?.applied !== true) throw new Error('ChatGPT 未确认模型或权限设置，本次消息尚未发送。');
    }
    const result = await this.desktop.callThread(threadId, 'thread-follower-start-turn', {
      turnStart: {
        request: Object.assign({ threadId, input, clientUserMessageId: crypto.randomUUID() },
          permissionTurnParams(mode), modelTurnParams(selection)),
        context: {
          inheritThreadSettings: true,
          useAppServerPermissionDefault: true,
        },
      },
    }, owner);
    const turn = result?.result?.turn;
    if (!turn?.id) throw new Error('ChatGPT 未返回本次操作的确认，请刷新聊天查看结果后再重试。');
    this.activeTurns.set(threadId, turn.id);
    return { mode: 'started', turn, images, desktop: true };
  }

  async _interruptDesktopThread(threadId) {
    const owner = await this.desktop.ensureOwner(threadId);
    const turnId = this.activeTurns.get(threadId) || this._rolloutRunningTurn(threadId);
    const result = await this.desktop.callThread(threadId, 'thread-follower-interrupt-turn', {
      mode: 'user-stop', ...(turnId ? { expectedTurnId: turnId } : {}),
    }, owner);
    if (result?.ok) {
      this.activeTurns.delete(threadId);
      if (result.interruptedTurnId || turnId) this._markTurnStopped(threadId, result.interruptedTurnId || turnId);
    }
    return result;
  }

  async _deliverMessage(threadId, text, imagePaths, options) {
    const images = Array.isArray(imagePaths) ? imagePaths : [];
    const mode = this.permissions[threadId] || 'default';
    const selection = this.models[threadId] || null;
    const input = [];
    /* The desktop renders this input before app-server supplies defaults.
       Its text-element scanners require an array even for plain text. */
    if (text) input.push({ type: 'text', text, text_elements: [] });
    for (const imagePath of images) input.push({ type: 'localImage', path: imagePath });
    if (this.desktop && !this.ephemeralThreads.has(threadId)) {
      return this._deliverDesktopMessage(threadId, input, images.length, options);
    }
    const connection = this._requireConnection();

    /* 「引导」：不新开一轮，把这条输入塞进正在跑的那一轮，让它立刻改按新输入走。
       前提是本地知道当前轮的 id（turn/steer 要 expectedTurnId 对得上）；这一轮刚好
       跑完、或者 daemon 不认这个方法，就退回下面正常的发送流程。 */
    if (options && options.steer) {
      let activeTurnId = await this._activeTurnId(threadId);
      if (!activeTurnId) {
        /* 桌面端占着这个 thread 时，桥接可能还没加入；先 attach 再引导 */
        try {
          await this._attachThread(threadId);
          activeTurnId = await this._activeTurnId(threadId);
        } catch (error) {
          /* attach 失败就按原来的发送流程走，下面的 resume 会给出准确错误 */
        }
      }
      if (activeTurnId) {
        try {
          const result = await connection.request('turn/steer', {
            threadId,
            expectedTurnId: activeTurnId,
            input,
          });
          return {
            mode: 'steered',
            turnId: activeTurnId,
            turn: result?.turn ?? null,
            images: images.length,
          };
        } catch (error) {
          if (!isBusyThreadError(error) && !isThreadNotFoundError(error) && !STEER_MISS_PATTERN.test(error.message || '')) throw error;
          /* 这一轮可能刚被桌面端重新加载过，加入一次再试 */
          try {
            await this._attachThread(threadId);
            const retryTurnId = await this._activeTurnId(threadId);
            if (retryTurnId) {
              const result = await connection.request('turn/steer', {
                threadId,
                expectedTurnId: retryTurnId,
                input,
              });
              return {
                mode: 'steered',
                turnId: retryTurnId,
                turn: result?.turn ?? null,
                images: images.length,
              };
            }
          } catch (retryError) {
            if (!isBusyThreadError(retryError) && !isThreadNotFoundError(retryError) && !STEER_MISS_PATTERN.test(retryError.message || '')) {
              throw retryError;
            }
          }
          this.activeTurns.delete(threadId);
        }
      }
    }

    /* resume 把档位写到会话设置上（电脑上打开同一个会话也会看到同样的权限），
       turn/start 再带上一次，保证当前这一轮就是用这个档位跑的。 */
    /* 临时会话没有 rollout，resume 必然报 "no rollout found"，跳过它直接开跑。 */
    const ephemeral = this.ephemeralThreads.has(threadId);
    const resumeParams = Object.assign({}, permissionThreadParams(mode), modelThreadParams(selection));
    let resumeError = ephemeral
      ? null
      : await this._resumeThread(threadId, resumeParams);
    let busyError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (resumeError && !isFreshThreadError(resumeError)) {
        if (!isBusyThreadError(resumeError)) throw resumeError;
        busyError = resumeError;
        break;
      }
      try {
        const result = await connection.request(
          'turn/start',
          Object.assign({ threadId, input }, permissionTurnParams(mode), modelTurnParams(selection))
        );
        if (result?.turn?.id) this.activeTurns.set(threadId, result.turn.id);
        return { mode: 'started', turn: result?.turn ?? null, images: images.length };
      } catch (error) {
        /* Another client may unload an idle thread between resume and start.
           Retry that rejected request once; it is not evidence of a busy turn. */
        if (!ephemeral && attempt === 0 && isThreadNotFoundError(error)) {
          resumeError = await this._resumeThread(threadId, resumeParams);
          continue;
        }
        if (!isBusyThreadError(error)) throw error;
        busyError = error;
        break;
      }
    }

    if (!isBusyThreadError(busyError)) throw busyError;

    if (ephemeral) {
      const error = new Error('临时对话不能排队，等这一轮跑完再发。');
      error.statusCode = 409;
      throw error;
    }

    let idle = false;
    try {
      const latest = await this._latestTurn(threadId);
      idle = Boolean(latest && ['completed', 'interrupted', 'failed'].includes(latest.status) && !this._rolloutRunningTurn(threadId));
    } catch (error) {
      /* Queue delivery does not need to own the thread or assume it is idle. */
    }

    let queued;
    try {
      queued = await this._queueInput(threadId, input);
    } catch (error) {
      const wrapped = new Error(
        `未能确认消息投递：会话暂时无法直接写入（${busyError.message}）；队列错误：${error.message}`
      );
      wrapped.statusCode = 409;
      throw wrapped;
    }

    if (idle && queued.native && queued.queueId) {
      try {
        /* Ownership may have been released since the initial resume. Wake an
           idle queued turn immediately when this server can now own it. An
           external desktop owner receives the same persisted queue entry. */
        const wakeError = await this._resumeThread(threadId, resumeParams);
        if (!wakeError) {
          const result = await connection.request('thread/queue/start', {
            threadId, queuedSubmissionId: queued.queueId,
          });
          if (result?.turn?.id) this.activeTurns.set(threadId, result.turn.id);
          return { mode: 'started', turn: result?.turn ?? null, images: images.length };
        }
      } catch (error) {
        /* Already accepted. Reporting failure here would encourage a duplicate
           send if queue/start succeeded before its acknowledgement was lost. */
      }
    }
    return { mode: 'queued', queueId: queued.queueId, reason: busyError.message };
  }

  async _resumeThread(threadId, extraParams) {
    try {
      const result = await this.connection.request(
        'thread/resume',
        Object.assign({ threadId, excludeTurns: true }, extraParams || {})
      );
      this._markThreadLoaded(threadId);
      this._recordThreadSettings(threadId, result);
      return null;
    } catch (error) {
      return error;
    }
  }

  async _respondToApproval(requestId, body) {
    const record = this.pendingApprovals.get(String(requestId));
    if (!record) {
      const error = new Error('no pending approval with that id');
      error.statusCode = 404;
      throw error;
    }

    const result = this._buildApprovalResult(record, body);
    if (record.desktop) {
      const methods = {
        'item/commandExecution/requestApproval': ['thread-follower-command-approval-decision', { decision: result.decision }],
        'execCommandApproval': ['thread-follower-command-approval-decision', { decision: result.decision }],
        'item/fileChange/requestApproval': ['thread-follower-file-approval-decision', { decision: result.decision }],
        'applyPatchApproval': ['thread-follower-file-approval-decision', { decision: result.decision }],
        'item/permissions/requestApproval': ['thread-follower-permissions-request-approval-response', { response: result }],
        'item/tool/requestUserInput': ['thread-follower-submit-user-input', { response: result }],
        'mcpServer/elicitation/request': ['thread-follower-submit-mcp-server-elicitation-response', { response: result }],
      };
      const target = methods[record.method];
      if (!target) throw new Error('该请求需要在 ChatGPT 桌面 App 中处理。');
      await this.desktop.callThread(record.threadId, target[0], { requestId: record.desktopRequestId, ...target[1] });
    } else this.connection.respond(Number(record.requestId), result);
    this.pendingApprovals.delete(String(requestId));
    this._broadcast({ type: 'approval-resolved', requestId: String(requestId) });
    return { ok: true, response: result };
  }

  _buildApprovalResult(record, body) {
    const method = record.method;

    if (method === 'item/tool/requestUserInput') {
      return { answers: body.answers ?? {} };
    }

    if (method === 'item/permissions/requestApproval') {
      const result = { permissions: body.permissions ?? {} };
      if (body.scope) result.scope = body.scope;
      return result;
    }

    if (method === 'mcpServer/elicitation/request') {
      return { action: body.action ?? 'decline', content: body.content ?? null };
    }

    const decision = String(body.decision ?? '');

    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      return { decision: this._toLegacyDecision(decision, body) };
    }

    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) {
      const error = new Error(`unsupported decision: ${decision}`);
      error.statusCode = 400;
      throw error;
    }
    return { decision };
  }

  _toLegacyDecision(decision, body) {
    if (decision === 'accept') return 'approved';
    if (decision === 'acceptForSession') return 'approved_for_session';
    if (decision === 'cancel') return 'abort';
    return { denied: { rejection: String(body.reason ?? '') } };
  }

  _serveImage(request, response, url) {
    const requested = url.searchParams.get('path');
    if (!requested) {
      sendJson(response, 400, { error: 'path is required' });
      return;
    }
    let candidate = requested;
    if (!path.isAbsolute(candidate)) {
      const cwd = url.searchParams.get('cwd');
      if (!cwd || !path.isAbsolute(cwd)) {
        sendJson(response, 400, { error: 'relative path requires an absolute cwd' });
        return;
      }
      candidate = path.resolve(cwd, candidate);
    }

    fs.readFile(candidate, (error, content) => {
      if (error) {
        sendJson(response, 404, { error: 'cannot read file' });
        return;
      }
      const mime = detectImageMime(content, path.extname(candidate).toLowerCase());
      if (!mime) {
        sendJson(response, 415, { error: 'not an image' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'private, max-age=60',
        'Content-Length': content.length,
      });
      response.end(content);
    });
  }

  _serveStatic(response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(PUBLIC_DIR, relative);

    if (!resolved.startsWith(PUBLIC_DIR)) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }

    fs.readFile(resolved, (error, content) => {
      if (error) {
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(resolved)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(content);
    });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const bridge = new Bridge(options);
  await bridge.start();
  /* 预热一下，手机第一次打开延时面板时不用等 CLI 启动。 */
  warmTailscaleStatus();

  /* 局域网地址排前面：手机该用这个，走 Tailscale 中继会慢一个数量级。 */
  const lan = preferredLanAddress(localAddresses());
  const addresses = localAddresses().sort((left, right) => {
    if (left === lan) return -1;
    if (right === lan) return 1;
    if (isTailscaleIpv4(left) !== isTailscaleIpv4(right)) return isTailscaleIpv4(left) ? 1 : -1;
    return 0;
  });

  console.log('Codex Remote bridge running');
  console.log(`  app-server socket : ${options.socketPath}`);
  console.log(`  listening         : http://${options.host}:${options.port}`);
  console.log(`  token file        : ${options.tokenFile}`);
  console.log('');
  console.log('Open one of these on your phone (once, to set the cookie):');
  if (addresses.length === 0) {
    console.log(`  http://<this-mac-lan-ip>:${options.port}/?token=${bridge.token}`);
  } else {
    for (const address of addresses) {
      console.log(`  http://${address}:${options.port}/?token=${bridge.token}`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = { Bridge, parseArguments, loadOrCreateToken };
