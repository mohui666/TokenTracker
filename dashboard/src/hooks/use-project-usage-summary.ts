import { useCallback, useEffect, useState } from "react";
import { isMockEnabled } from "../lib/mock-data";
import { getProjectUsageSummary } from "../lib/api";
import { useLatestRequestGuard } from "./use-latest-request-guard";

// Always fetch the max the UI can show (TOP 10); the TOP 3/6/10 selector
// slices client-side so toggling it never refetches.
const FETCH_LIMIT = 10;

export function useProjectUsageSummary({
  baseUrl,
  accessToken,
  from,
  to,
  source,
  timeZone,
  tzOffsetMinutes,
}: any = {}) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();

  const isLocalMode = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const beginRequest = useLatestRequestGuard([
    baseUrl,
    accessToken,
    from,
    to,
    source,
    timeZone,
    tzOffsetMinutes,
  ]);

  const refresh = useCallback(async () => {
    const isCurrent = beginRequest();
    const resolvedToken = typeof accessToken === "string" ? accessToken : null;
    if (!isCurrent()) return;
    // 本地模式允许空 token
    if (!resolvedToken && !mockEnabled && !isLocalMode) {
      setEntries([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getProjectUsageSummary({
        baseUrl,
        accessToken: resolvedToken,
        limit: FETCH_LIMIT,
        from,
        to,
        source,
        timeZone,
        tzOffsetMinutes,
      });
      if (!isCurrent()) return;
      setEntries(Array.isArray(res?.entries) ? res.entries : []);
    } catch (err) {
      if (!isCurrent()) return;
      const message = (err as any)?.message || String(err);
      setError(message);
      setEntries([]);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [accessToken, baseUrl, from, mockEnabled, source, timeZone, to, tzOffsetMinutes, isLocalMode, beginRequest]);

  useEffect(() => {
    if (!mockEnabled && !isLocalMode) {
      setEntries([]);
      setError(null);
      setLoading(false);
      return;
    }
    setEntries([]);
    setError(null);
    setLoading(true);
    refresh();
  }, [mockEnabled, refresh, isLocalMode]);

  return { entries, loading, error, refresh };
}
