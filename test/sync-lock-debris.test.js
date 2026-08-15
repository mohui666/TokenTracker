const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { openLock } = require("../src/lib/fs");
const { cmdSync } = require("../src/commands/sync");
const { cmdStatus } = require("../src/commands/status");

const DEAD_PID = 2_147_483_647;

function heartbeatPathFor(lockPath, token) {
  const tokenDigest = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  return `${lockPath}.heartbeat.${tokenDigest}`;
}

// Reproduce the debris a killed sync leaves behind: an owner file naming a dead
// pid plus its token-specific heartbeat.
async function writeAbandonedLock(lockPath, { pid = DEAD_PID } = {}) {
  const token = `abandoned-${crypto.randomUUID()}`;
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid, token, createdAt: new Date().toISOString() }) + "\n",
    "utf8",
  );
  const heartbeatPath = heartbeatPathFor(lockPath, token);
  await fs.writeFile(heartbeatPath, `${token}\n`, "utf8");
  return { token, heartbeatPath };
}

async function writeAbandonedGuardChain(lockPath, depth) {
  const guards = [];
  let guardPath = lockPath;
  for (let level = 0; level < depth; level += 1) {
    guardPath = `${guardPath}.reclaim`;
    const { heartbeatPath } = await writeAbandonedLock(guardPath);
    guards.push({ guardPath, heartbeatPath });
  }
  return guards;
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (_e) {
    return false;
  }
}

async function withLockPath(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-lock-debris-"));
  try {
    await fn(path.join(directory, "sync.lock"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-lock-debris-home-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    DSH_HOME: process.env.DSH_HOME,
    TOKENTRACKER_DSH_HOME: process.env.TOKENTRACKER_DSH_HOME,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    delete process.env.DSH_HOME;
    delete process.env.TOKENTRACKER_DSH_HOME;
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

function captureStream(stream) {
  const original = stream.write.bind(stream);
  const chunks = [];
  stream.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    if (typeof rest[rest.length - 1] === "function") rest[rest.length - 1]();
    return true;
  };
  return {
    text: () => chunks.join(""),
    restore: () => {
      stream.write = original;
    },
  };
}

for (const depth of [4, 6]) {
  test(`sync lock clears an abandoned ${depth}-level reclaim guard chain`, async () => {
    await withLockPath(async (lockPath) => {
      const { heartbeatPath } = await writeAbandonedLock(lockPath);
      const guards = await writeAbandonedGuardChain(lockPath, depth);

      const lock = await openLock(lockPath, { quietIfLocked: true });
      assert.ok(lock, "a lock whose owner and whose guard chain are all dead must be reclaimable");

      const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
      assert.equal(owner.pid, process.pid);
      assert.equal(await exists(heartbeatPath), false);
      for (const guard of guards) {
        assert.equal(await exists(guard.guardPath), false, `${guard.guardPath} must be swept`);
        assert.equal(await exists(guard.heartbeatPath), false);
      }

      await lock.release();
    });
  });
}

test("sync lock never sweeps a live reclaim guard", async () => {
  await withLockPath(async (lockPath) => {
    await writeAbandonedLock(lockPath);
    const guardPath = `${lockPath}.reclaim`;
    const liveGuard = await openLock(guardPath, {
      quietIfLocked: true,
      serializeRelease: false,
    });
    assert.ok(liveGuard);

    assert.equal(await openLock(lockPath, { quietIfLocked: true }), null);
    assert.equal(await exists(guardPath), true);
    const guardOwner = JSON.parse(await fs.readFile(guardPath, "utf8"));
    assert.equal(guardOwner.pid, process.pid);

    await liveGuard.release();
  });
});

// Deliberate behaviour, pinned so it is not "fixed" later. A guard is meant to
// be held for one indivisible rename+recreate, so a live owner whose heartbeat
// has not ticked for LOCK_STALE_MS means the filesystem holding the lock is
// hung, not that the owner is healthy. Revoking is the escape hatch: a shorter
// threshold would revoke MORE aggressively, and a longer one brings back the
// permanent stall this sweep exists to break (issue #431).
test("a guard whose owner is alive but heartbeat has gone stale is swept", async () => {
  await withLockPath(async (lockPath) => {
    await writeAbandonedLock(lockPath);
    const guardPath = `${lockPath}.reclaim`;
    const liveGuard = await openLock(guardPath, {
      quietIfLocked: true,
      serializeRelease: false,
    });
    assert.ok(liveGuard);

    // Age every heartbeat belonging to the guard past the staleness window
    // while this very much alive process still owns it.
    const dir = path.dirname(guardPath);
    const prefix = `${path.basename(guardPath)}.heartbeat.`;
    const stale = (Date.now() - 10 * 60 * 1000) / 1000;
    let aged = 0;
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith(prefix)) continue;
      await fs.utimes(path.join(dir, name), stale, stale);
      aged += 1;
    }
    assert.equal(aged, 1, "the guard should own exactly one heartbeat file");

    const lock = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(lock, "a stale guard chain must not block acquisition forever");
    assert.equal(await exists(guardPath), false, "the stale guard should be gone");

    await lock.release();
    await liveGuard.release().catch(() => {});
  });
});

test("sync warns and records a queryable marker when the lock cannot be acquired", async () => {
  await withTempHome(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const lockPath = path.join(trackerDir, "sync.lock");
    await writeAbandonedLock(lockPath);
    // A live guard keeps the dead lease unreclaimable, which is exactly the
    // state that used to make sync exit 0 with no output at all.
    const liveGuard = await openLock(`${lockPath}.reclaim`, {
      quietIfLocked: true,
      serializeRelease: false,
    });
    assert.ok(liveGuard);

    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      await cmdSync([]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    assert.match(stderr.text(), /lock_debris/);

    const marker = JSON.parse(
      await fs.readFile(path.join(trackerDir, "sync.skip.json"), "utf8"),
    );
    assert.equal(marker.reason, "lock_debris");
    assert.match(String(marker.detail), new RegExp(String(DEAD_PID)));
    assert.equal(typeof marker.at, "string");

    const statusOut = captureStream(process.stdout);
    let summary = null;
    try {
      await cmdStatus(["--json"]);
      summary = JSON.parse(statusOut.text());
    } finally {
      statusOut.restore();
    }
    assert.equal(summary.last_sync_skipped?.reason, "lock_debris");
    assert.equal(summary.last_sync_skipped?.at, marker.at);

    await liveGuard.release();
  });
});

test("sync clears a stale skip marker once the lock is acquired again", async () => {
  await withTempHome(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const markerPath = path.join(trackerDir, "sync.skip.json");
    await fs.writeFile(
      markerPath,
      JSON.stringify({ reason: "lock_debris", at: new Date().toISOString() }),
      "utf8",
    );

    const stdout = captureStream(process.stdout);
    try {
      await cmdSync(["--auto"]);
    } finally {
      stdout.restore();
    }

    assert.equal(await exists(markerPath), false);
  });
});

test("sync releases its lock when stale skip marker cleanup fails", async () => {
  await withTempHome(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(path.join(trackerDir, "sync.skip.json"), { recursive: true });

    await assert.rejects(cmdSync(["--auto"]), (error) => (
      error?.code === "EISDIR" || error?.code === "EPERM"
    ));

    assert.equal(
      await exists(path.join(trackerDir, "sync.lock")),
      false,
      "marker cleanup errors must not strand the acquired sync lease",
    );
  });
});
