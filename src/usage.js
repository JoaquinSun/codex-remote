'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_CC_SWITCH_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const DEFAULT_SQLITE = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRateLimitWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const usedPercent = finiteNumber(value.usedPercent);
  const windowDurationMins = finiteNumber(value.windowDurationMins);
  const resetsAt = finiteNumber(value.resetsAt);
  if (usedPercent === null) return null;
  return {
    usedPercent: Math.max(0, usedPercent),
    windowDurationMins: windowDurationMins === null ? null : Math.max(0, windowDurationMins),
    resetsAt: resetsAt === null ? null : Math.max(0, resetsAt),
  };
}

/* app-server can return the old single-bucket shape, the newer map keyed by
   limitId, or both. Keep only the display-safe quota fields; account identity
   and tokens never leave the daemon. */
function normalizeRateLimits(result) {
  const payload = result && typeof result === 'object' ? result : {};
  let source = [];
  if (payload.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object') {
    source = Object.entries(payload.rateLimitsByLimitId).map(([id, entry]) =>
      Object.assign({ limitId: id }, entry || {})
    );
  }
  if (source.length === 0 && payload.rateLimits) source = [payload.rateLimits];

  const seen = new Set();
  const limits = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const limitId = String(entry.limitId || 'codex');
    if (seen.has(limitId)) continue;
    const primary = normalizeRateLimitWindow(entry.primary);
    const secondary = normalizeRateLimitWindow(entry.secondary);
    if (!primary && !secondary) continue;
    seen.add(limitId);
    limits.push({
      limitId,
      limitName: typeof entry.limitName === 'string' && entry.limitName.trim()
        ? entry.limitName.trim().slice(0, 80)
        : null,
      planType: typeof entry.planType === 'string' && entry.planType.trim()
        ? entry.planType.trim().slice(0, 40)
        : null,
      primary,
      secondary,
      rateLimitReachedType:
        typeof entry.rateLimitReachedType === 'string' ? entry.rateLimitReachedType : null,
    });
  }

  const availableCount = finiteNumber(payload.rateLimitResetCredits?.availableCount);
  return {
    available: limits.length > 0,
    limits,
    resetCredits: availableCount === null ? null : Math.max(0, Math.floor(availableCount)),
  };
}

function runSqlite(sqliteBinary, database, query, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      sqliteBinary,
      ['-readonly', '-json', '-cmd', '.timeout 1000', database, query],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('CC Switch usage query timed out'));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || `sqlite3 exited with status ${code}`).trim()));
        return;
      }
      resolve(stdout.trim() || '[]');
    });
  });
}

/* Mirrors CC Switch's current Usage Dashboard semantics for detail rows:
   - OpenAI/Gemini-style input counters are normalized to fresh input.
   - A session-log row that matches a successful proxy row is excluded.
   - claude-desktop is folded into the Claude bucket for display.

   Today's data always lives in proxy_request_logs; CC Switch only rolls up and
   prunes complete older days, so no daily-rollup join is needed here. */
