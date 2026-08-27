"use strict";

// Ark Coding Plan (火山方舟 Coding Plan) quota monitoring.
//
// Coding Plan is a subscription-style quota product (Lite/Pro) that refreshes
// on three windows — 5-hour (session), weekly and monthly — and is shared by
// every compatible coding tool (Claude Code, Codex CLI, OpenCode, TRAE, ...).
// TokenTracker already counts those tools' token consumption from their local
// files, so this module deliberately adds NO consumption source. It only
// surfaces the subscription quota percentage, which is otherwise only visible
// in the Volcano console web page.
//
// The quota is read through the user's own `arkcli` binary
// (`arkcli usage plan --format json`), which is already installed and logged
// in for users of the Ark CLI ecosystem. Feature-detected: when `arkcli` is
// missing, the provider simply reports `configured: false` and stays out of
// the way. Mirrors qoder-limits.js; shares the command runner with
// usage-limits.js through ./command-runner (no circular dependency).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runCommand, resolveBinaryPath, statBinaryInDirs, commonGlobalBinDirectories } = require("./command-runner");

const ARK_LIMITS_CACHE_FILE = "ark-coding-plan-limits-cache.json";
const ARK_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS = 12 * 60 * 60 * 1000;
const ARK_USAGE_PLAN_TIMEOUT_MS = 10_000;
// `profile show` only runs on the cache-guard path, after `usage plan`
// already failed. It must not push the total past the outer provider
// timeout (the whole point of the fallback is to still serve the disk
// cache), so it gets a much shorter leash.
const ARK_PROFILE_SHOW_TIMEOUT_MS = 2_500;
const ARK_CLI_STDERR_TRIM = 400;
// Mirrors usage-limits.js DEFAULT_PROVIDER_TIMEOUT_MS, which is what the
// production caller passes in; kept local to avoid a circular require.
const ARK_PROVIDER_TIMEOUT_MS = 15_000;
// A runCommand whose timeout fires still takes up to ~1s to hard-kill
// (SIGTERM -> SIGKILL escalation). Reserve that plus slack so the serial
// chain (discovery -> usage plan -> plans get / profile show -> cache
// read) always settles inside the provider budget and the disk-cache
// fallback actually gets served instead of losing the outer race.
// Same shape as codexResetCreditListTimeoutMs's guard in usage-limits.js.
const ARK_PROVIDER_BUDGET_GUARD_MS = 1_500;

// arkcli period label -> canonical window slot. `session` is the 5-hour
// rolling window; `weekly` and `monthly` refresh on calendar boundaries.
const ARK_PERIOD_WINDOW = {
  session: "primary_window",
  weekly: "secondary_window",
  monthly: "tertiary_window",
};

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function normalizeResetAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return null;
    const milliseconds = raw > 10_000_000_000 ? raw : raw * 1000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

// The provider's display name is already "Ark Coding Plan", so the plan label
// carries only the tier — otherwise the panel title would read
// "Ark Coding Plan Coding Plan Lite".
function planLabelForTier(tier) {
  const normalized = String(tier || "").trim().toLowerCase();
  if (normalized === "pro") return "Pro";
  if (normalized === "lite") return "Lite";
  return tier && String(tier).trim() ? String(tier).trim() : null;
}

/**
 * Normalize the JSON payload returned by `arkcli plans get --format json`.
 * The tier ("lite" / "pro") lives on the plans payload, not on the usage
 * payload, so it is resolved here and merged into the plan label.
 * Returns null when there is no Coding Plan entry.
 */
function normalizeArkPlansResponse(body) {
  if (!body || typeof body !== "object") return null;
  const plans = Array.isArray(body.plans) ? body.plans : [];
  const plan = plans.find((entry) => entry?.key === "coding-plan");
  return plan?.tier ? String(plan.tier) : null;
}

function arkProfileIdentity(body) {
  const profile = body?.profile && typeof body.profile === "object" ? body.profile : body;
  const name = typeof body?.profile === "string"
    ? body.profile
    : profile?.name || profile?.profile || profile?.profile_name;
  let userId = profile?.user_id || profile?.userId || body?.user_id || body?.userId;
  if (!userId) {
    // `arkcli profile show` reports the account through owner_trn /
    // identity_key (e.g. "trn:iam::1234567890:root" / "volc-1234567890")
    // instead of a user_id field — extract the numeric id so identities
    // coming from `usage plan`'s viewer and from `profile show` compare
    // equal.
    const trnMatch = String(profile?.owner_trn || "").match(/::(\d+):/);
    if (trnMatch) userId = trnMatch[1];
    else {
      const keyMatch = String(profile?.identity_key || "").match(/-(\d+)$/);
      if (keyMatch) userId = keyMatch[1];
    }
  }
  const identity = [name, userId].filter(Boolean).join(":");
  return identity || null;
}

