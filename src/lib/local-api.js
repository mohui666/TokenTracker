const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const {
  filterRowsByUsageScope,
  getSourceScope,
  listExcludedSources,
  normalizeUsageScope,
} = require("./source-metadata");
const { getOrCreateMachineId, computeStableMachineId } = require("./machine-id");

const SYNC_TIMEOUT_MS = 120_000;
const TRACKER_BIN = path.resolve(__dirname, "../../bin/tracker.js");
const MAX_DEVICE_NAME_LENGTH = 128;

function getSystemDeviceName() {
  try {
    const hostname = os.hostname()
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, MAX_DEVICE_NAME_LENGTH);
    return hostname || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-model pricing — delegated to src/lib/pricing/
//   - CURATED overrides (kiro-*, hy3-*, composer-*, kimi-for-coding, etc.)
//   - LiteLLM live data (mainstream claude / gpt-5 / gemini), 24h disk-cached
//   - Bundled seed snapshot for first-install / offline fallback
// ---------------------------------------------------------------------------

const {
  MODEL_PRICING,
  getModelPricing,
  computeRowCost,
  ensurePricingLoaded,
  getPricingRevision,
} = require("./pricing");

const {
  computeClaudeCategoryBreakdown,
  unsupportedSourcePayload: unsupportedCategoryPayload,
} = require("./claude-categorizer");

const { computeCodexContextBreakdown } = require("./codex-context-breakdown");
const { computeGrokContextBreakdown } = require("./grok-context-breakdown");

const {
  deriveProjectKeyFromRef,
  CLAUDE_MEM_OBSERVER_PROJECT_REF,
} = require("./rollout");

// ---------------------------------------------------------------------------
// Queue data helpers
// ---------------------------------------------------------------------------

function resolveQueuePath() {
  const home = os.homedir();
  return path.join(home, ".tokentracker", "tracker", "queue.jsonl");
}

// Pseudo-project written by the pre-fix claude-mem observer attribution;
// mirrored Claude Code sessions, not a real repository. Excluded at read
// time so historical rows never surface on the Project Usage panel. Derived
// from rollout.js's ref so a rename there cannot silently desync the filter.
const CLAUDE_MEM_OBSERVER_PROJECT_KEY = deriveProjectKeyFromRef(
  CLAUDE_MEM_OBSERVER_PROJECT_REF,
);
const PROJECT_USAGE_MAX_ENTRIES = 10;
const MAX_TIME_ZONE_CACHE_ENTRIES = 16;

// The native dashboard fans one refresh out across several local endpoints.
// Keep one immutable, deduped view of the current queue so those endpoints do
// not all read and JSON.parse the same append-only file. A file identity +
// nanosecond timestamp signature invalidates the cache immediately on append,
// in-place rewrite, or atomic replacement.
let queueDataCache = null;
const dailyAggregationCache = new WeakMap();
const zonedPartsFormatters = new Map();

function boundedCacheSet(cache, key, value, maxEntries) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function queueFileSignature(queuePath) {
  const stat = fs.statSync(queuePath, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function timeZoneContextKey({ timeZone, offsetMinutes } = {}) {
  return `${timeZone || ""}|${Number.isFinite(offsetMinutes) ? offsetMinutes : ""}|p${getPricingRevision()}`;
}

// Shared by project-usage-summary and project-usage-detail: reads the
// deduped project bucket log, drops the claude-mem pseudo project, and
// builds the from/to day-range predicate. Callers compute each row's day
// key ONCE (rowDayKey constructs an Intl.DateTimeFormat per call — the
// dominant per-row cost) and reuse it for both the range check and any
// day bucketing.
function readProjectUsageContext(qp, url) {
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const timeZoneContext = getTimeZoneContext(url);
  const hasRange = Boolean(from || to);
  const dayInRange = (day) => {
    if (!hasRange) return true;
    if (!day) return false;
    return (!from || day >= from) && (!to || day <= to);
  };
  const projectQueuePath = path.join(path.dirname(qp), "project.queue.jsonl");
  const projectRows = readProjectQueueData(projectQueuePath).filter(
    (row) => row.project_key !== CLAUDE_MEM_OBSERVER_PROJECT_KEY,
  );
  return { from, to, timeZoneContext, hasRange, dayInRange, projectRows };
}

// Same signature-based caching as readQueueData: the project-usage endpoints
// all fan out from one dashboard refresh, so without this every request
// re-read and re-parsed the whole append-only project queue.
let projectQueueDataCache = null;

function readProjectQueueData(projectQueuePath) {
  let signature;
  try {
    signature = queueFileSignature(projectQueuePath);
  } catch (e) {
    if (projectQueueDataCache?.queuePath === projectQueuePath) {
      projectQueueDataCache = null;
    }
    if (e?.code !== "ENOENT") {
      console.error("[LocalAPI] readProjectQueueData: failed to stat:", e?.message || e);
    }
    return [];
  }

  if (
    projectQueueDataCache?.queuePath === projectQueuePath &&
    projectQueueDataCache.signature === signature
  ) {
    return projectQueueDataCache.rows;
  }

  let raw;
  try {
    raw = fs.readFileSync(projectQueuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error("[LocalAPI] readProjectQueueData: failed to read:", e?.message || e);
    }
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const seen = new Map();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const key = `${row.project_key || ""}|${row.source || ""}|${row.hour_start || ""}`;
      // Same legacy-row corrections as the main queue (codex inclusive-input,
      // cursor billable=0) so both read paths report identical numbers.
      seen.set(key, normalizeQueueRow(row));
    } catch {
      // skip malformed
    }
  }
  // Callers treat the result as read-only (sortByHour copies before sorting),
  // so the cached array can be shared across requests.
  const rows = Array.from(seen.values());
  projectQueueDataCache = { queuePath: projectQueuePath, signature, rows };
  return rows;
}

function isLegacyInclusiveCodexRow(row) {
  if (!row || (row.source !== "codex" && row.source !== "every-code")) return false;
  const inputTokens = Number(row.input_tokens || 0);
  const cachedInputTokens = Number(row.cached_input_tokens || 0);
  const outputTokens = Number(row.output_tokens || 0);
  const totalTokens = Number(row.total_tokens || 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cachedInputTokens)) return false;
  if (cachedInputTokens <= 0 || inputTokens < cachedInputTokens) return false;
  // Legacy Codex queue rows stored input inclusive of cache reads, while
  // total_tokens remained input + output. Canonical rows keep input as pure
  // non-cached input, so cache-heavy legacy rows can be identified by this
  // exact invariant.
  return totalTokens === inputTokens + outputTokens;
}

function normalizeQueueRow(row) {
  let normalized = row;
  if (isLegacyInclusiveCodexRow(normalized)) {
    normalized = {
      ...normalized,
      input_tokens:
        Number(normalized.input_tokens || 0) - Number(normalized.cached_input_tokens || 0),
    };
  }
  // Legacy Cursor rows from versions ≤ 0.26.5 wrote billable_total_tokens = 0
  // for "Included in Pro" / "Enterprise" / "no charge" records (kind-based
  // gating in cursor-config.js#normalizeCursorUsage). The dashboard headline
  // sums billable_total_tokens across sources, so those rows silently
  // disappeared from the displayed total once any other source contributed
  // non-zero billable usage (GitHub issue #106). Treat billing and usage as
  // orthogonal: bump billable up to total_tokens at read time so historical
  // queue.jsonl entries render correctly without requiring a file rewrite.
  const sourceName = String(normalized.source || "").toLowerCase();
  if (sourceName === "cursor") {
    const totalTokens = Number(normalized.total_tokens || 0);
    const billable = Number(normalized.billable_total_tokens || 0);
    if (totalTokens > 0 && billable < totalTokens) {
      normalized = { ...normalized, billable_total_tokens: totalTokens };
    }
  }
  return normalized;
}

function readQueueData(queuePath) {
  let stat;
  try {
    stat = fs.statSync(queuePath, { bigint: true });
  } catch (e) {
    if (queueDataCache?.queuePath === queuePath) queueDataCache = null;
    if (e?.code !== "ENOENT") {
      console.error("[LocalAPI] readQueueData: failed to stat queue:", e?.message || e);
    }
    return [];
  }
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

  const cached = queueDataCache;
  if (cached?.queuePath === queuePath && cached.signature === signature) {
    return cached.rows;
  }

  // The queue is append-only, so on a same-file append only the new tail is
  // read and parsed; the deduped row set carries over. A replaced, truncated,
  // or first-seen file falls back to a full read.
  const devIno = `${stat.dev}:${stat.ino}`;
  const fileSize = Number(stat.size);
  const canAppend =
    cached != null &&
    cached.queuePath === queuePath &&
    cached.devIno === devIno &&
    fileSize >= cached.consumedBytes;
  let seen = canAppend ? cached.seen : new Map();
  let offset = canAppend ? cached.consumedBytes : 0;

  // Integrity probe for the append assumption: repo writers only append or
  // atomically replace (inode change), but an EXTERNAL in-place rewrite
  // (cp over the file, shell redirect) keeps the inode with a same/larger
  // size while changing the prefix. The byte before our offset must be the
  // newline that terminated the last consumed line — anything else means the
  // prefix is no longer ours, so fall back to a full read.
  if (offset > 0) {
    try {
      const fd = fs.openSync(queuePath, "r");
      try {
        const probe = Buffer.allocUnsafe(1);
        if (fs.readSync(fd, probe, 0, 1, offset - 1) !== 1 || probe[0] !== 0x0a) {
          seen = new Map();
          offset = 0;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      seen = new Map();
      offset = 0;
    }
  }

  let raw = "";
  if (fileSize > offset) {
    try {
      if (offset === 0) {
        raw = fs.readFileSync(queuePath, "utf8");
      } else {
        const fd = fs.openSync(queuePath, "r");
        try {
          const length = fileSize - offset;
          const buffer = Buffer.allocUnsafe(length);
          let read = 0;
          while (read < length) {
            // A concurrent truncation between stat and open makes readSync hit
            // EOF early — without the 0-byte break this loop never terminates.
            const n = fs.readSync(fd, buffer, read, length - read, offset + read);
            if (n === 0) break;
            read += n;
          }
          raw = buffer.toString("utf8", 0, read);
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (e) {
      // ENOENT is legitimate (queue deleted between stat and read); anything
      // else is a signal we don't want to hide behind an empty array forever —
      // the dashboard would otherwise render "0 tokens" with no clue the queue
      // was unreadable.
      if (e?.code !== "ENOENT") {
        console.error("[LocalAPI] readQueueData: failed to read queue:", e?.message || e);
      }
      return canAppend ? cached.rows : [];
    }
  }

  // Parse row-by-row so a single corrupted line (partial write, disk-full
  // truncation, …) does not wipe out every other row with it. An unterminated
  // tail is attempted (legacy writers may omit the final newline) but NOT
  // marked consumed — a mid-append partial line is re-read once it completes.
  // "\n" (0x0A) never appears inside a multi-byte UTF-8 sequence, so cutting
  // on the last newline is byte-safe.
  let consumedBytes = offset;
  let malformed = 0;
  if (raw) {
    const lastNewline = raw.lastIndexOf("\n");
    if (lastNewline !== -1) {
      consumedBytes += Buffer.byteLength(raw.slice(0, lastNewline), "utf8") + 1;
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        // Deduplicate: each sync appends cumulative totals per bucket, so for
        // each (source, model, hour_start) keep only the latest (last) entry.
        const key = `${row.source || ""}|${row.model || ""}|${row.hour_start || ""}`;
        seen.set(key, normalizeQueueRow(row));
      } catch {
        malformed += 1;
      }
    }
  }
  if (malformed > 0) {
    console.error(
      `[LocalAPI] readQueueData: skipped ${malformed} malformed line(s) in ${queuePath}`,
    );
  }
  const rows = Array.from(seen.values());
  queueDataCache = { queuePath, signature, devIno, consumedBytes, seen, rows };
  return rows;
}

function rowDayKey(row, timeZoneContext) {
  const hs = row.hour_start;
  if (!hs) return "";
  if (
    timeZoneContext &&
    (timeZoneContext.timeZone || Number.isFinite(timeZoneContext.offsetMinutes))
  ) {
    const parts = getZonedParts(new Date(hs), timeZoneContext);
    const key = formatPartsDayKey(parts);
    if (key) return key;
  }
  return hs.slice(0, 10);
}

function aggregateByDay(rows, timeZoneContext = null) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const cacheKey = timeZoneContextKey(timeZoneContext || {});
  let cachedByTimeZone = dailyAggregationCache.get(normalizedRows);
  if (cachedByTimeZone?.has(cacheKey)) {
    const cached = cachedByTimeZone.get(cacheKey);
    // Touch the entry so the small per-queue map behaves as an LRU.
    cachedByTimeZone.delete(cacheKey);
    cachedByTimeZone.set(cacheKey, cached);
    return cached;
  }

  const byDay = new Map();
  for (const row of normalizedRows) {
    if (!row.hour_start) continue;
    const day = rowDayKey(row, timeZoneContext);
    if (!day) continue;
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        total_tokens: 0,
        billable_total_tokens: 0,
        total_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
    }
    const a = byDay.get(day);
    a.total_tokens += row.total_tokens || 0;
    a.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
    a.total_cost_usd += computeRowCost(row);
    a.input_tokens += row.input_tokens || 0;
    a.output_tokens += row.output_tokens || 0;
    a.cached_input_tokens += row.cached_input_tokens || 0;
    a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    a.conversation_count += row.conversation_count || 0;

    if (!a.models) {
      a.models = {};
    }
    const model = row.model || "unknown";
    a.models[model] = (a.models[model] || 0) + (row.total_tokens || 0);
  }
  const daily = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  if (!cachedByTimeZone) {
    cachedByTimeZone = new Map();
    dailyAggregationCache.set(normalizedRows, cachedByTimeZone);
  }
  boundedCacheSet(cachedByTimeZone, cacheKey, daily, MAX_TIME_ZONE_CACHE_ENTRIES);
  return daily;
}

function buildCodexCategoryFallbackFromQueue(queueRows, { from, to, timeZoneContext }) {
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let conversationCount = 0;

  for (const row of queueRows || []) {
    if ((row?.source || "") !== "codex") continue;
    if (!row.hour_start) continue;
    const day = rowDayKey(row, timeZoneContext);
    if (from && day < from) continue;
    if (to && day > to) continue;
    totals.input_tokens += Number(row.input_tokens || 0);
    totals.cached_input_tokens += Number(row.cached_input_tokens || 0);
    totals.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
    totals.output_tokens += Number(row.output_tokens || 0);
    totals.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
    totals.total_tokens += Number(row.total_tokens || 0);
    conversationCount += Number(row.conversation_count || 0);
  }

  return {
    source: "codex",
    scope: "supported",
    breakdown_status: "queue_fallback",
    totals,
    session_count: 0,
    message_count: conversationCount,
    fallback: "queue_totals",
    message_breakdown: {
      categories: [
        {
          key: "user_input",
          name: "User input",
          totals: {
            input_tokens: totals.input_tokens,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: totals.input_tokens,
          },
        },
        {
          key: "conversation_history",
          name: "Conversation history",
          totals: {
            input_tokens: 0,
            cached_input_tokens: totals.cached_input_tokens,
            cache_creation_input_tokens: totals.cache_creation_input_tokens,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: totals.cached_input_tokens + totals.cache_creation_input_tokens,
          },
        },
        {
          key: "assistant_response",
          name: "Assistant response",
          totals: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: Math.max(0, totals.output_tokens - totals.reasoning_output_tokens),
            reasoning_output_tokens: 0,
            total_tokens: Math.max(0, totals.output_tokens - totals.reasoning_output_tokens),
          },
        },
      ].sort((a, b) => Number(b.totals.total_tokens || 0) - Number(a.totals.total_tokens || 0)),
      privacy: {
        includes_content: false,
        note: "Queue fallback includes aggregated token categories only; message text is never returned.",
      },
    },
    tool_calls_breakdown: {
      total_calls: 0,
      tools: [],
      categories: [],
      tools_total: 0,
      privacy: {
        includes_inputs: false,
        note: "Codex rollout sessions were unavailable; totals come from TokenTracker queue rows.",
      },
    },
    exec_command_breakdown: {
      by_type: [],
      by_exit: [],
    },
  };
}

function getRequestedUsageScope(url) {
  if (url.searchParams.get("include_account_level") === "1") return "all";
  return normalizeUsageScope(url.searchParams.get("scope"));
}

function scopedQueueRows(queuePath, url) {
  const scope = getRequestedUsageScope(url);
  const allRows = readQueueData(queuePath);
  return {
    scope,
    allRows,
    rows: filterRowsByUsageScope(allRows, scope),
    excludedSources: listExcludedSources(allRows, scope),
  };
}

// ── Local achievements ───────────────────────────────────────────────────────
// Every badge unlocks locally from the deduped queue/project rows — there is
// no cloud backend anymore. Thresholds + metric semantics mirror the retired
// cloud badge catalog (formerly scripts/ops/user-badges.sql): token_titan,
// big_day, wordsmith, marathoner, streak, weekend_warrior, momentum, polyglot,
// multitool, veteran, plus the local originals project_hopper,
// project_devotion, night_owl. podium (leaderboard rank) and trendsetter
// (global model-debut data) are inherently cross-user and intentionally
// dropped. Thresholds are ordered bronze → silver → gold → diamond. This
// module is the single server-side home for thresholds; the dashboard renders
// whatever the payload says and embeds none of these numbers.
const LOCAL_BADGE_THRESHOLDS = {
  token_titan: [100000000, 1000000000, 10000000000, 100000000000], // lifetime total tokens
  big_day: [10000000, 100000000, 500000000, 3000000000], // best single-day tokens
  wordsmith: [5000000, 25000000, 100000000, 300000000], // lifetime output tokens
  marathoner: [7, 30, 100, 365], // active days
  streak: [3, 7, 30, 100], // longest consecutive active-day run
  weekend_warrior: [5, 20, 50, 100], // weekend (Sat/Sun) active days
  momentum: [2, 6, 15, 40], // best week-over-week multiplier (adjacent ISO weeks, prev >= 10M)
  polyglot: [5, 15, 30, 60], // distinct models
  multitool: [2, 4, 6, 10], // distinct tools/sources
  veteran: [30, 90, 180, 365], // days since first activity
  project_hopper: [3, 5, 10, 20], // distinct projects
  project_devotion: [1000000, 10000000, 100000000, 1000000000], // max tokens in one project
  night_owl: [5, 20, 60, 150], // active hour buckets between 00:00–05:59 local
};

const LOCAL_TIER_KEYS = ["bronze", "silver", "gold", "diamond"];

// Week-over-week growth only counts when the previous ISO week cleared this
// token floor (mirrors the retired cloud compute; keeps tiny baselines from
// producing meaningless 100x ratios).
const MOMENTUM_PREV_WEEK_FLOOR = 10_000_000;

function dayKeyToMs(dayKey) {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function msToDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Monday of the ISO week containing dayKey (day keys are `YYYY-MM-DD`).
function isoWeekStartKey(dayKey) {
  const ms = dayKeyToMs(dayKey);
  if (ms == null) return null;
  const dow = new Date(ms).getUTCDay(); // 0=Sun … 6=Sat
  return msToDayKey(ms - ((dow + 6) % 7) * 86_400_000);
}

/**
 * Compute the local badge set from deduped queue rows.
 * Rows are replayed in hour_start order so each tier's `achieved` timestamp is
 * the hour at which the running metric first crossed that threshold. Day
 * boundaries (active days, streaks, weekends, best day, weekly momentum) use
 * the caller's tz query params like every other usage endpoint. Day-grain
 * metrics are accumulated per local day first, then replayed day by day so
 * their achieved timestamps land on the day's first contributing bucket.
 */
function computeLocalAchievements(queueRows, projectRows, { timeZoneContext } = {}) {
  const tz = timeZoneContext || {};
  const sortByHour = (rows) =>
    rows
      .filter((row) => row && row.hour_start)
      .slice()
      .sort((a, b) => String(a.hour_start).localeCompare(String(b.hour_start)));

  const trackers = {};
  for (const badgeId of Object.keys(LOCAL_BADGE_THRESHOLDS)) {
    trackers[badgeId] = { value: 0, achieved: {}, meta: {} };
  }

  const bump = (badgeId, newValue, atIso, meta) => {
    const tracker = trackers[badgeId];
    if (newValue <= tracker.value) return;
    tracker.value = newValue;
    if (meta) tracker.meta = meta;
    const thresholds = LOCAL_BADGE_THRESHOLDS[badgeId];
    for (let i = 0; i < thresholds.length; i += 1) {
      const tierKey = LOCAL_TIER_KEYS[i];
      if (newValue >= thresholds[i] && !tracker.achieved[tierKey]) {
        tracker.achieved[tierKey] = atIso;
      }
    }
  };

  // Project-row badges (unchanged local originals).
  const seenProjects = new Set();
  const perProjectTokens = new Map();
  for (const row of sortByHour(projectRows || [])) {
    const projectKey = row.project_key;
    const tokens = Number(row.total_tokens || 0);
    if (!projectKey || tokens <= 0) continue;
    if (!seenProjects.has(projectKey)) {
      seenProjects.add(projectKey);
      bump("project_hopper", seenProjects.size, row.hour_start);
    }
    const running = (perProjectTokens.get(projectKey) || 0) + tokens;
    perProjectTokens.set(projectKey, running);
    if (running > trackers.project_devotion.value) {
      bump("project_devotion", running, row.hour_start, { project_key: projectKey });
    }
  }

  // Queue-row badges. Single pass in hour order for the cumulative/variety
  // metrics while collecting per-day totals for the day-grain badges.
  const nightHours = new Set();
  const seenModels = new Set();
  const seenSources = new Set();
  const perModelTokens = new Map();
  const perDay = new Map(); // dayKey → { tokens, firstHourIso }
  let lifetimeTokens = 0;
  let lifetimeOutputTokens = 0;
  for (const row of sortByHour(queueRows || [])) {
    const tokens = Number(row.total_tokens || 0);
    if (tokens <= 0) continue;
    const outputTokens = Number(row.output_tokens || 0);

    lifetimeTokens += tokens;
    bump("token_titan", lifetimeTokens, row.hour_start);
    lifetimeOutputTokens += outputTokens;
    bump("wordsmith", lifetimeOutputTokens, row.hour_start);

    const model = typeof row.model === "string" && row.model.trim() ? row.model : "unknown";
    if (!seenModels.has(model)) {
      seenModels.add(model);
      bump("polyglot", seenModels.size, row.hour_start);
    }
    perModelTokens.set(model, (perModelTokens.get(model) || 0) + tokens);

    const source = typeof row.source === "string" && row.source.trim() ? row.source : "unknown";
    if (!seenSources.has(source)) {
      seenSources.add(source);
      bump("multitool", seenSources.size, row.hour_start);
    }

    const parts = getZonedParts(new Date(row.hour_start), tz);
    if (!parts) continue;
    if (parts.hour < 6 && !nightHours.has(row.hour_start)) {
      nightHours.add(row.hour_start);
      bump("night_owl", nightHours.size, row.hour_start);
    }
    const dayKey = formatPartsDayKey(parts);
    if (!dayKey) continue;
    const day = perDay.get(dayKey);
    if (day) {
      day.tokens += tokens;
    } else {
      perDay.set(dayKey, { tokens, firstHourIso: row.hour_start });
    }
  }

  // Day-grain badges: replay the local days in chronological order.
  const dayKeys = Array.from(perDay.keys()).sort();
  let currentRunStart = null;
  let previousDayKey = null;
  let runLength = 0;
  const weekTokens = new Map(); // ISO week start dayKey → tokens
  for (const dayKey of dayKeys) {
    const day = perDay.get(dayKey);
    const atIso = day.firstHourIso;

    bump("marathoner", trackers.marathoner.value + 1, atIso);

    const dayMs = dayKeyToMs(dayKey);
    if (dayMs != null) {
      const dow = new Date(dayMs).getUTCDay();
      if (dow === 0 || dow === 6) {
        bump("weekend_warrior", trackers.weekend_warrior.value + 1, atIso);
      }
      if (previousDayKey != null && dayKeyToMs(previousDayKey) != null
          && dayMs - dayKeyToMs(previousDayKey) === 86_400_000) {
        runLength += 1;
      } else {
        runLength = 1;
        currentRunStart = dayKey;
      }
      if (runLength > trackers.streak.value) {
        bump("streak", runLength, atIso, { run_start: currentRunStart, run_end: dayKey });
      }
      previousDayKey = dayKey;
    }

    if (day.tokens > trackers.big_day.value) {
      bump("big_day", day.tokens, atIso, { date: dayKey });
    }

    const weekKey = isoWeekStartKey(dayKey);
    if (weekKey) {
      const total = (weekTokens.get(weekKey) || 0) + day.tokens;
      weekTokens.set(weekKey, total);
      const prevWeekKey = msToDayKey(dayKeyToMs(weekKey) - 7 * 86_400_000);
      const prevTokens = weekTokens.get(prevWeekKey) || 0;
      if (prevTokens >= MOMENTUM_PREV_WEEK_FLOOR) {
        const ratio = total / prevTokens;
        if (ratio > trackers.momentum.value) {
          bump("momentum", ratio, atIso, { week: weekKey });
        }
      }
    }
  }

  if (trackers.polyglot.value > 0) {
    let favoriteModel = null;
    let favoriteTokens = -1;
    for (const [model, tokens] of perModelTokens) {
      if (tokens > favoriteTokens) {
        favoriteTokens = tokens;
        favoriteModel = model;
      }
    }
    trackers.polyglot.meta = { favorite_model: favoriteModel };
  }

  // Veteran grows with the wall clock, not with new rows: days between the
  // first active local day and today (caller's tz). Tier timestamps are the
  // local day on which each threshold was (or will be) reached.
  if (dayKeys.length > 0) {
    const firstDayKey = dayKeys[0];
    const todayKey = formatPartsDayKey(getZonedParts(new Date(), tz));
    const firstMs = dayKeyToMs(firstDayKey);
    const todayMs = todayKey ? dayKeyToMs(todayKey) : null;
    if (firstMs != null && todayMs != null) {
      const days = Math.max(0, Math.round((todayMs - firstMs) / 86_400_000));
      const tracker = trackers.veteran;
      tracker.value = days;
      tracker.meta = { first_day: firstDayKey };
      const thresholds = LOCAL_BADGE_THRESHOLDS.veteran;
      for (let i = 0; i < thresholds.length; i += 1) {
        if (days >= thresholds[i]) {
          tracker.achieved[LOCAL_TIER_KEYS[i]] = `${msToDayKey(firstMs + thresholds[i] * 86_400_000)}T00:00:00Z`;
        }
      }
    }
  }

  return Object.entries(LOCAL_BADGE_THRESHOLDS).map(([badgeId, thresholds]) => {
    const tracker = trackers[badgeId];
    let tier = 0;
    for (let i = 0; i < thresholds.length; i += 1) {
      if (tracker.value >= thresholds[i]) tier = i + 1;
    }
    return {
      id: badgeId,
      tier,
      metric_value: tracker.value,
      thresholds: thresholds.slice(),
      lower_is_better: false,
      next_threshold: tier >= 4 ? null : thresholds[tier],
      achieved: {
        bronze: tracker.achieved.bronze || null,
        silver: tracker.achieved.silver || null,
        gold: tracker.achieved.gold || null,
        diamond: tracker.achieved.diamond || null,
      },
      meta: tracker.meta,
    };
  });
}

function getTimeZoneContext(url) {
  const tz = String(url.searchParams.get("tz") || "").trim();
  const rawOffset = Number(url.searchParams.get("tz_offset_minutes"));
  return {
    timeZone: tz || null,
    offsetMinutes: Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : null,
  };
}

function getZonedParts(date, { timeZone, offsetMinutes } = {}) {
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return null;

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      let formatter;
      if (zonedPartsFormatters.has(timeZone)) {
        formatter = zonedPartsFormatters.get(timeZone);
      } else {
        try {
          formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          });
        } catch {
          // Cache invalid zone ids too; otherwise a bad local query would
          // throw once per queue row before falling back to its fixed offset.
          formatter = null;
        }
        boundedCacheSet(
          zonedPartsFormatters,
          timeZone,
          formatter,
          MAX_TIME_ZONE_CACHE_ENTRIES,
        );
      }
      const parts = formatter?.formatToParts(dt) || [];
      const values = parts.reduce((acc, part) => {
        if (part.type && part.value) acc[part.type] = part.value;
        return acc;
      }, {});
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      const second = Number(values.second);
      if ([year, month, day, hour, minute, second].every(Number.isFinite)) {
        return { year, month, day, hour, minute, second };
      }
    } catch (_e) {
      // fall through
    }
  }

  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() + offsetMinutes * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }

  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    hour: dt.getHours(),
    minute: dt.getMinutes(),
    second: dt.getSeconds(),
  };
}

