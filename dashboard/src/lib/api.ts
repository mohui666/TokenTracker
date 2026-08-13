import {
  getMockUsageDaily,
  getMockUsageHourly,
  getMockUsageHeatmap,
  getMockUsageMonthly,
  getMockUsageModelBreakdown,
  getMockUsageCategoryBreakdown,
  getMockUsageSummary,
  getMockProjectUsageSummary,
  getMockProjectUsageDetail,
  getMockAchievements,
  isMockEnabled,
} from "./mock-data";
import { getLocalApiAuthHeaders } from "./local-api-auth";

type AnyRecord = Record<string, any>;

// React auth/scope resolution can make multiple consumers ask for the exact
// same GET while the first request is still in flight. Coalesce only that
// overlap (no result TTL), so manual refreshes still fetch fresh data.
const inFlightJsonGets = new Map<string, Promise<any>>();
const sessionInsightsResponseCache = new Map<string, { fetchedAt: number; value: any }>();
const SESSION_INSIGHTS_RESPONSE_TTL_MS = 5 * 60_000;
const SESSION_INSIGHTS_RESPONSE_STALE_IF_ERROR_MS = 15 * 60_000;

function coalesceJsonGet(key: string, request: () => Promise<any>) {
  const existing = inFlightJsonGets.get(key);
  if (existing) return existing;

  const pending = request();
  inFlightJsonGets.set(key, pending);
  const cleanup = () => {
    if (inFlightJsonGets.get(key) === pending) inFlightJsonGets.delete(key);
  };
  pending.then(cleanup, cleanup);
  return pending;
}

export function invalidateSessionInsightsCache() {
  sessionInsightsResponseCache.clear();
}

const PATHS = {
  usageSummary: "tokentracker-usage-summary",
  usageDaily: "tokentracker-usage-daily",
  usageHourly: "tokentracker-usage-hourly",
  usageMonthly: "tokentracker-usage-monthly",
  usageHeatmap: "tokentracker-usage-heatmap",
  usageModelBreakdown: "tokentracker-usage-model-breakdown",
  usageCategoryBreakdown: "tokentracker-usage-category-breakdown",
  projectUsageSummary: "tokentracker-project-usage-summary",
  projectUsageDetail: "tokentracker-project-usage-detail",
  achievements: "tokentracker-achievements",
  userStatus: "tokentracker-user-status",
  localSync: "tokentracker-local-sync",
  usageLimits: "tokentracker-usage-limits",
  outcomes: "tokentracker-outcomes",
  sessionInsights: "tokentracker-session-insights",
  contextHealth: "tokentracker-context-health",
};

async function fetchLocalJson(slug: string, params?: AnyRecord, options?: AnyRecord) {
  const url = new URL(`/functions/${slug}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const { accessToken: _omit, ...fetchOptions } = options || {};
  return coalesceJsonGet(url.toString(), async () => {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      ...fetchOptions,
    });
    if (!response.ok) {
      const err: any = new Error(`Request failed with HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  });
}

function buildTimeZoneParams({ timeZone, tzOffsetMinutes }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  if (tz) params.tz = tz;
  if (Number.isFinite(tzOffsetMinutes)) {
    params.tz_offset_minutes = String(Math.trunc(tzOffsetMinutes));
  }
  return params;
}

function buildFilterParams({ source, model, device }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const normalizedSource = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (normalizedSource) params.source = normalizedSource;
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel) params.model = normalizedModel;
  const normalizedDevice = typeof device === "string" ? device.trim() : "";
  if (normalizedDevice) params.device_id = normalizedDevice;
  return params;
}

export async function getUsageSummary({
  from,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  rolling = false,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageSummary({ from, to, seed: accessToken, rolling });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const rollingParams = rolling ? { rolling: "1" } : {};
  return fetchLocalJson(PATHS.usageSummary, { from, to, ...filterParams, ...tzParams, ...rollingParams }, { accessToken });
}

export async function getProjectUsageSummary({
  from,
  to,
  source,
  limit,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockProjectUsageSummary({ seed: accessToken, limit });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source });
  const params: AnyRecord = { ...filterParams, ...tzParams };
  if (from) params.from = from;
  if (to) params.to = to;
  if (limit != null) params.limit = String(limit);
  return fetchLocalJson(PATHS.projectUsageSummary, params);
}

export async function getProjectUsageDetail({
  projectKey,
  from,
  to,
  timeZone,
  tzOffsetMinutes,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockProjectUsageDetail({ projectKey, from, to });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const params: AnyRecord = { project_key: projectKey, ...tzParams };
  if (from) params.from = from;
  if (to) params.to = to;
  return fetchLocalJson(PATHS.projectUsageDetail, params);
}

/**
 * Achievements, computed by the local CLI from queue data that never leaves
 * the machine. All 13 catalog badges come from this one endpoint.
 */
export async function getLocalAchievements({ timeZone, tzOffsetMinutes }: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockAchievements();
  }
  return fetchLocalJson(PATHS.achievements, buildTimeZoneParams({ timeZone, tzOffsetMinutes }));
}