/**
 * Normalize the JSON payload returned by `arkcli usage plan --format json`.
 * Returns `null` when the account has no active Coding Plan subscription
 * (caller reports `configured: false`). Throws when the payload shape is
 * unusable so the caller can fall back to the disk cache.
 */
function normalizeArkCodingPlanResponse(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Ark Coding Plan response is not an object.");
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const item = items.find((entry) => entry?.product === "coding-plan");
  if (!item || item.subscribed !== true) return null;

  const windows = {};
  const periods = Array.isArray(item.periods) ? item.periods : [];
  for (const period of periods) {
    const slot = ARK_PERIOD_WINDOW[period?.label];
    if (!slot) continue;
    const percent = Number(period.percent);
    if (!Number.isFinite(percent)) continue;
    windows[slot] = {
      used_percent: clampPercent(percent),
      reset_at: normalizeResetAt(period.reset_at),
      unit: "calls",
    };
  }
  if (!windows.primary_window && !windows.secondary_window && !windows.tertiary_window) {
    throw new Error("Ark Coding Plan response contains no usable quota periods.");
  }

  return {
    configured: true,
    error: null,
    plan_label: planLabelForTier(item.tier),
    primary_window: windows.primary_window || null,
    secondary_window: windows.secondary_window || null,
    tertiary_window: windows.tertiary_window || null,
    source: "provider-api",
    profile_identity: arkProfileIdentity(body.viewer),
  };
}

function arkCodingPlanCachePath({ home = os.homedir() } = {}) {
  return path.join(home, ".tokentracker", "tracker", ARK_LIMITS_CACHE_FILE);
}

function readArkCodingPlanLimitsCache({ home = os.homedir(), nowMs = Date.now(), profileIdentity } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(arkCodingPlanCachePath({ home }), "utf8"));
    // Deliberately fail-open: the guard only applies when `profile show`
    // could establish the current identity. When it also failed, serving
    // the stale cache beats erroring out — availability over strictness.
    if (profileIdentity && parsed?.profile_identity !== profileIdentity) return null;
    const cachedAtMs = Date.parse(parsed?.cached_at || "");
    if (!Number.isFinite(cachedAtMs) || cachedAtMs > nowMs + 60_000) return null;
    // A window whose reset_at has passed is stale — the quota has already
    // rolled over, so serving its old used_percent would mislead. Drop it.
    const windows = [parsed?.primary_window, parsed?.secondary_window, parsed?.tertiary_window];
    const surviving = windows.map((window) => {
      if (!window) return null;
      const resetAtMs = Date.parse(window.reset_at || "");
      if (Number.isFinite(resetAtMs) && resetAtMs <= nowMs) return null;
      return window;
    });
    if (surviving.every((window) => !window)) return null;
    // Undated windows can't be checked against a reset, so drop each one when
    // the snapshot is too old. A future-dated sibling must not keep it alive.
    const bounded = surviving.map((window) => {
      if (!window) return null;
      return Number.isFinite(Date.parse(window.reset_at || ""))
        || nowMs - cachedAtMs <= ARK_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS
        ? window
        : null;
    });
    if (bounded.every((window) => !window)) return null;
    return {
      configured: true,
      error: null,
      plan_label: typeof parsed?.plan_label === "string" ? parsed.plan_label : null,
      primary_window: bounded[0],
      secondary_window: bounded[1],
      tertiary_window: bounded[2],
      cached: true,
      stale: true,
      cached_at: parsed.cached_at,
      source: "disk-cache",
    };
  } catch (_error) {
    return null;
  }
}

function writeArkCodingPlanLimitsCache(limits, { home = os.homedir(), nowMs = Date.now() } = {}) {
  if (!limits?.configured || limits.error) return;
  const cachePath = arkCodingPlanCachePath({ home });
  const payload = {
    plan_label: limits.plan_label || null,
    profile_identity: limits.profile_identity || null,
    primary_window: limits.primary_window || null,
    secondary_window: limits.secondary_window || null,
    tertiary_window: limits.tertiary_window || null,
    cached_at: new Date(nowMs).toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

// runCommand / whichBinary / resolveBinaryPath now live in ./command-runner,
// shared with usage-limits.js (single implementation, no forked copies).

// arkcli keeps its config and credentials under ~/.arkcli (plus a couple of
// platform-typical alternates). Checking for these directories is a
// spawn-free way to tell "arkcli has never been installed" apart from
// "installed but the quota call failed" — machines without the CLI skip the
// binary probe entirely on every poll, so the 5s refresh cadence never pays
// a `which` spawn for a provider they cannot use.
function hasArkCliInstallEvidence({ home = os.homedir(), platform = process.platform } = {}) {
  const candidates = [
    path.join(home, ".arkcli"),
    path.join(home, ".config", "arkcli"),
  ];
  if (platform === "win32") {
    candidates.push(path.join(home, "AppData", "Roaming", "arkcli"));
  }
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return true;
    } catch (_error) {}
  }
  return false;
}

