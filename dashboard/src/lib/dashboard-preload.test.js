import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDashboardPreloadContextKey,
  getUsageLimitsPreloadContextKey,
  getDashboardPreloadSnapshot,
  preloadDashboardPageResource,
  publishReusablePageState,
  publishUsageLimitsPreloadState,
  readReusablePageState,
  readUsageLimitsPreloadState,
  resetDashboardPreload,
} from "./dashboard-preload.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("dashboard preload state", () => {
  beforeEach(() => {
    resetDashboardPreload();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("initializes fixed targets with idle resource and window-session cache status", () => {
    expect(getDashboardPreloadSnapshot()).toMatchObject({
      cache: {
        limits: null,
      },
      targets: {
        limits: { resourceStatus: "idle", stateStatus: "idle", error: null },
      },
    });
  });

  it("publishes reusable state only for a matching context key", () => {
    const contextKey = buildDashboardPreloadContextKey("limits", {
      baseUrl: "http://localhost:7680",
      mode: "local",
    });
    const data = { usage: { daily: 10 } };

    publishUsageLimitsPreloadState(data, { contextKey, source: "dashboard-existing" });

    expect(readUsageLimitsPreloadState(contextKey)).toMatchObject({
      targetKey: "limits",
      status: "fulfilled",
      data,
      error: null,
      source: "dashboard-existing",
      contextKey,
    });
    expect(readUsageLimitsPreloadState(`${contextKey}|stale`)).toBeNull();
  });

  it("reads fulfilled usage limits cache repeatedly without consuming it", () => {
    const data = { usage: { daily: 10 } };

    publishUsageLimitsPreloadState(data, { source: "dashboard-existing" });

    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
      source: "dashboard-existing",
    });
    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
      source: "dashboard-existing",
    });
  });

  it("uses the default limits context when publishing and reading usage limits state", () => {
    const data = { usage: { daily: 12 } };

    publishUsageLimitsPreloadState(data);

    expect(getUsageLimitsPreloadContextKey()).toBe(
      buildDashboardPreloadContextKey("limits", { state: "current" }),
    );
    expect(readUsageLimitsPreloadState()).toMatchObject({
      targetKey: "limits",
      status: "fulfilled",
      data,
      source: "dashboard-existing",
      contextKey: getUsageLimitsPreloadContextKey(),
    });
  });

  it("keeps fulfilled window-session cache readable without a freshness TTL", () => {
    const data = { usage: { daily: 12 } };

    publishUsageLimitsPreloadState(data, {
      generatedAt: Date.now() - 24 * 60 * 60 * 1000,
    });

    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
    });
  });

  it("supports all window-session cache write sources for fulfilled state", () => {
    for (const source of ["dashboard-existing", "silent-preload", "page-load", "manual-refresh"]) {
      const data = { source };

      publishUsageLimitsPreloadState(data, { source });

      expect(readUsageLimitsPreloadState()).toMatchObject({
        status: "fulfilled",
        data,
        source,
      });
    }
  });

  it("does not let rejected usage limits results overwrite an existing fulfilled cache", () => {
    const data = { usage: { daily: 12 } };

    publishUsageLimitsPreloadState(data, { source: "page-load" });
    publishUsageLimitsPreloadState(null, {
      status: "rejected",
      source: "manual-refresh",
      error: "network down",
    });

    expect(getDashboardPreloadSnapshot().targets.limits).toMatchObject({
      stateStatus: "rejected",
      error: "network down",
    });
    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
      source: "page-load",
    });
  });

  it("clears window-session cache on reset", () => {
    const firstSessionId = getDashboardPreloadSnapshot().sessionId;
    publishUsageLimitsPreloadState({ usage: { daily: 12 } });

    resetDashboardPreload();

    expect(getDashboardPreloadSnapshot().sessionId).not.toBe(firstSessionId);
    expect(readUsageLimitsPreloadState()).toBeNull();
  });

  it("uses state.context when publishing generic reusable page state", () => {
    const context = {
      baseUrl: "http://localhost:7680",
      mode: "local",
    };
    const contextKey = buildDashboardPreloadContextKey("limits", context);
    const data = { usage: { daily: 10 } };

    publishReusablePageState("limits", { data, context });

    expect(readReusablePageState("limits", contextKey)).toMatchObject({
      status: "fulfilled",
      data,
      contextKey,
    });
    expect(readReusablePageState("limits", buildDashboardPreloadContextKey("limits"))).toBeNull();
  });

  it("reuses pending and fulfilled resource preloads for duplicate calls", async () => {
    const pending = deferred();
    const loader = vi.fn(() => pending.promise);

    const first = preloadDashboardPageResource("limits", { loader });
    const second = preloadDashboardPageResource("limits", { loader });

    expect(first).toBe(second);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getDashboardPreloadSnapshot().targets.limits.resourceStatus).toBe("pending");

    pending.resolve({ LimitsPage: () => null });
    await expect(first).resolves.toEqual({ LimitsPage: expect.any(Function) });

    const fulfilled = preloadDashboardPageResource("limits", { loader });
    await expect(fulfilled).resolves.toEqual({ LimitsPage: expect.any(Function) });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getDashboardPreloadSnapshot().targets.limits.resourceStatus).toBe("fulfilled");
  });

  it("records resource failures internally without throwing to callers", async () => {
    const loader = vi.fn(() => Promise.reject(new Error("chunk unavailable")));

    await expect(preloadDashboardPageResource("limits", { loader })).resolves.toBeNull();

    expect(getDashboardPreloadSnapshot().targets.limits).toMatchObject({
      resourceStatus: "rejected",
      error: "chunk unavailable",
    });
  });

  it("does not let skipped state overwrite existing fulfilled page data cache", () => {
    const contextKey = buildDashboardPreloadContextKey("limits", {
      baseUrl: "http://localhost:7680",
    });
    const data = { usage: { daily: 10 } };

    publishUsageLimitsPreloadState(data, { contextKey });
    publishUsageLimitsPreloadState(null, {
      contextKey,
      status: "skipped",
      error: "auth-loading",
    });

    expect(getDashboardPreloadSnapshot().targets.limits).toMatchObject({
      stateStatus: "skipped",
      error: "auth-loading",
    });
    expect(readUsageLimitsPreloadState(contextKey)).toMatchObject({
      status: "fulfilled",
      data,
    });
  });

  it("keeps page data cache separate when resource preload fails", async () => {
    const data = { usage: { daily: 12 } };
    const loader = vi.fn(() => Promise.reject(new Error("chunk unavailable")));

    publishUsageLimitsPreloadState(data);
    await expect(preloadDashboardPageResource("limits", { loader })).resolves.toBeNull();

    expect(getDashboardPreloadSnapshot().targets.limits).toMatchObject({
      resourceStatus: "rejected",
      stateStatus: "fulfilled",
      error: "chunk unavailable",
    });
    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
    });
  });

  it("clears stale target errors when window-session cache becomes fulfilled", () => {
    const contextKey = buildDashboardPreloadContextKey("limits", {
      baseUrl: "http://localhost:7680",
    });

    publishUsageLimitsPreloadState(null, {
      contextKey,
      status: "rejected",
      error: "network down",
    });
    expect(getDashboardPreloadSnapshot().targets.limits.error).toBe("network down");

    publishUsageLimitsPreloadState({ usage: { daily: 12 } }, { contextKey });

    expect(getDashboardPreloadSnapshot().targets.limits).toMatchObject({
      stateStatus: "fulfilled",
      error: null,
    });
    expect(readUsageLimitsPreloadState(contextKey)).toMatchObject({
      status: "fulfilled",
      data: { usage: { daily: 12 } },
      error: null,
    });
  });

  it("does not persist page data cache to browser storage, IndexedDB, or a server", () => {
    const localStorageSetItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchSpy = vi.fn();
    const indexedDB = {
      open: vi.fn(),
      deleteDatabase: vi.fn(),
    };
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("indexedDB", indexedDB);

    publishUsageLimitsPreloadState({ usage: { daily: 12 } });

    expect(readUsageLimitsPreloadState()).toMatchObject({ status: "fulfilled" });
    expect(localStorageSetItem).not.toHaveBeenCalled();
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(indexedDB.deleteDatabase).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("dashboard preload route boundary", () => {
  it("keeps target pages lazy-loaded and free of removed cloud routes", () => {
    const appSource = readFileSync(join(process.cwd(), "src/App.jsx"), "utf8");

    expect(appSource).toContain('import("./pages/LimitsPage.jsx")');
    expect(appSource).not.toContain("LeaderboardPage");
    expect(appSource).not.toContain("NativeAuthCallbackPage");
    expect(appSource).not.toContain("LoginPage");
  });
});
