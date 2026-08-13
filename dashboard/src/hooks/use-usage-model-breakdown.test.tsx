import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUsageModelBreakdown } from "../lib/api";
import { useUsageModelBreakdown } from "./use-usage-model-breakdown";

vi.mock("../lib/api", () => ({
  getUsageModelBreakdown: vi.fn(),
}));
vi.mock("../lib/mock-data", () => ({ isMockEnabled: () => false }));

describe("useUsageModelBreakdown", () => {
  beforeEach(() => {
    vi.mocked(getUsageModelBreakdown).mockReset();
    window.localStorage.clear();
  });

  it("clears the previous range and ignores its late provider response", async () => {
    let resolveMonth: (value: any) => void = () => {};
    let resolveDay: (value: any) => void = () => {};
    vi.mocked(getUsageModelBreakdown).mockImplementation(({ from }: any) =>
      new Promise((resolve) => {
        if (from === "2026-06-01") resolveMonth = resolve;
        else resolveDay = resolve;
      }),
    );

    const { result, rerender } = renderHook(
      ({ from, to }) =>
        useUsageModelBreakdown({
          baseUrl: "",
          from,
          to,
          cacheKey: "provider-race",
          timeZone: "UTC",
        }),
      { initialProps: { from: "2026-06-01", to: "2026-06-30" } },
    );

    await waitFor(() => expect(getUsageModelBreakdown).toHaveBeenCalledTimes(1));
    rerender({ from: "2026-06-30", to: "2026-06-30" });
    expect(result.current.breakdown).toBeNull();
    await waitFor(() => expect(getUsageModelBreakdown).toHaveBeenCalledTimes(2));

    await act(async () => resolveDay({ sources: [{ source: "codex", totals: { total_tokens: 100 } }] }));
    await waitFor(() => expect(result.current.breakdown?.sources?.[0]?.totals?.total_tokens).toBe(100));

    await act(async () => resolveMonth({ sources: [{ source: "claude", totals: { total_tokens: 9_999 } }] }));
    expect(result.current.breakdown?.sources?.[0]?.source).toBe("codex");
    expect(result.current.breakdown?.sources?.[0]?.totals?.total_tokens).toBe(100);
    expect(result.current.loading).toBe(false);
  });
});