function formatPartsDayKey(parts) {
  if (!parts) return "";
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function aggregateHourlyByDay(rows, dayKey, timeZoneContext) {
  const byHour = new Map();
  for (const row of rows) {
    if (!row.hour_start) continue;
    const parts = getZonedParts(new Date(row.hour_start), timeZoneContext);
    if (!parts) continue;
    if (formatPartsDayKey(parts) !== dayKey) continue;
    const hourKey = `${dayKey}T${String(parts.hour).padStart(2, "0")}:00:00`;
    if (!byHour.has(hourKey)) {
      byHour.set(hourKey, {
        hour: hourKey,
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
    }
    const bucket = byHour.get(hourKey);
    bucket.total_tokens += row.total_tokens || 0;
    bucket.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
    bucket.input_tokens += row.input_tokens || 0;
    bucket.output_tokens += row.output_tokens || 0;
    bucket.cached_input_tokens += row.cached_input_tokens || 0;
    bucket.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    bucket.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    bucket.conversation_count += row.conversation_count || 0;

    if (!bucket.models) {
      bucket.models = {};
    }
    const model = row.model || "unknown";
    bucket.models[model] = (bucket.models[model] || 0) + (row.total_tokens || 0);
  }
  return Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour));
}

// ---------------------------------------------------------------------------
// Sync helper
// ---------------------------------------------------------------------------

function trimOutput(value, max = 4000) {
  const t = String(value || "");
  return t.length <= max ? t : t.slice(t.length - max);
}

function parseCookieHeader(value) {
  const out = new Map();
  if (typeof value !== "string" || !value.trim()) return out;
  for (const part of value.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (key) out.set(key, rawValue);
  }
  return out;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function hasAllowedLoopbackOrigin(headers = {}) {
  const candidates = [headers.origin, headers.referer];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    try {
      const url = new URL(String(raw));
      if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return false;
    } catch (_e) {
      return false;
    }
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        reject(new Error(`Request body exceeds ${Math.ceil(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", (error) => { if (!failed) reject(error); });
  });
}

function runSyncCommand(extraEnv = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [TRACKER_BIN, "sync"];
    if (opts.auto === true) args.push("--auto");
    if (opts.background === true) args.push("--background");
    if (opts.publishAccount === true) args.push("--publish-account");
    if (opts.allLocalSources === true) args.push("--all-local-sources");
    if (opts.drain === true) args.push("--drain");
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      fn(v);
    };
    const tid = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        reject,
        Object.assign(new Error("Sync timed out"), {
          code: "SYNC_TIMEOUT",
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
        }),
      );
    }, SYNC_TIMEOUT_MS);
    child.stdout?.on("data", (c) => {
      stdout += c;
    });
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (e) => {
      finish(reject, Object.assign(e, { stdout: trimOutput(stdout), stderr: trimOutput(stderr) }));
    });
    child.on("close", (code) => {
      const r = { code: code ?? 1, stdout: trimOutput(stdout), stderr: trimOutput(stderr) };
      if (code === 0) {
        finish(resolve, r);
        return;
      }
      const error = Object.assign(
        new Error(r.stderr || r.stdout || `exit ${r.code}`),
        r,
      );
      if (/\bSYNC_BUSY\b/.test(`${r.stderr}\n${r.stdout}`)) {
        error.code = "SYNC_BUSY";
      }
      finish(reject, error);
    });
  });
}

// ---------------------------------------------------------------------------
// Project detection helpers
// ---------------------------------------------------------------------------

function parseGitUrl(url) {
  if (!url) return null;
  const ssh = url.match(/git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const http = url.match(/https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (http) return { owner: http[1], repo: http[2] };
  return null;
}

function extractProjectFromCwd(cwd) {
  const home = os.homedir();
  if (!cwd || cwd === home) return null;
  const rel = cwd.replace(home + "/", "");
  const parts = rel.split("/").filter((p) => p && !p.startsWith(".") && p !== "ext-global");
  return parts.length > 0 ? parts[0] : null;
}

function scanCodexProjects(projectMap) {
  const dir = path.join(os.homedir(), ".codex", "sessions");
  try {
    for (const year of fs.readdirSync(dir)) {
      const yp = path.join(dir, year);
      if (!fs.statSync(yp).isDirectory()) continue;
      for (const month of fs.readdirSync(yp)) {
        const mp = path.join(yp, month);
        if (!fs.statSync(mp).isDirectory()) continue;
        for (const day of fs.readdirSync(mp)) {
          const dp = path.join(mp, day);
          if (!fs.statSync(dp).isDirectory()) continue;
          const files = fs.readdirSync(dp).filter((f) => f.endsWith(".jsonl"));
          for (const file of files.slice(0, 200)) {
            try {
              const first = fs.readFileSync(path.join(dp, file), "utf8").split("\n")[0];
              const d = JSON.parse(first);
              if (d.git?.repository_url) {
                const p = parseGitUrl(d.git.repository_url);
                if (p) {
                  const key = `${p.owner}/${p.repo}`;
                  if (!projectMap.has(key))
                    projectMap.set(key, {
                      project_key: key,
                      project_ref: d.git.repository_url,
                      count: 0,
                    });
                  projectMap.get(key).count++;
                }
              }
            } catch (_e) {}
          }
        }
      }
    }
  } catch (_e) {}
}

function findSubagentsDirs(dir, depth) {
  const out = [];
  if (depth > 3) return out;
  try {
    for (const item of fs.readdirSync(dir)) {
      const fp = path.join(dir, item);
      if (!fs.statSync(fp).isDirectory()) continue;
      if (item === "subagents") out.push(fp);
      else out.push(...findSubagentsDirs(fp, depth + 1));
    }
  } catch (_e) {}
  return out;
}

function scanClaudeProjects(projectMap) {
  const dir = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const subDir of findSubagentsDirs(dir, 0)) {
      const files = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
      for (const file of files.slice(0, 100)) {
        try {
          const first = fs.readFileSync(path.join(subDir, file), "utf8").split("\n")[0];
          if (!first) continue;
          const d = JSON.parse(first);
          const name = extractProjectFromCwd(d.cwd);
          if (name) {
            if (!projectMap.has(name))
              projectMap.set(name, {
                project_key: name,
                project_ref: `file://${d.cwd}`,
                count: 0,
              });
            projectMap.get(name).count++;
          }
        } catch (_e) {}
      }
    }
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

