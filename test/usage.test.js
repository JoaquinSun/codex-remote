'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  ccSwitchTodayQuery,
  normalizeRateLimits,
  readCCSwitchUsage,
  summarizeCCSwitchRows,
} = require('../src/usage');

test('normalizes legacy and multi-bucket Codex rate-limit payloads', () => {
  const legacy = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: null,
    },
  });
  assert.equal(legacy.available, true);
  assert.equal(legacy.limits[0].limitId, 'codex');
  assert.equal(legacy.limits[0].primary.usedPercent, 25);

  const multiple = normalizeRateLimits({
    rateLimits: { limitId: 'ignored-legacy', primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: {
        planType: 'pro',
        primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1_800_000_100 },
        secondary: { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
      },
      codex_other: {
        limitName: 'Other models',
        primary: { usedPercent: 7, windowDurationMins: 60, resetsAt: 1_800_000_200 },
      },
    },
    rateLimitResetCredits: { availableCount: 2 },
  });
  assert.deepEqual(multiple.limits.map((entry) => entry.limitId), ['codex', 'codex_other']);
  assert.equal(multiple.limits[0].secondary.windowDurationMins, 10080);
  assert.equal(multiple.limits[1].limitName, 'Other models');
  assert.equal(multiple.resetCredits, 2);
});

test('does not turn missing quota counters or reset credits into zero', () => {
  const missing = normalizeRateLimits({
    rateLimits: {
      primary: { usedPercent: null, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: null, windowDurationMins: null, resetsAt: null },
    },
    rateLimitResetCredits: { availableCount: null },
  });
  assert.deepEqual(missing, { available: false, limits: [], resetCredits: null });

  const zero = normalizeRateLimits({
    rateLimits: { primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null } },
  });
  assert.equal(zero.available, true);
  assert.deepEqual(zero.limits[0].primary, {
    usedPercent: 0, windowDurationMins: null, resetsAt: null,
  });
});

test('summarizes display-safe CC Switch usage rows', () => {
  const result = summarizeCCSwitchRows([
    {
      appType: 'codex', requests: 3, realTotalTokens: 1200,
      totalCostUsd: 0.25, successCount: 2, lastRecordAt: 1_700_000_000,
    },
    {
      appType: 'claude', requests: 2, realTotalTokens: 800,
      totalCostUsd: '0.125', successCount: 2, lastRecordAt: 1_700_000_100,
    },
  ]);
  assert.deepEqual(result.summary, {
    requests: 5,
    realTotalTokens: 2000,
    totalCostUsd: 0.375,
    successCount: 4,
    lastRecordAt: 1_700_000_100_000,
    successRate: 80,
  });
  assert.equal(result.apps[0].lastRecordAt, 1_700_000_000_000);
});

test('normalizes real tokens, deduplicates sessions, and restricts SQLite totals to today', async (t) => {
  const sqlite = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
  try {
    execFileSync(sqlite, ['-version'], { stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('sqlite3 is not installed');
      return;
    }
    throw error;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-usage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, 'cc-switch.db');
  const now = new Date('2026-11-10T12:00:00+08:00');
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = Math.floor(start.getTime() / 1000);
  execFileSync(sqlite, [database, `
    CREATE TABLE proxy_request_logs (
      app_type TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      total_cost_usd TEXT, status_code INTEGER, created_at INTEGER,
      data_source TEXT, input_token_semantics INTEGER, model TEXT, request_model TEXT
    );
    INSERT INTO proxy_request_logs VALUES
      ('codex', 150, 20, 50, 10, '0.10', 200, ${today + 3600}, 'proxy', 1, 'normalized', 'asked-model'),
      ('codex', 150, 20, 50, 0, '0.10', 200, ${today + 3601}, 'codex_session', 1, 'asked-model', NULL),
      ('codex', 100, 5, 80, 0, '0.02', 200, ${today + 3700}, 'codex_session', 0, 'legacy', NULL),
      ('claude-desktop', 60, 20, 10, 5, '0.20', 200, ${today + 3800}, 'proxy', 2, 'claude', NULL),
      ('claude', 60, 20, 10, 5, '0.20', 200, ${today + 3801}, 'session_log', 2, 'claude', NULL),
      ('gemini', 80, 10, 20, 5, '0.01', 500, ${today + 3900}, 'proxy', 1, 'gemini', NULL),
      ('codex', 999, 0, 0, 0, '999', 200, ${today - 1}, 'proxy', 2, 'yesterday', NULL),
      ('codex', 999, 0, 0, 0, '999', 200, ${Math.floor(now.getTime() / 1000) + 100}, 'proxy', 2, 'future', NULL);
  `]);

  const result = await readCCSwitchUsage({ database, sqliteBinary: sqlite, now });
  assert.equal(result.available, true);
  assert.equal(result.summary.requests, 4);
  assert.equal(result.summary.realTotalTokens, 460);
  assert.equal(result.summary.totalCostUsd, 0.33);
  assert.equal(result.summary.successRate, 75);
  assert.deepEqual(result.apps.map(({ appType, realTotalTokens }) => ({ appType, realTotalTokens })), [
    { appType: 'codex', realTotalTokens: 275 },
    { appType: 'claude', realTotalTokens: 95 },
    { appType: 'gemini', realTotalTokens: 90 },
  ]);
});

test('reads CC Switch usage without exposing request details', async () => {
  let captured;
  const result = await readCCSwitchUsage({
    database: '/tmp/example-cc-switch.db',
    exists: () => true,
    now: new Date('2026-11-10T12:00:00+08:00'),
    runSqlite: async (binary, database, query) => {
      captured = { binary, database, query };
      return JSON.stringify([
        {
          appType: 'codex', requests: 4, realTotalTokens: 4096,
          totalCostUsd: 0.75, successCount: 4, lastRecordAt: 1_794_280_000,
        },
      ]);
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.period, 'today');
  assert.equal(result.summary.realTotalTokens, 4096);
  assert.equal(result.apps[0].appType, 'codex');
  assert.equal(captured.database, '/tmp/example-cc-switch.db');
  assert.match(captured.query, /created_at >= 1794240000/);
  assert.ok(!Object.hasOwn(result, 'database'));
});

test('reports an absent CC Switch database cleanly', async () => {
  const result = await readCCSwitchUsage({ exists: () => false });
  assert.deepEqual(result, { available: false, reason: 'notInstalled', period: 'today' });
});

test('does not expose database paths or raw SQLite errors on failure', async () => {
  const result = await readCCSwitchUsage({
    exists: () => true,
    runSqlite: async () => { throw new Error('failed to open /private/example/cc-switch.db'); },
  });
  assert.deepEqual(result, { available: false, reason: 'queryFailed', period: 'today' });
});