function trimStderr(stderr) {
  const text = String(stderr || "").trim();
  if (!text) return null;
  return text.length > ARK_CLI_STDERR_TRIM
    ? `${text.slice(0, ARK_CLI_STDERR_TRIM)}…`
    : text;
}

/**
 * Fetch Ark Coding Plan quota windows from the local `arkcli` binary.
 *
 * Resolution order:
 *  1. no config-dir evidence AND no arkcli in the global bin dirs
 *                                                             -> { configured: false }, zero spawns
 *  2. arkcli binary not resolvable                            -> { configured: false }
 *  3. `arkcli usage plan` succeeds but no subscription        -> { configured: false }
 *  4. live success                                            -> { configured: true, ...windows }
 *  5. command/parse failure -> bounded disk cache             -> { configured: true, ...stale }
 *  6. nothing usable                                          -> { configured: true, error }
 *
 * Only `usage plan` runs on the happy path. `plans get` (tier label) runs
 * only when the usage response carries no tier, and `profile show` (the
 * cross-account cache guard) only when the disk cache is consulted.
 *
 * `providerTimeoutMs` bounds the whole serial chain (mirrors the codex
 * remaining-budget pattern): each CLI call's timeout is clamped to what
 * is left of the budget, and calls whose share has run out are skipped
 * so the disk-cache fallback still resolves inside the outer race.
 */
