export const DASHBOARD_PRELOAD_TARGETS = Object.freeze(["limits"]);

export const DASHBOARD_PRELOAD_STATUSES = Object.freeze([
  "idle",
  "pending",
  "fulfilled",
  "rejected",
  "skipped",
]);

const TARGET_ROUTES = Object.freeze({
  limits: "/limits",
});

const DEFAULT_RESOURCE_LOADERS = Object.freeze({
  limits: () => import("../pages/LimitsPage.jsx"),
});

const PAGE_STATE_SOURCES = Object.freeze([
  "dashboard-existing",
  "silent-preload",
  "page-load",
  "manual-refresh",
]);
let sessionCounter = 0;
let session;

class WindowSessionCache {
  constructor() {
    this.limits = null;
  }

  read(targetKey, contextKey) {
    assertTargetKey(targetKey);
    if (!this.limits || this.limits.contextKey !== contextKey) return null;
    return cloneCacheEntry(this.limits);
  }

  write(entry) {
    this.limits = entry;
  }

  snapshot() {
    return {
      limits: cloneCacheEntry(this.limits),
    };
  }
}

class DashboardWindowSession {
  constructor() {
    sessionCounter += 1;
    this.sessionId = `dashboard-preload-${sessionCounter}`;
    this.createdAt = Date.now();
    this.completedAt = null;
    this.startedAfterMainContentVisible = false;
    this.cache = new WindowSessionCache();
    this.targets = {
      limits: createTarget("limits"),
    };
  }
}

function createTarget(key) {
  return {
    key,
    route: TARGET_ROUTES[key],
    resourceStatus: "idle",
    stateStatus: "idle",
    error: null,
    resourcePromise: null,
    resourceModule: null,
    resourceRequestId: 0,
    statePromise: null,
    stateRequestId: 0,
    pendingStateContextKey: null,
  };
}

function createSession() {
  return new DashboardWindowSession();
}

session = createSession();

function assertTargetKey(targetKey) {
  if (!DASHBOARD_PRELOAD_TARGETS.includes(targetKey)) {
    throw new Error(`Unknown dashboard preload target: ${targetKey}`);
  }
}

function normalizeError(error) {
  if (!error) return null;
  if (typeof error === "string") return error;
  return error.message || String(error);
}

function normalizePageStateSource(source, fallback) {
  if (PAGE_STATE_SOURCES.includes(source)) return source;
  return fallback;
}

function normalizeGeneratedAt(value) {
  const generatedAt = Number(value);
  if (Number.isFinite(generatedAt)) return generatedAt;
  return Date.now();
}

function cloneCacheEntry(entry) {
  if (!entry) return null;
  return { ...entry };
}

function targetSnapshot(target) {
  return {
    key: target.key,
    route: target.route,
    resourceStatus: target.resourceStatus,
    stateStatus: target.stateStatus,
    error: target.error,
  };
}

function updateCompletedAt() {
  const settled = DASHBOARD_PRELOAD_TARGETS.every((key) => {
    const target = session.targets[key];
    return (
      target.resourceStatus === "fulfilled" ||
      target.resourceStatus === "rejected"
    );
  });
  session.completedAt = settled ? Date.now() : null;
}

export function resetDashboardPreload() {
  session = createSession();
}

export function markDashboardMainContentVisible() {
  session.startedAfterMainContentVisible = true;
}

export function getDashboardPreloadSnapshot() {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    completedAt: session.completedAt,
    startedAfterMainContentVisible: session.startedAfterMainContentVisible,
    cache: session.cache.snapshot(),
    targets: {
      limits: targetSnapshot(session.targets.limits),
    },
  };
}

export function buildDashboardPreloadContextKey(targetKey, context = {}) {
  assertTargetKey(targetKey);
  const entries = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value === null ? "null" : String(value)}`);
  return `${targetKey}:${entries.join("|")}`;
}

export function preloadDashboardPageResource(targetKey, options = {}) {
  assertTargetKey(targetKey);
  const target = session.targets[targetKey];
  if (target.resourceStatus === "fulfilled") {
    return Promise.resolve(target.resourceModule);
  }
  if (target.resourceStatus === "pending" && target.resourcePromise) {
    return target.resourcePromise;
  }

  const loader = options.loader || DEFAULT_RESOURCE_LOADERS[targetKey];
  const requestId = target.resourceRequestId + 1;
  target.resourceRequestId = requestId;
  target.resourceStatus = "pending";
  target.error = null;
  const promise = Promise.resolve()
    .then(() => loader())
    .then((module) => {
      if (target.resourceRequestId !== requestId || target.resourcePromise !== promise) {
        return null;
      }
      target.resourceStatus = "fulfilled";
      target.resourceModule = module;
      target.error = null;
      updateCompletedAt();
      return module;
    })
    .catch((error) => {
      if (target.resourceRequestId !== requestId || target.resourcePromise !== promise) {
        return null;
      }
      target.resourceStatus = "rejected";
      target.error = normalizeError(error);
      updateCompletedAt();
      return null;
    });

  target.resourcePromise = promise;
  return promise;
}

export function preloadDashboardPageResources(options = {}) {
  const loaders = options.loaders || {};
  return Promise.all(
    DASHBOARD_PRELOAD_TARGETS.map((targetKey) =>
      preloadDashboardPageResource(targetKey, { loader: loaders[targetKey] }),
    ),
  );
}

export function publishReusablePageState(targetKey, state) {
  assertTargetKey(targetKey);
  const target = session.targets[targetKey];
  const status = state?.status || "fulfilled";
  const cacheEntry = {
    targetKey,
    status,
    data: state?.data ?? null,
    error: normalizeError(state?.error),
    source: normalizePageStateSource(state?.source, "silent-preload"),
    generatedAt: normalizeGeneratedAt(state?.generatedAt),
    updatedAt: Date.now(),
    contextKey: state?.contextKey || buildDashboardPreloadContextKey(targetKey, state?.context || {}),
  };

  target.stateStatus = status;
  if (status === "rejected") {
    target.error = cacheEntry.error;
  } else if (status === "skipped") {
    target.error = cacheEntry.error;
  } else if (status === "fulfilled") {
    target.error = null;
    session.cache.write(cacheEntry);
  }
  return cloneCacheEntry(cacheEntry);
}

export function readReusablePageState(targetKey, contextKey) {
  assertTargetKey(targetKey);
  return session.cache.read(targetKey, contextKey);
}

export function publishUsageLimitsPreloadState(data, options = {}) {
  return publishReusablePageState("limits", {
    data,
    source: options.source || "dashboard-existing",
    contextKey: options.contextKey || getUsageLimitsPreloadContextKey(options.context || {}),
    generatedAt: options.generatedAt,
    status: options.status || "fulfilled",
    error: options.error,
  });
}

export function getUsageLimitsPreloadContextKey(context = {}) {
  return buildDashboardPreloadContextKey("limits", { state: "current", ...context });
}

export function readUsageLimitsPreloadState(contextKey = getUsageLimitsPreloadContextKey()) {
  return readReusablePageState("limits", contextKey);
}