function createLocalApiHandler({ queuePath }) {
  const qp = queuePath || resolveQueuePath();

  // Loopback-only mutation guard: /api/local-auth hands this per-boot token
  // to the local dashboard so only same-machine callers can trigger syncs
  // or mutate local state. (The InsForge cookie relay, cloud-sync preference
  // mirror, and device-token issuance went away with the cloud backend.)
  const localAuthToken = crypto.randomBytes(24).toString("hex");

  function isAuthorizedLocalMutation(req) {
    const headerToken = req?.headers?.["x-tokentracker-local-auth"];
    const cookieToken = parseCookieHeader(req?.headers?.cookie).get("tokentracker_local_auth");
    const token = typeof headerToken === "string" && headerToken.trim()
      ? headerToken.trim()
      : cookieToken || "";
    if (!token || token !== localAuthToken) return false;
    return hasAllowedLoopbackOrigin(req?.headers || {});
  }

  return async function handleLocalApi(req, res, url) {
    const p = url.pathname;

    if (p === "/api/local-auth") {
      if (String(req.method || "GET").toUpperCase() !== "GET") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ token: localAuthToken }));
      return true;
    }

    // --- local Codex-compatible pet assets and package import ---
    const localPetAssetMatch = p.match(/^\/api\/pets\/local\/([a-z0-9-]+)\/spritesheet\.webp$/);
    if (localPetAssetMatch) {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      const pet = require("./pet-packages").resolvePetAsset(localPetAssetMatch[1]);
      if (!pet) {
        json(res, { error: "Pet not found" }, 404);
        return true;
      }
      const stat = fs.statSync(pet.spritesheetPath);
      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (method === "HEAD") res.end();
      else fs.createReadStream(pet.spritesheetPath).pipe(res);
      return true;
    }

    // Preview asset for a Codex pet that hasn't been imported yet (served from
    // ~/.codex/pets or straight out of the Codex.app bundle).
    const codexPetAssetMatch = p.match(/^\/api\/pets\/codex\/([a-z0-9-]+)\/spritesheet\.webp$/);
    if (codexPetAssetMatch) {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      const asset = require("./pet-packages").readCodexImportableAsset(codexPetAssetMatch[1]);
      if (!asset) {
        json(res, { error: "Pet not found" }, 404);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Content-Length": asset.buffer.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (method === "HEAD") res.end();
      else res.end(asset.buffer);
      return true;
    }

    if (p === "/api/pets/import") {
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        json(res, { ok: false, error: "Method Not Allowed" }, 405);
        return true;
      }
      if (!isAuthorizedLocalMutation(req)) {
        json(res, { ok: false, error: "Unauthorized" }, 401);
        return true;
      }
      const pets = require("./pet-packages");
      try {
        const body = await readBodyLimited(req, pets.MAX_PACKAGE_BYTES);
        json(res, { ok: true, pet: await pets.importPetZip(body) });
      } catch (error) {
        if (!res.headersSent) json(res, { ok: false, error: error?.message || "Pet import failed" }, 400);
      }
      return true;
    }

    // --- local-sync (POST) ---
    if (p === "/functions/tokentracker-local-sync") {
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        json(res, { ok: false, error: "Method Not Allowed" }, 405);
        return true;
      }
      if (!isAuthorizedLocalMutation(req)) {
        json(res, { ok: false, error: "Unauthorized" }, 401);
        return true;
      }
      try {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const drain = body.drain === true;
        const auto = body.auto === true;
        const background =
          auto && (body.background === true || body.lightweight === true);
        const publishAccount =
          background && body.publishAccount === true;
        const allLocalSources = background && body.allLocalSources === true;
        const result = await runSyncCommand({}, {
          drain,
          auto,
          background,
          publishAccount,
          allLocalSources,
        });
        try {
          const { resetUsageLimitsCache } = require("./usage-limits");
          resetUsageLimitsCache();
        } catch (_e) {
          // ignore if module load fails
        }
        json(res, { ok: true, ...result });
      } catch (e) {
        json(res, { ok: false, error: e?.message, code: e?.code ?? null, stdout: e?.stdout || "", stderr: e?.stderr || "" }, 500);
      }
      return true;
    }

    // --- wrapped (year-end summary, à la Spotify Wrapped) ---
    if (p === "/functions/tokentracker-wrapped") {
      const yearParam = url.searchParams.get("year");
      const year = yearParam ? Number(yearParam) : null;
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const { aggregateWrapped } = require("./wrapped-aggregator");
      const summary = aggregateWrapped(rows, year ? { year } : {});
      json(res, { scope, excluded_sources: excludedSources, ...summary });
      return true;
    }

    // --- usage-summary ---
    if (p === "/functions/tokentracker-usage-summary") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const allDaily = aggregateByDay(rows, timeZoneContext);
      const daily = allDaily.filter((d) => d.day >= from && d.day <= to);
      const totals = daily.reduce(
        (acc, r) => {
          acc.total_tokens += r.total_tokens;
          acc.billable_total_tokens += r.billable_total_tokens;
          acc.total_cost_usd += r.total_cost_usd || 0;
          acc.input_tokens += r.input_tokens;
          acc.output_tokens += r.output_tokens;
          acc.cached_input_tokens += r.cached_input_tokens;
          acc.cache_creation_input_tokens += r.cache_creation_input_tokens;
          acc.reasoning_output_tokens += r.reasoning_output_tokens;
          acc.conversation_count += r.conversation_count;
          return acc;
        },
        { total_tokens: 0, billable_total_tokens: 0, total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0 },
      );
      const totalCost = totals.total_cost_usd;

      const todayParts = getZonedParts(new Date(), timeZoneContext);
      const todayStr = formatPartsDayKey(todayParts) || new Date().toISOString().slice(0, 10);

      const shiftDay = (dayStr, delta) => {
        const d = new Date(`${dayStr}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + delta);
        return d.toISOString().slice(0, 10);
      };
      const collectDays = (n) => {
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
          const ds = shiftDay(todayStr, -i);
          const dd = allDaily.find((x) => x.day === ds);
          if (dd) out.push(dd);
        }
        return out;
      };
      const sumDays = (days) =>
        days.reduce((a, r) => {
          a.billable_total_tokens += r.billable_total_tokens;
          a.conversation_count += r.conversation_count;
          return a;
        }, { billable_total_tokens: 0, conversation_count: 0 });

      const l7 = collectDays(7);
      const l30 = collectDays(30);
      const l7t = sumDays(l7);
      const l30t = sumDays(l30);
      const l7fromStr = shiftDay(todayStr, -6);
      const l30fromStr = shiftDay(todayStr, -29);

      json(res, {
        from, to, days: daily.length, scope, excluded_sources: excludedSources,
        totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
        rolling: {
          last_7d: { from: l7fromStr, to: todayStr, active_days: l7.length, totals: l7t },
          last_30d: { from: l30fromStr, to: todayStr, active_days: l30.length, totals: l30t, avg_per_active_day: l30.length > 0 ? Math.round(l30t.billable_total_tokens / l30.length) : 0 },
        },
      });
      return true;
    }

    // --- usage-daily ---
    if (p === "/functions/tokentracker-usage-daily") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const daily = aggregateByDay(rows, timeZoneContext).filter((d) => d.day >= from && d.day <= to);
      json(res, { from, to, scope, excluded_sources: excludedSources, data: daily });
      return true;
    }

    // --- outcomes (opt-in quality-per-dollar / Effective Tokens; sidecar) ---
    // Reads the optional ~/.tokentracker/tracker/outcomes.jsonl sidecar and
    // joins it to the existing token/$ rows at READ time. Returns
    // available:false with empty arrays when the user hasn't opted in, so the
    // dashboard renders exactly as before. This path NEVER reads or writes
    // queue.jsonl's schema or the sync path (see GitHub #229).
    if (p === "/functions/tokentracker-outcomes") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const {
        readAllOutcomesData,
        computeQualityPerDollar,
      } = require("./outcomes-engine");
      // Refresh the independent metadata-only sidecars before joining. Any
      // scanner failure degrades to the existing manual outcomes file.
      try {
        const { buildSessionAnalytics } = require("./session-analytics");
        const { buildGitOutcomes } = require("./git-outcomes");
        const sessions = await buildSessionAnalytics();
        await buildGitOutcomes(sessions);
      } catch (error) {
        console.error("[outcomes] automatic Git attribution failed:", error?.message || error);
      }
      const outcomes = readAllOutcomesData();
      if (!outcomes.length) {
        json(res, { available: false, from, to, by_model: [], by_tool: [], totals: null });
        return true;
      }
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const result = computeQualityPerDollar(rows, outcomes, { from, to });
      json(res, { from, to, scope, excluded_sources: excludedSources, ...result });
      return true;
    }

    // --- metadata-only Claude/Codex session efficiency ---
    if (p === "/functions/tokentracker-session-insights") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const refresh = ["1", "true"].includes(url.searchParams.get("refresh"));
      try {
        const { buildSessionAnalytics, summarizeSessions, sessionsToCsv } = require("./session-analytics");
        const sessions = await buildSessionAnalytics({ force: refresh });
        const wantsCsv = url.searchParams.get("format") === "csv";
        const includeSessions = wantsCsv || ["1", "true"].includes(url.searchParams.get("include_sessions"));
        const result = summarizeSessions(sessions, { from, to, includeSessions });
        if (wantsCsv) {
          const content = sessionsToCsv(result.sessions);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/csv; charset=utf-8");
          res.setHeader("Content-Disposition", "attachment; filename=tokentracker-sessions.csv");
          res.end(content);
          return true;
        }
        json(res, { from, to, ...result });
      } catch (error) {
        json(res, { available: false, error: error?.message || "Session analytics failed" }, 500);
      }
      return true;
    }

    // --- metadata-only session browser (LOCAL ONLY) ---
    // Unlike session-insights this returns per-session rows that retain the
    // raw session_id + local project path so the dashboard can offer one-click
    // resume. It is intentionally served only from the local API and never
    // proxied to the cloud account view.
    if (p === "/functions/tokentracker-sessions") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const refresh = ["1", "true"].includes(url.searchParams.get("refresh"));
      const limitParam = parseInt(url.searchParams.get("limit") || "0", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 2000) : 0;
      // This payload contains local paths and resumable session identifiers.
      // The server is loopback-only; additionally prevent browser/proxy caches
      // from retaining the response after the page is closed.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      try {
        const { buildSessionAnalytics, listSessionsForBrowser } = require("./session-analytics");
        const sessions = await buildSessionAnalytics({ force: refresh });
        const result = listSessionsForBrowser(sessions, { from, to, limit });
        json(res, { from, to, ...result });
      } catch (error) {
        // Node fs errors embed the absolute path ("EACCES ... open '/Users/…'").
        // Keep that out of the HTTP body and log it locally instead.
        console.warn("[local-api] session browser failed:", error?.message || error);
        json(res, { available: false, error: "Session browser failed" }, 500);
      }
      return true;
    }

    // --- fixed context overhead audit (counts and estimates only) ---
    if (p === "/functions/tokentracker-context-health") {
      const { computeContextHealth } = require("./context-health");
      json(res, computeContextHealth({ home: os.homedir(), cwd: process.cwd(), env: process.env }));
      return true;
    }

    // --- usage-heatmap ---
    if (p === "/functions/tokentracker-usage-heatmap") {
      const weeks = parseInt(url.searchParams.get("weeks") || "52", 10);
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const daily = aggregateByDay(rows, timeZoneContext);
      const todayParts = getZonedParts(new Date(), timeZoneContext);
      const todayStr = formatPartsDayKey(todayParts) || new Date().toISOString().slice(0, 10);
      const end = new Date(`${todayStr}T00:00:00Z`);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);
      const from = start.toISOString().slice(0, 10);
      const to = end.toISOString().slice(0, 10);
      const byDay = new Map(daily.map((d) => [d.day, d]));

      const allValues = daily.map((d) => d.billable_total_tokens).filter((v) => v > 0);
      const maxValue = allValues.length > 0 ? Math.max(...allValues) : 0;
      const calcLevel = (v) => {
        if (v <= 0) return 0;
        if (maxValue === 0) return 1;
        const r = v / maxValue;
        if (r <= 0.25) return 1;
        if (r <= 0.5) return 2;
        if (r <= 0.75) return 3;
        return 4;
      };

      // Build cells and group into weeks (array of 7-cell arrays) for the dashboard
      const cells = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const day = cursor.toISOString().slice(0, 10);
        const data = byDay.get(day);
        const billable = data?.billable_total_tokens || 0;
        cells.push({ day, total_tokens: data?.total_tokens || 0, billable_total_tokens: billable, level: calcLevel(billable), models: data?.models || null });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      const weeksArr = [];
      for (let i = 0; i < cells.length; i += 7) {
        weeksArr.push(cells.slice(i, i + 7));
      }

      let totalCostUsd = 0;
      for (const d of daily) {
        if (d.day >= from && d.day <= to) {
          totalCostUsd += d.total_cost_usd || 0;
        }
      }

      json(res, { 
        from, 
        to, 
        scope, 
        excluded_sources: excludedSources, 
        week_starts_on: "sun", 
        active_days: cells.filter((c) => c.billable_total_tokens > 0).length, 
        streak_days: 0, 
        weeks: weeksArr,
        total_cost_usd: totalCostUsd
      });
      return true;
    }

    // --- usage-model-breakdown ---
    if (p === "/functions/tokentracker-usage-model-breakdown") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows: scopedRows, scope, excludedSources } = scopedQueueRows(qp, url);
      const rows = scopedRows.filter((r) => {
        if (!r.hour_start) return false;
        const d = rowDayKey(r, timeZoneContext);
        return d >= from && d <= to;
      });

      const bySource = new Map();
      for (const row of rows) {
        const src = row.source || "unknown";
        const mdl = row.model || "unknown";
        if (!bySource.has(src))
          bySource.set(src, { source: src, source_scope: getSourceScope(src), totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" }, models: new Map() });
        const sa = bySource.get(src);
        sa.totals.total_tokens += row.total_tokens || 0;
        sa.totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        sa.totals.input_tokens += row.input_tokens || 0;
        sa.totals.output_tokens += row.output_tokens || 0;
        sa.totals.cached_input_tokens += row.cached_input_tokens || 0;
        sa.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        sa.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        if (!sa.models.has(mdl))
          sa.models.set(mdl, { model: mdl, model_id: mdl, totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" } });
        const ma = sa.models.get(mdl);
        ma.totals.total_tokens += row.total_tokens || 0;
        ma.totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        ma.totals.input_tokens += row.input_tokens || 0;
        ma.totals.output_tokens += row.output_tokens || 0;
        ma.totals.cached_input_tokens += row.cached_input_tokens || 0;
        ma.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        ma.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
      }

      const sources = Array.from(bySource.values()).map((s) => {
        s.models = Array.from(s.models.values())
          .map((m) => {
            const cost = computeRowCost({
              ...m.totals,
              model: m.model,
              source: s.source,
            });
            return { ...m, totals: { ...m.totals, total_cost_usd: cost.toFixed(6) } };
          })
          .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
        const sourceCost = s.models.reduce((sum, m) => sum + Number(m.totals.total_cost_usd), 0);
        s.totals.total_cost_usd = sourceCost.toFixed(6);
        return s;
      });

      json(res, {
        from, to, days: 0, scope, excluded_sources: excludedSources, sources,
        pricing: { model: "per-model", pricing_mode: "per_token_type", source: "litellm", effective_from: new Date().toISOString().slice(0, 10) },
      });
      return true;
    }

    // --- usage-category-breakdown (Claude + Codex + Grok) ---
    // Claude: splits historical Claude usage into seven semantic categories
    // mirroring Claude Code's /context view (approx).
    // Codex/Grok: tool-oriented breakdown, attributing per-turn token
    // totals to observed tool calls (heuristic).
    if (p === "/functions/tokentracker-usage-category-breakdown") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const requestedSource = (url.searchParams.get("source") || "claude").trim().toLowerCase();
      if (requestedSource === "claude") {
        try {
          const result = await computeClaudeCategoryBreakdown({ from, to, projectDir: process.cwd() });
          json(res, { from, to, ...result });
        } catch (e) {
          console.error("[LocalAPI] usage-category-breakdown:", e?.message || e);
          json(res, { from, to, ...unsupportedCategoryPayload("claude"), error: "compute_failed" }, 500);
        }
        return true;
      }

      if (requestedSource === "codex") {
        try {
          const timeZoneContext = getTimeZoneContext(url);
          const result = await computeCodexContextBreakdown({
            from,
            to,
            top: 50,
            timeZoneContext,
          });
          if (!Number(result?.totals?.total_tokens || 0)) {
            const fallback = buildCodexCategoryFallbackFromQueue(readQueueData(qp), {
              from,
              to,
              timeZoneContext,
            });
            json(res, { from, to, ...fallback });
            return true;
          }
          json(res, { from, to, ...result });
        } catch (e) {
          console.error("[LocalAPI] usage-category-breakdown(codex):", e?.message || e);
          json(res, { from, to, ...unsupportedCategoryPayload("codex"), error: "compute_failed" }, 500);
        }
        return true;
      }

      if (requestedSource === "grok") {
        try {
          const timeZoneContext = getTimeZoneContext(url);
          const result = await computeGrokContextBreakdown({
            from,
            to,
            top: 50,
            timeZoneContext,
          });
          json(res, { from, to, ...result });
        } catch (e) {
          console.error("[LocalAPI] usage-category-breakdown(grok):", e?.message || e);
          json(res, { from, to, ...unsupportedCategoryPayload("grok"), error: "compute_failed" }, 500);
        }
        return true;
      }

      json(res, { from, to, ...unsupportedCategoryPayload(requestedSource) });
      return true;
    }

    // --- project-usage-summary ---
    if (p === "/functions/tokentracker-project-usage-summary") {
      // Use the per-project bucket log that rollout.js emits — it already
      // carries the actual tokens attributed to each (project_key, source,
      // hour_start). Falling back to "session-file count × total tokens"
      // (the old behavior) produced pure fiction: every short-and-hot
      // project got the same weight as every long-and-cold one.
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), PROJECT_USAGE_MAX_ENTRIES)
        : PROJECT_USAGE_MAX_ENTRIES;
      const { timeZoneContext, hasRange, dayInRange, projectRows } =
        readProjectUsageContext(qp, url);

      const aggregateEntries = (rows, keyOf, refOf) => {
        const byKey = new Map();
        for (const row of rows) {
          if (hasRange && !dayInRange(rowDayKey(row, timeZoneContext))) continue;
          const key = keyOf(row);
          if (!byKey.has(key)) {
            byKey.set(key, {
              project_key: key,
              project_ref: refOf(row),
              total_tokens: 0,
              billable_total_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
              cached_input_tokens: 0,
              cache_creation_input_tokens: 0,
              reasoning_output_tokens: 0,
              conversation_count: 0,
              sourceTotals: new Map(),
            });
          }
          const agg = byKey.get(key);
          agg.total_tokens += Number(row.total_tokens || 0);
          agg.billable_total_tokens += Number(
            row.billable_total_tokens ?? row.total_tokens ?? 0,
          );
          agg.input_tokens += Number(row.input_tokens || 0);
          agg.output_tokens += Number(row.output_tokens || 0);
          agg.cached_input_tokens += Number(row.cached_input_tokens || 0);
          agg.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
          agg.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
          agg.conversation_count += Number(row.conversation_count || 0);
          if (!agg.project_ref) agg.project_ref = refOf(row);
          const src = row.source || "unknown";
          agg.sourceTotals.set(
            src,
            (agg.sourceTotals.get(src) || 0) + Number(row.total_tokens || 0),
          );
        }
        return Array.from(byKey.values())
          .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
          .slice(0, limit)
          .map(({ sourceTotals, ...entry }) => ({
            ...entry,
            total_tokens: String(entry.total_tokens),
            billable_total_tokens: String(entry.billable_total_tokens),
            sources: Array.from(sourceTotals.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([source, totalTokens]) => ({ source, total_tokens: totalTokens })),
          }));
      };

      let entries = aggregateEntries(
        projectRows,
        (row) => row.project_key || "unknown",
        (row) => row.project_ref || "",
      );

      // If no project-attributed rows exist yet (user hasn't synced project
      // attribution, or never used a project-capable CLI), fall back to
      // per-source aggregation over the main queue so the panel isn't
      // totally empty. This path used to also exist for the non-empty case
      // and produce wrong numbers; keep it only as the empty fallback.
      if (entries.length === 0 && projectRows.length === 0) {
        entries = aggregateEntries(
          readQueueData(qp),
          (row) => row.source || "unknown",
          // Synthetic source-only row: leave project_ref empty rather than
          // fabricating `https://${src}.ai`, which resolves to unrelated
          // domains (e.g. codex.ai, cursor.ai) and was sent to the
          // dashboard as a clickable href before v0.11.1 / this commit.
          () => "",
        );
      }

      json(res, { generated_at: new Date().toISOString(), entries });
      return true;
    }

    // --- project-usage-detail ---
    // Per-project drill-down for the Project Usage modal: daily series,
    // per-source breakdown, and aggregate stats. Everything comes from the
    // local project bucket log — no external requests, no git access.
    if (p === "/functions/tokentracker-project-usage-detail") {
      const projectKey = url.searchParams.get("project_key") || "";
      if (!projectKey) {
        json(res, { error: "missing_project_key" }, 400);
        return true;
      }
      const { from, to, timeZoneContext, dayInRange, projectRows } =
        readProjectUsageContext(qp, url);

      const emptyMeasures = () => ({
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
      const addMeasures = (acc, row) => {
        acc.total_tokens += Number(row.total_tokens || 0);
        acc.billable_total_tokens += Number(
          row.billable_total_tokens ?? row.total_tokens ?? 0,
        );
        acc.input_tokens += Number(row.input_tokens || 0);
        acc.output_tokens += Number(row.output_tokens || 0);
        acc.cached_input_tokens += Number(row.cached_input_tokens || 0);
        acc.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
        acc.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
        acc.conversation_count += Number(row.conversation_count || 0);
      };

      let projectRef = "";
      const totals = emptyMeasures();
      const byDay = new Map();
      const bySource = new Map();
      let rangeTotalTokens = 0;

      for (const row of projectRows) {
        const day = rowDayKey(row, timeZoneContext);
        if (!dayInRange(day)) continue;
        rangeTotalTokens += Number(row.total_tokens || 0);
        if (row.project_key !== projectKey) continue;
        if (!projectRef && row.project_ref) projectRef = row.project_ref;
        addMeasures(totals, row);

        const src = row.source || "unknown";
        if (day) {
          // `models` keyed by source (project rows carry no model column) —
          // it feeds TrendMonitor's stacked-segment slot so the modal chart
          // colors by provider exactly like the dashboard's Usage Trend.
          if (!byDay.has(day)) byDay.set(day, { day, ...emptyMeasures(), models: {} });
          const dayAgg = byDay.get(day);
          addMeasures(dayAgg, row);
          dayAgg.models[src] = (dayAgg.models[src] || 0) + Number(row.total_tokens || 0);
        }

        if (!bySource.has(src)) {
          bySource.set(src, {
            source: src,
            total_tokens: 0,
            conversation_count: 0,
            dayKeys: new Set(),
          });
        }
        const srcAgg = bySource.get(src);
        srcAgg.total_tokens += Number(row.total_tokens || 0);
        srcAgg.conversation_count += Number(row.conversation_count || 0);
        if (day) srcAgg.dayKeys.add(day);
      }

      json(res, {
        generated_at: new Date().toISOString(),
        from,
        to,
        project_key: projectKey,
        project_ref: projectRef,
        totals,
        days_active: byDay.size,
        // All-project total over the same range so the client can render
        // "share of everything you tracked" without a second request.
        range_total_tokens: rangeTotalTokens,
        daily: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
        sources: Array.from(bySource.values())
          .sort((a, b) => b.total_tokens - a.total_tokens)
          .map(({ dayKeys, ...src }) => ({ ...src, days_active: dayKeys.size })),
      });
      return true;
    }

    // --- user-status (stub) ---
    if (p === "/functions/tokentracker-user-status") {
      json(res, {
        user_id: "local-user", email: "local@localhost", name: "Local User", is_public: false,
        created_at: new Date().toISOString(),
        pro: { active: true, sources: ["local"], expires_at: null, partial: false, as_of: new Date().toISOString() },
        // Local-only build: no cloud account exists. Native apps read this
        // block harmlessly, so keep the shape pinned to local-only values.
        account: {
          available: false,
          cloud_sync_enabled: false,
          account_view: false,
        },
      });
      return true;
    }

    // --- machine-id (stable local machine identity) ---
    if (p === "/functions/tokentracker-machine-id") {
      json(res, {
        machineId: getOrCreateMachineId(qp),
        deviceName: getSystemDeviceName(),
      });
      return true;
    }

    // --- usage-hourly (stub for day-view) ---
    if (p === "/functions/tokentracker-usage-hourly") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const data = aggregateHourlyByDay(rows, day, timeZoneContext);
      json(res, { day, scope, excluded_sources: excludedSources, data });
      return true;
    }

    // --- usage-monthly (stub for trend view) ---
    if (p === "/functions/tokentracker-usage-monthly") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const byMonth = new Map();
      for (const row of rows) {
        if (!row.hour_start) continue;
        const day = rowDayKey(row, timeZoneContext);
        if (!day || day < from || day > to) continue;
        const month = day.slice(0, 7);
        if (!byMonth.has(month))
          byMonth.set(month, { month, total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0 });
        const a = byMonth.get(month);
        a.total_tokens += row.total_tokens || 0;
        a.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        a.input_tokens += row.input_tokens || 0;
        a.output_tokens += row.output_tokens || 0;
        a.cached_input_tokens += row.cached_input_tokens || 0;
        a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        a.conversation_count += row.conversation_count || 0;

        if (!a.models) {
          a.models = {};
        }
        const model = row.model || "unknown";
        a.models[model] = (a.models[model] || 0) + (row.total_tokens || 0);
      }
      json(res, { from, to, scope, excluded_sources: excludedSources, data: Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month)) });
      return true;
    }

    // --- Codex-compatible pet manager ---
    if (p === "/functions/tokentracker-pets") {
      const method = String(req.method || "GET").toUpperCase();
      const pets = require("./pet-packages");
      try {
        if (method === "GET") {
          if (url.searchParams.get("scope") === "codex") {
            const importable = pets.listCodexImportablePets();
            json(res, { importable, codexDetected: importable.length > 0 });
            return true;
          }
          json(res, {
            pets: pets.listInstalledPets(),
            hiddenBuiltinIds: pets.readHiddenBuiltinIds(),
          });
          return true;
        }
        if (method === "POST") {
          if (!isAuthorizedLocalMutation(req)) {
            json(res, { ok: false, error: "Unauthorized" }, 401);
            return true;
          }
          const body = await readJsonBody(req);
          if (body?.action === "install_url") {
            json(res, { ok: true, pet: await pets.installFromCodexPets(body.url || body.id) });
            return true;
          }
          if (body?.action === "remove") {
            json(res, { ok: true, ...pets.removeInstalledPet(body.id) });
            return true;
          }
          if (body?.action === "import_codex") {
            json(res, { ok: true, ...pets.importFromCodex(body.ids) });
            return true;
          }
          json(res, { ok: false, error: "Unknown pets action" }, 400);
          return true;
        }
        json(res, { ok: false, error: "Method Not Allowed" }, 405);
      } catch (error) {
        json(res, { ok: false, error: error?.message || "Pet operation failed" }, 400);
      }
      return true;
    }

    // --- skills manager ---
    if (p === "/functions/tokentracker-skills") {
      const method = String(req.method || "GET").toUpperCase();
      const skills = require("./skills-manager");
      try {
        if (method === "GET") {
          const mode = url.searchParams.get("mode") || "installed";
          if (mode === "installed") {
            json(res, { targets: skills.targetList(), skills: skills.listInstalledSkills() });
            return true;
          }
          if (mode === "repos") {
            json(res, { repos: skills.listRepos() });
            return true;
          }
          if (mode === "discover") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.discoverSkills({ force }));
            return true;
          }
          if (mode === "search") {
            const data = await skills.searchSkillsSh(
              url.searchParams.get("q") || "",
              Number(url.searchParams.get("limit") || 20),
              Number(url.searchParams.get("offset") || 0),
            );
            json(res, data);
            return true;
          }
          if (mode === "popular") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.fetchPopularSkillsSh({ force }));
            return true;
          }
          if (mode === "updates") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.checkUpdates({ force }));
            return true;
          }
          if (mode === "activity") {
            const limit = Number(url.searchParams.get("limit") || 50);
            json(res, { activity: skills.readActivity(limit) });
            return true;
          }
          if (mode === "skill_usage") {
            const force = url.searchParams.get("force") === "1";
            const usage = await require("./skill-usage").scanSkillUsage({ force });
            await ensurePricingLoaded();
            // Join raw per-skill aggregates against installed skills so we can
            // separate user-installed skills (where "dead weight" = unused) from
            // Claude Code built-in tools (bash/agent/…), which dominate the logs
            // and are NOT uninstallable. Cost is priced per-model (source=claude).
            const installed = skills.listInstalledSkills();
            const skillDirectoryLeaf = (value) =>
              String(value || "").replace(/\\/g, "/").split("/").filter(Boolean).pop()?.trim().toLowerCase() || "";
            const leafCounts = new Map();
            for (const s of installed) {
              const leaf = skillDirectoryLeaf(s.directory);
              if (leaf) leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
            }
            const installedByDirectory = new Map();
            const installedByLeaf = new Map();
            const nameCounts = new Map();
            const installedByName = new Map();
            for (const s of installed) {
              const dir = String(s.directory || "").trim().toLowerCase();
              if (dir) installedByDirectory.set(dir, s);
              const leaf = skillDirectoryLeaf(s.directory);
              if (leaf && leafCounts.get(leaf) === 1) installedByLeaf.set(leaf, s);
              const name = String(s.name || "").trim().toLowerCase();
              if (name) {
                nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
                if (!installedByName.has(name)) installedByName.set(name, s);
              }
            }
            const findInstalledSkill = (value) => {
              const norm = String(value || "").trim().toLowerCase();
              if (!norm) return null;
              if (installedByDirectory.has(norm)) return installedByDirectory.get(norm);
              if (installedByLeaf.has(norm)) return installedByLeaf.get(norm);
              if (nameCounts.get(norm) === 1) return installedByName.get(norm);
              if (leafCounts.get(norm) > 1) return null;
              return null;
            };
            const usedSkillIds = new Set();
            const priced = usage.skills.map((entry) => {
              let cost = 0;
              for (const [model, tokens] of Object.entries(entry.models || {})) {
                cost += computeRowCost({ ...tokens, model, source: "claude" });
              }
              const match = findInstalledSkill(entry.skill);
              if (match?.id) usedSkillIds.add(match.id);
              return {
                skill: entry.skill,
                invocations: entry.invocations,
                lastUsedAt: entry.lastUsedAt,
                tokens: entry.tokens,
                cost,
                installed: Boolean(match),
                skillId: match?.id || null,
                directory: match?.directory || null,
              };
            });
            // Installed skills with zero invocations = dead-weight candidates.
            const unusedInstalled = installed
              .filter((s) => !s.readOnly && !usedSkillIds.has(s.id))
              .map((s) => ({ skillId: s.id, directory: s.directory, name: s.name }));
            json(res, {
              generatedAt: usage.generatedAt,
              scannedFiles: usage.scannedFiles,
              totalInvocations: usage.totalInvocations,
              cached: usage.cached,
              skills: priced,
              unusedInstalled,
            });
            return true;
          }
          json(res, { error: "Unknown skills mode" }, 400);
          return true;
        }

        if (method === "POST") {
          if (!isAuthorizedLocalMutation(req)) {
            json(res, { ok: false, error: "Unauthorized" }, 401);
            return true;
          }
          const body = await readJsonBody(req);
          const action = String(body?.action || "");
          if (action === "install") {
            json(res, { ok: true, skill: await skills.installSkill(body.skill, body.targets || ["claude", "codex"]) });
            return true;
          }
          if (action === "uninstall") {
            json(res, { ok: true, ...(skills.uninstallSkill(body.id) || {}) });
            return true;
          }
          if (action === "restore") {
            json(res, { ok: true, skill: skills.restoreSkill(body.id) });
            return true;
          }
          if (action === "set_targets") {
            json(res, { ok: true, skill: skills.setSkillTargets(body.id, body.targets || []) });
            return true;
          }
          if (action === "import_local") {
            json(res, { ok: true, skill: skills.importLocalSkill(body.directory, body.targets || []) });
            return true;
          }
          if (action === "delete_local") {
            json(res, { ok: true, ...(skills.deleteLocalSkill(body.directory, body.targets || []) || {}) });
            return true;
          }
          if (action === "add_repo") {
            json(res, { ok: true, repo: skills.addRepo(body.repo) });
            return true;
          }
          if (action === "remove_repo") {
            json(res, { ok: true, ...(skills.removeRepo(body.owner, body.name) || {}) });
            return true;
          }
          json(res, { ok: false, error: "Unknown skills action" }, 400);
          return true;
        }

        json(res, { ok: false, error: "Method Not Allowed" }, 405);
      } catch (e) {
        json(res, { ok: false, error: e?.message || "Unknown skills error" }, 500);
      }
      return true;
    }

    // --- achievements (local badges) ---
    if (p === "/functions/tokentracker-achievements") {
      const timeZoneContext = getTimeZoneContext(url);
      const queueRows = readQueueData(qp);
      const { projectRows } = readProjectUsageContext(qp, url);
      json(res, {
        generated_at: new Date().toISOString(),
        achievements: computeLocalAchievements(queueRows, projectRows, { timeZoneContext }),
      });
      return true;
    }

    // --- usage-limits ---
    if (p === "/functions/tokentracker-usage-limits") {
      const { getUsageLimits, resetUsageLimitsCache } = require("./usage-limits");
      try {
        const refreshParam = url.searchParams.get("refresh");
        const forceRefresh = refreshParam === "1" || refreshParam === "true";
        if (forceRefresh) {
          resetUsageLimitsCache();
        }
        const data = await getUsageLimits({
          home: os.homedir(),
          env: process.env,
          platform: process.platform,
          // Punches through the Claude disk fresh-cache (but not the 429
          // cooldown) — an explicit user refresh should hit upstream.
          forceRefresh,
        });
        json(res, data);
      } catch (e) {
        json(res, { error: e?.message || "Unknown error" }, 500);
      }
      return true;
    }

    return false;
  };
}

module.exports = {
  createLocalApiHandler,
  resolveQueuePath,
  // Exported for cross-consumer tests (pricing + native contract lock).
  MODEL_PRICING,
  getModelPricing,
  computeRowCost,
  ensurePricingLoaded,
  // Shared legacy-row correction so every queue reader (main queue, project
  // queue, wrapped aggregator) reports the same numbers for the same data.
  normalizeQueueRow,
  // Machine-stable identity (config.json machineId); the hostname is only a
  // human-readable label.
  getOrCreateMachineId,
  computeStableMachineId,
  getSystemDeviceName,
  // Local achievement compute — exported for test/local-achievements.test.js.
  computeLocalAchievements,
  LOCAL_BADGE_THRESHOLDS,
};
