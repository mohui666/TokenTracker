/**
 * Codex union: the two roots' cursors can diverge, and the lagging one must not
 * re-count events the other already counted.
 *
 * `union` (src/lib/install-resolver.js) makes a Windows host collect BOTH the
 * native and the WSL Codex install. When a WSL $HOME is mounted on the Windows
 * profile the SAME session file is reachable under both roots, so each root
 * keeps its own per-path cursor. If one root is missing for a run — a transient
 * `wsl.exe` failure, a shut-down distro, or a TOKENTRACKER_WSL_MODE round-trip —
 * its cursor stops advancing while the session keeps growing. On the next run it
 * re-reads that gap.
 *
 * The persisted `codexHashes` set exists to make exactly that idempotent, but
 * `needsHistoricalCodexDedup` short-circuited on `startOffset > 0` BEFORE
 * reaching its own same-session-under-another-path check, so the append-only
 * tracker (which only knows keys written during the current run) was used
 * instead. When the up-to-date root has nothing new to read it contributes no
 * keys at all, and the lagging root's replay lands in the persisted buckets and
 * the queue — and from there in the cloud totals.
 *
 * The single-install baseline pins that this is union-specific: the same
 * timeline through one root stays correct.
 */
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");
const wsl = require("../src/lib/wsl-probe");
const { mockPlatform, mockMethod } = require("./helpers/mock");

const DELETE_KEYS = [
  "TOKENTRACKER_DEVICE_TOKEN",
  "TOKENTRACKER_INSFORGE_BASE_URL",
  "TOKENTRACKER_INSFORGE_ANON_KEY",
  "TOKENTRACKER_OPENCLAW_AGENT_ID",
  "TOKENTRACKER_OPENCLAW_PREV_SESSION_ID",
  "TOKENTRACKER_OPENCLAW_SESSION_KEY",
  "KILO_HOME", "MIMO_HOME", "ZCODE_HOME", "KIRO_CLI_DB_PATH", "KIRO_HOME",
  "TOKENTRACKER_HERMES_HOME", "TOKENTRACKER_COPILOT_SESSION_STORE_DB",
  "DSH_HOME", "TOKENTRACKER_DSH_HOME",
];
const ENV_KEYS = ["HOME","USERPROFILE","CODEX_HOME","CODE_HOME","GEMINI_HOME","OPENCODE_HOME","XDG_DATA_HOME","TOKENTRACKER_OPENCLAW_HOME","APPDATA","LOCALAPPDATA","TOKENTRACKER_WSL_MODE",...DELETE_KEYS];

async function withIsolatedEnv(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-union-diverge-"));
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.TOKENTRACKER_OPENCLAW_HOME = path.join(home, ".openclaw");
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    for (const key of DELETE_KEYS) delete process.env[key];
    return await fn(home);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

const UUID = "11111111-2222-4333-8444-555555555555";
const DATE = "2026-07-31";

function usageOf(n) {
  return { input_tokens: n, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: n };
}
function eventLine(tsSuffix, turnTokens, cumulativeTotal) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: `${DATE}T00:0${tsSuffix}:00.000Z`,
    payload: { type: "token_count", info: { last_token_usage: usageOf(turnTokens), total_token_usage: usageOf(cumulativeTotal) } },
  }) + "\n";
}

function rolloutPath(codexHome) {
  return path.join(codexHome, "sessions", DATE.split("-")[0], DATE.split("-")[1], DATE.split("-")[2], `rollout-${DATE}T00-00-00-${UUID}.jsonl`);
}

async function writeShared(codexHome, content) {
  const p = rolloutPath(codexHome);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
  return p;
}

async function appendShared(codexHome, content) {
  const p = rolloutPath(codexHome);
  await fs.appendFile(p, content, "utf8");
  return p;
}

async function readQueueTokens(queuePath) {
  const raw = await fs.readFile(queuePath, "utf8").catch((e) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
  const records = raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l)) : [];
  const codex = records.filter((r) => r && r.source === "codex");
  // latest entry per (source, model, hour_start) wins
  const latest = new Map();
  for (const r of codex) latest.set(`${r.source}|${r.model}|${r.hour_start}`, r);
  return [...latest.values()].reduce((s, r) => s + (r.total_tokens || 0), 0);
}

