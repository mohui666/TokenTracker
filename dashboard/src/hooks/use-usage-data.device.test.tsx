import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUsageDaily, getUsageSummary } from "../lib/api";
import { useUsageData } from "./use-usage-data";

vi.mock("../lib/api", () => ({
  getUsageDaily: vi.fn(async () => ({ from: "2026-06-01", to: "2026-06-30", data: [] })),
  getUsageSummary: vi.fn(async () => ({ totals: { total_tokens: 0 }, rolling: null })),
}));
vi.mock("../lib/mock-data", () => ({ isMockEnabled: () => false }));

describe("useUsageData device scope", () => {
  beforeEach(() => {
    vi.mocked(getUsageDaily).mockClear();
    vi.mocked(getUsageSummary).mockClear();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });

  it("forwards deviceId to the daily fetcher", async () => {
    renderHook(() =>
      useUsageData({
        baseUrl: "",
        from: "2026-06-01",
        to: "2026-06-30",
        includeDaily: true,
        cacheKey: "u1",
        timeZone: "UTC",
        deviceId: "dev-7",
      }),
    );
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalled());
    expect(vi.mocked(getUsageDaily).mock.calls[0][0]).toMatchObject({ device: "dev-7" });
  });

  it("skips the summary request for a daily-only consumer", async () => {
    renderHook(() =>
      useUsageData({
        baseUrl: "",
        from: "2026-06-01",
        to: "2026-06-30",
        includeDaily: true,
        includeSummary: false,
        cacheKey: "daily-only",
        timeZone: "UTC",
      }),
    );

    await waitFor(() => expect(getUsageDaily).toHaveBeenCalled());
    expect(getUsageSummary).not.toHaveBeenCalled();
  });
});