function ccSwitchTodayQuery(startSeconds, endSeconds) {
  return `
WITH usage_rows AS (
  SELECT
    CASE WHEN l.app_type = 'claude-desktop' THEN 'claude' ELSE l.app_type END AS app_type,
    CASE
      WHEN l.input_token_semantics = 2 THEN l.input_tokens
      WHEN l.app_type IN ('codex', 'gemini', 'grokbuild')
        AND l.input_token_semantics = 1
        AND l.input_tokens >= (l.cache_read_tokens + l.cache_creation_tokens)
        THEN l.input_tokens - l.cache_read_tokens - l.cache_creation_tokens
      WHEN l.app_type IN ('codex', 'gemini', 'grokbuild')
        AND l.input_token_semantics = 0
        AND l.input_tokens >= l.cache_read_tokens
        THEN l.input_tokens - l.cache_read_tokens
      ELSE l.input_tokens
    END AS fresh_input_tokens,
    l.output_tokens,
    l.cache_read_tokens,
    l.cache_creation_tokens,
    CAST(l.total_cost_usd AS REAL) AS total_cost_usd,
    l.status_code,
    l.created_at
  FROM proxy_request_logs l
  WHERE l.created_at >= ${Math.floor(startSeconds)}
    AND l.created_at <= ${Math.floor(endSeconds)}
    AND NOT (
      COALESCE(l.data_source, 'proxy') IN (
        'session_log', 'codex_session', 'gemini_session', 'opencode_session'
      )
      AND EXISTS (
        SELECT 1
        FROM proxy_request_logs proxy_dedup
        WHERE COALESCE(proxy_dedup.data_source, 'proxy') = 'proxy'
          AND proxy_dedup.app_type IN (
            l.app_type,
            CASE WHEN l.app_type = 'claude' THEN 'claude-desktop' ELSE l.app_type END
          )
          AND proxy_dedup.status_code >= 200 AND proxy_dedup.status_code < 300
          AND proxy_dedup.input_tokens = l.input_tokens
          AND proxy_dedup.output_tokens = l.output_tokens
          AND proxy_dedup.cache_read_tokens = l.cache_read_tokens
          AND (
            proxy_dedup.cache_creation_tokens = l.cache_creation_tokens
            OR (
              l.cache_creation_tokens = 0
              AND COALESCE(l.data_source, 'proxy') IN (
                'codex_session', 'gemini_session', 'opencode_session'
              )
            )
            OR (
              proxy_dedup.cache_creation_tokens = 0
              AND proxy_dedup.input_token_semantics = 0
              AND COALESCE(l.data_source, 'proxy') = 'codex_session'
            )
          )
          AND proxy_dedup.created_at BETWEEN l.created_at - 600 AND l.created_at + 600
          AND (
            LOWER(proxy_dedup.model) = LOWER(l.model)
            OR LOWER(proxy_dedup.model) = 'unknown'
            OR LOWER(l.model) = 'unknown'
            OR (
              l.app_type = 'codex'
              AND COALESCE(l.data_source, 'proxy') = 'codex_session'
              AND NULLIF(TRIM(proxy_dedup.request_model), '') IS NOT NULL
              AND LOWER(TRIM(proxy_dedup.request_model)) <> 'unknown'
              AND LOWER(TRIM(proxy_dedup.request_model)) = LOWER(TRIM(l.model))
            )
          )
      )
    )
)
SELECT
  app_type AS "appType",
  COUNT(*) AS "requests",
  COALESCE(SUM(
    fresh_input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens
  ), 0) AS "realTotalTokens",
  COALESCE(SUM(total_cost_usd), 0) AS "totalCostUsd",
  COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END), 0)
    AS "successCount",
  MAX(created_at) AS "lastRecordAt"
FROM usage_rows
GROUP BY app_type
ORDER BY "realTotalTokens" DESC, app_type ASC;
`.trim();
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function summarizeCCSwitchRows(rows) {
  const apps = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      appType: String(row?.appType || 'unknown').slice(0, 40),
      requests: Math.floor(numberOrZero(row?.requests)),
      realTotalTokens: Math.floor(numberOrZero(row?.realTotalTokens)),
      totalCostUsd: numberOrZero(row?.totalCostUsd),
      successCount: Math.floor(numberOrZero(row?.successCount)),
      lastRecordAt: numberOrZero(row?.lastRecordAt)
        ? Math.floor(numberOrZero(row.lastRecordAt) * 1000)
        : null,
    }))
    .filter((row) => row.requests > 0 || row.realTotalTokens > 0 || row.totalCostUsd > 0);

  const summary = apps.reduce(
    (total, row) => {
      total.requests += row.requests;
      total.realTotalTokens += row.realTotalTokens;
      total.totalCostUsd += row.totalCostUsd;
      total.successCount += row.successCount;
      if (row.lastRecordAt && (!total.lastRecordAt || row.lastRecordAt > total.lastRecordAt)) {
        total.lastRecordAt = row.lastRecordAt;
      }
      return total;
    },
    { requests: 0, realTotalTokens: 0, totalCostUsd: 0, successCount: 0, lastRecordAt: null }
  );
  summary.totalCostUsd = Number(summary.totalCostUsd.toFixed(6));
  summary.successRate = summary.requests > 0 ? (summary.successCount / summary.requests) * 100 : 0;
  return { summary, apps };
}

async function readCCSwitchUsage(options = {}) {
  const database = options.database || process.env.CC_SWITCH_DB || DEFAULT_CC_SWITCH_DB;
  const exists = options.exists || fs.existsSync;
  if (!exists(database)) {
    return { available: false, reason: 'notInstalled', period: 'today' };
  }

  const now = options.now instanceof Date ? new Date(options.now) : new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startSeconds = Math.floor(start.getTime() / 1000);
  const endSeconds = Math.floor(now.getTime() / 1000);
  const query = ccSwitchTodayQuery(startSeconds, endSeconds);

  try {
    const execute = options.runSqlite || runSqlite;
    const raw = await execute(options.sqliteBinary || DEFAULT_SQLITE, database, query);
    const rows = JSON.parse(String(raw || '[]'));
    const { summary, apps } = summarizeCCSwitchRows(rows);
    return {
      available: true,
      period: 'today',
      startAt: start.getTime(),
      endAt: now.getTime(),
      summary,
      apps,
    };
  } catch (error) {
    return {
      available: false,
      reason: error && error.code === 'ENOENT' ? 'sqliteUnavailable' : 'queryFailed',
      period: 'today',
    };
  }
}

module.exports = {
  ccSwitchTodayQuery,
  normalizeRateLimits,
  readCCSwitchUsage,
  summarizeCCSwitchRows,
};
