export function isMockEnabled() {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const queryValue = String(params.get("mock") || "").toLowerCase();
    if (["0", "false", "off", "no"].includes(queryValue)) return false;
    if (["1", "true", "on", "yes"].includes(queryValue)) return true;
  }
  if (typeof import.meta !== "undefined" && import.meta.env) {
    const flag = String(import.meta.env.VITE_TOKENTRACKER_MOCK || "").toLowerCase();
    if (flag === "1" || flag === "true") return true;
  }
  return false;
}