export async function getUserStatus(_opts: AnyRecord = {}) {
  if (isMockEnabled()) {
    const now = new Date().toISOString();
    return {
      user_id: "local-user",
      created_at: now,
      pro: { active: false, sources: [], expires_at: null, partial: false, as_of: now },
      subscriptions: { partial: false, as_of: now, items: [] },
      install: {
        partial: false,
        as_of: now,
        has_active_device_token: false,
        has_active_device: false,
        active_device_tokens: 0,
        active_devices: 0,
        latest_token_activity_at: null,
        latest_device_seen_at: null,
      },
    };
  }
  return fetchLocalJson(PATHS.userStatus);
}

export async function triggerLocalSync({
  signal,
  auto = false,
  background = false,
  allLocalSources = false,
  drain = false,
}: AnyRecord = {}) {
  const authHeaders = await getLocalApiAuthHeaders();
  const body: AnyRecord = {};
  if (drain) {
    body.drain = true;
  } else if (auto) {
    body.auto = true;
    if (background) {
      body.background = true;
      if (allLocalSources) body.allLocalSources = true;
    }
  }
  const response = await fetch(`/functions/${PATHS.localSync}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: `Local sync request failed with HTTP ${response.status}`,
  }));
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error || payload?.message || `Local sync request failed with HTTP ${response.status}`;
    const error: any = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function getUsageModelBreakdown({
  from,
  to,
  source,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageModelBreakdown({ from, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, device });
  return fetchLocalJson(PATHS.usageModelBreakdown, { from, to, ...filterParams, ...tzParams }, { accessToken });
}

// Opt-in quality-per-dollar / Effective-Tokens lens. Reads the optional
// outcomes.jsonl sidecar via the local server and joins it to the token/$
// rows at read time. Returns { available:false, … } when the user hasn't
// opted in, so callers render nothing new. See GitHub issue 229.
export async function getOutcomes({
  from,
  to,
  source,
  device,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return { available: false, by_model: [], by_tool: [], totals: null };
  }
  const filterParams = buildFilterParams({ source, device });
  return fetchLocalJson(PATHS.outcomes, { from, to, ...filterParams }, { accessToken });
}

export async function getSessionInsights({ from, to, refresh = false }: AnyRecord = {}) {
  if (isMockEnabled()) return { available: false, sessions: [], by_model: [], subagents: [] };
  const cacheKey = `${from || ""}\0${to || ""}`;
  const cached = sessionInsightsResponseCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.fetchedAt < SESSION_INSIGHTS_RESPONSE_TTL_MS) {
    return cached.value;
  }

  return coalesceJsonGet(`session-insights:${cacheKey}:${refresh ? "refresh" : "normal"}`, async () => {
    try {
      const value = await fetchLocalJson(PATHS.sessionInsights, { from, to, refresh: refresh ? "1" : "" });
      sessionInsightsResponseCache.set(cacheKey, { fetchedAt: Date.now(), value });
      if (sessionInsightsResponseCache.size > 32) {
        const oldest = sessionInsightsResponseCache.keys().next().value;
        if (oldest) sessionInsightsResponseCache.delete(oldest);
      }
      return value;
    } catch (error) {
      const stale = sessionInsightsResponseCache.get(cacheKey);
      if (
        stale &&
        Date.now() - stale.fetchedAt < SESSION_INSIGHTS_RESPONSE_STALE_IF_ERROR_MS &&
        !refresh
      ) {
        return stale.value;
      }
      throw error;
    }
  });
}

export async function getContextHealth() {
  if (isMockEnabled()) return { estimated_fixed_tokens: 0, severity: "low", breakdown: {}, largest_items: [] };
  return fetchLocalJson(PATHS.contextHealth);
}

export async function getUsageCategoryBreakdown({
  from,
  to,
  source = "claude",
  timeZone,
  tzOffsetMinutes,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageCategoryBreakdown({ from, to, source });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  return fetchLocalJson(PATHS.usageCategoryBreakdown, { from, to, source, ...tzParams });
}

export async function getUsageDaily({
  from,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageDaily({ from, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageDaily, { from, to, ...filterParams, ...tzParams }, { accessToken });
}

export async function getUsageHourly({
  day,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageHourly({ day, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const params = day ? { day, ...filterParams, ...tzParams } : { ...filterParams, ...tzParams };
  return fetchLocalJson(PATHS.usageHourly, params, { accessToken });
}

export async function getUsageMonthly({
  months,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageMonthly({ months, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageMonthly, {
    ...(months ? { months: String(months) } : {}),
    ...(to ? { to } : {}),
    ...filterParams,
    ...tzParams,
  }, { accessToken });
}

export async function getUsageLimits(opts: { refresh?: boolean } = {}) {
  const params = opts?.refresh ? { refresh: "1" } : undefined;
  return fetchLocalJson(PATHS.usageLimits, params);
}

export async function getUsageHeatmap({
  weeks,
  to,
  weekStartsOn,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageHeatmap({ weeks, to, weekStartsOn, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageHeatmap, {
    weeks: String(weeks),
    to,
    week_starts_on: weekStartsOn,
    ...filterParams,
    ...tzParams,
  }, { accessToken });
}
