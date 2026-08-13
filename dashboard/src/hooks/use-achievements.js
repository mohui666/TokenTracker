import { useEffect, useMemo, useState } from "react";
import { getLocalAchievements } from "../lib/api";
import { getBrowserTimeZone, getBrowserTimeZoneOffsetMinutes } from "../lib/timezone";

/**
 * Achievements from the local CLI endpoint (all 13 catalog badges, computed
 * on-device). Status machine, never throws — the achievements page renders
 * the locked catalog on error.
 */
export function useAchievements({ enabled = true } = {}) {
  const [state, setState] = useState({ status: "loading", achievements: [], error: null });
  const timeZone = useMemo(() => getBrowserTimeZone(), []);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "disabled", achievements: [], error: null });
      return undefined;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, status: "loading" }));
    getLocalAchievements({ timeZone, tzOffsetMinutes: getBrowserTimeZoneOffsetMinutes() })
      .then((data) => {
        if (cancelled) return;
        setState({
          status: "ready",
          achievements: Array.isArray(data?.achievements) ? data.achievements : [],
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ status: "error", achievements: [], error });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, timeZone]);

  return state;
}

export default useAchievements;