// Shared-$HOME case: WSL $HOME symlinked onto the Windows profile makes the SAME
// codex session reachable under both roots. Both roots are unioned, so run 1
// counts it once. Then the two cursors DIVERGE (WSL root temporarily invisible
// while the session grows), and the lagging root re-reads already-counted events.
test("union: lagging second root re-counts events after a divergence", async (t) => {
  wsl.resetWslProbeCache();
  t.after(() => wsl.resetWslProbeCache());
  mockPlatform(t, "win32");

  await withIsolatedEnv(async (home) => {
    delete process.env.TOKENTRACKER_WSL_MODE; // auto == wsl-first
    const nativeCodex = path.join(home, ".codex");
    const wslCodex = path.join(home, "wsl-home", ".codex");
    const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");

    let wslVisible = true;
    mockMethod(t, wsl, "discoverWslHome", (dir) => (dir === ".codex" && wslVisible ? wslCodex : null));

    // ---- run 1: one event, total 120, visible under both roots ----
    const gen1 = eventLine(1, 120, 120);
    await writeShared(nativeCodex, gen1);
    await writeShared(wslCodex, gen1);
    await cmdSync([], {});
    assert.equal(await readQueueTokens(queuePath), 120, "run1 should count 120 once");

    // ---- run 2: session grows by 100 (cumulative 220) but WSL is invisible ----
    // (transient wsl.exe failure, distro shut down, or TOKENTRACKER_WSL_MODE=native-only)
    wslVisible = false;
    await appendShared(nativeCodex, eventLine(2, 100, 220));
    await appendShared(wslCodex, eventLine(2, 100, 220)); // same underlying file
    await cmdSync([], {});
    assert.equal(await readQueueTokens(queuePath), 220, "run2 should count the +100 once");

    // ---- run 3: WSL visible again, nothing new on disk ----
    wslVisible = true;
    await cmdSync([], {});
    const after = await readQueueTokens(queuePath);
    assert.equal(after, 220, `run3 must stay 220, got ${after}`);
  });
});

test("union: TOKENTRACKER_WSL_MODE round-trip re-counts events", async (t) => {
  wsl.resetWslProbeCache();
  t.after(() => wsl.resetWslProbeCache());
  mockPlatform(t, "win32");

  await withIsolatedEnv(async (home) => {
    delete process.env.TOKENTRACKER_WSL_MODE; // auto == wsl-first
    const nativeCodex = path.join(home, ".codex");
    const wslCodex = path.join(home, "wsl-home", ".codex");
    const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");

    let wslVisible = true;
    mockMethod(t, wsl, "discoverWslHome", (dir) => (dir === ".codex" && wslVisible ? wslCodex : null));

    // ---- run 1: one event, total 120, visible under both roots ----
    const gen1 = eventLine(1, 120, 120);
    await writeShared(nativeCodex, gen1);
    await writeShared(wslCodex, gen1);
    await cmdSync([], {});
    assert.equal(await readQueueTokens(queuePath), 120, "run1 should count 120 once");

    // ---- run 2: session grows by 100 (cumulative 220) but WSL is invisible ----
    // (transient wsl.exe failure, distro shut down, or TOKENTRACKER_WSL_MODE=native-only)
    process.env.TOKENTRACKER_WSL_MODE = "native-only";
    await appendShared(nativeCodex, eventLine(2, 100, 220));
    await appendShared(wslCodex, eventLine(2, 100, 220)); // same underlying file
    await cmdSync([], {});
    assert.equal(await readQueueTokens(queuePath), 220, "run2 should count the +100 once");

    // ---- run 3: WSL visible again, nothing new on disk ----
    delete process.env.TOKENTRACKER_WSL_MODE;
    await cmdSync([], {});
    const after = await readQueueTokens(queuePath);
    assert.equal(after, 220, `run3 must stay 220, got ${after}`);
  });
});