async function fetchArkCodingPlanLimits({
  commandRunner,
  home = os.homedir(),
  nowMs = Date.now(),
  platform = process.platform,
  signal,
  globalBinDirs,
  providerTimeoutMs = ARK_PROVIDER_TIMEOUT_MS,
} = {}) {
  // Mirror of codexResetCreditListTimeoutMs: every CLI call in the serial
  // chain gets a timeout clamped to what is left of the provider budget,
  // so the chain can never outrun the outer provider race and starve the
  // disk-cache fallback.
  const startedAtMs = performance.now();
  const budgetedTimeoutMs = (fullTimeoutMs) => {
    if (!Number.isFinite(providerTimeoutMs) || providerTimeoutMs <= 0) return fullTimeoutMs;
    const remainingMs = providerTimeoutMs - (performance.now() - startedAtMs);
    if (remainingMs <= 0) return 0;
    const guardedMs = Math.floor(remainingMs - ARK_PROVIDER_BUDGET_GUARD_MS);
    if (guardedMs <= 0) return 0;
    return Math.min(fullTimeoutMs, guardedMs);
  };

  const searchDirs = () => Array.isArray(globalBinDirs)
    ? globalBinDirs
    : commonGlobalBinDirectories({ home, platform });

  let arkcliPath;
  if (hasArkCliInstallEvidence({ home, platform })) {
    try {
      arkcliPath = await resolveBinaryPath("arkcli", { commandRunner, home, platform, signal, globalBinDirs });
    } catch (_error) {
      arkcliPath = null;
    }
  } else {
    // No config-dir evidence — still resolve spawn-free first: an arkcli
    // found in a global bin directory counts as install evidence too (the
    // CLI may keep its config somewhere we don't know about). Only when
    // that also misses do we bail, so machines without the CLI still pay
    // zero spawns per poll.
    arkcliPath = statBinaryInDirs("arkcli", searchDirs(), platform);
  }
  if (!arkcliPath) return { configured: false };

  const commandOptions = {
    signal,
    killProcessGroup: true,
    platform,
    // npm installs CLI entrypoints as .cmd shims on Windows, which a direct
    // spawn cannot execute. Every argument here is a constant with no shell
    // metacharacters, so shell execution is safe for this call site only —
    // it must stay opt-in (see command-runner.js).
    useShell: platform === "win32",
  };

  // Budget already drained before the primary call could run: report the
  // timeout without touching the cache — an unverified cache (profile
  // identity unknown) must not be served on this path, mirroring the
  // outer provider race's behavior. The verified-cache fallback below is
  // what keeps hung-CLI polls serving last-known data.
  const usageTimeoutMs = budgetedTimeoutMs(ARK_USAGE_PLAN_TIMEOUT_MS);
  if (usageTimeoutMs <= 0) {
    return { configured: true, error: "Ark Coding Plan provider timed out before arkcli could run." };
  }

  // Spawn the resolved absolute path, never the bare name: on Windows
  // cmd.exe searches the current directory before PATH, so a bare
  // `arkcli` would let an `arkcli.bat` dropped in the server cwd hijack
  // the spawn.
  const result = await runCommand(
    commandRunner,
    arkcliPath,
    ["usage", "plan", "--format", "json"],
    { ...commandOptions, timeout: usageTimeoutMs },
  );

  const failWithCache = async (message) => {
    // Short leash, further clamped to the remaining provider budget: this
    // runs after `usage plan` already burned most of the budget; a slow or
    // hung arkcli here must not starve the cache read that the caller is
    // actually waiting for. When no budget is left the spawn is skipped
    // entirely and the cache is read fail-open (identity unknown).
    const profileTimeoutMs = budgetedTimeoutMs(ARK_PROFILE_SHOW_TIMEOUT_MS);
    const profileIdentity = profileTimeoutMs > 0
      ? await runCommand(
        commandRunner,
        arkcliPath,
        ["profile", "show", "--format", "json"],
        { ...commandOptions, timeout: profileTimeoutMs },
      ).then((profileResult) => {
        if (profileResult?.error || profileResult?.status !== 0) return null;
        try {
          return arkProfileIdentity(JSON.parse(String(profileResult.stdout || "")));
        } catch (_error) {
          return null;
        }
      }).catch(() => null)
      : null;
    const cached = readArkCodingPlanLimitsCache({ home, nowMs, profileIdentity });
    if (cached) return cached;
    return { configured: true, error: message };
  };

  if (result?.error || result?.status !== 0) {
    const detail = result?.error?.message
      || (result?.status !== 0 && result?.status !== null
        ? `arkcli exited with code ${result.status}`
        : "arkcli usage plan failed");
    const stderr = trimStderr(result?.stderr);
    return failWithCache(stderr ? `${detail}: ${stderr}` : detail);
  }

  let body;
  try {
    body = JSON.parse(String(result?.stdout || ""));
  } catch (_error) {
    return failWithCache("arkcli usage plan returned invalid JSON.");
  }

  let limits;
  try {
    limits = normalizeArkCodingPlanResponse(body);
  } catch (error) {
    return failWithCache(error?.message || "Ark Coding Plan response could not be parsed.");
  }
  if (!limits) {
    // Only a response that explicitly carries the coding-plan entry with
    // `subscribed: false` confirms the plan was retired — drop the cache
    // then, or a later transient CLI failure would resurrect the retired
    // plan's numbers through failWithCache. A payload with *no*
    // coding-plan entry at all (`{}`, `{"items":[]}` — not logged in,
    // backend degraded, product key renamed) is ambiguous and must NOT
    // destroy the cache: transient signals never drive persistent state.
    const entry = Array.isArray(body?.items)
      ? body.items.find((candidate) => candidate?.product === "coding-plan")
      : null;
    if (entry && entry.subscribed === false) {
      try {
        fs.unlinkSync(arkCodingPlanCachePath({ home }));
      } catch (_error) {}
    }
    return { configured: false };
  }

  if (!limits.plan_label) {
    // The tier ("lite" / "pro") lives on the `plans get` payload; fetch it
    // only when the usage response did not carry one, and only while the
    // provider budget still has room for the spawn. A skipped fetch just
    // leaves the label null — never worth losing the live data over.
    const plansTimeoutMs = budgetedTimeoutMs(ARK_USAGE_PLAN_TIMEOUT_MS);
    if (plansTimeoutMs > 0) {
      const plansResult = await runCommand(
        commandRunner,
        arkcliPath,
        ["plans", "get", "--format", "json"],
        { ...commandOptions, timeout: plansTimeoutMs },
      );
      if (!plansResult?.error && plansResult?.status === 0) {
        try {
          const tier = normalizeArkPlansResponse(JSON.parse(String(plansResult.stdout || "")));
          if (tier) limits.plan_label = planLabelForTier(tier);
        } catch (_error) {}
      }
    }
  }

  writeArkCodingPlanLimitsCache(limits, { home, nowMs });
  return limits;
}

module.exports = {
  ARK_PERIOD_WINDOW,
  normalizeArkPlansResponse,
  arkProfileIdentity,
  normalizeArkCodingPlanResponse,
  readArkCodingPlanLimitsCache,
  writeArkCodingPlanLimitsCache,
  hasArkCliInstallEvidence,
  fetchArkCodingPlanLimits,
};
