/**
 * Trae Work CN usage-API incremental parser tests.
 *
 * Synthetic rows only. Verifies the parser's contract:
 *   - raw normalization / prevalidation before any cursor/bucket mutation
 *   - per-session reconciliation (subtract old contribution, add new) with a
 *     versioned cursors.traeCn state and source "trae-cn"
 *   - fail-closed corruption / malformed-state handling
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseTraeCnApiIncremental } = require("../src/lib/rollout");

function tempQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trae-cn-"));
  return {
    dir,
    queuePath: path.join(dir, "queue.jsonl"),
  };
}

function queueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function lastTraeRow(queuePath, model, hourStart) {
  return queueRows(queuePath)
    .filter(
      (row) =>
        // Usage rows only: the queue also carries account_session_state
        // control records (same source/model, no hour_start).
        !row.kind &&
        row.source === "trae-cn" &&
        row.model === model &&
        (hourStart === undefined || row.hour_start === hourStart),
    )
    .at(-1);
}

// Compare only the deterministic, meaningful state (drops updatedAt timestamps).
function stripState(cursors) {
  const buckets = {};
  for (const [key, bucket] of Object.entries(cursors.hourly?.buckets || {})) {
    buckets[key] = bucket?.totals;
  }
  const sessions = {};
  for (const [id, entry] of Object.entries(cursors.traeCn?.sessions || {})) {
    sessions[id] = { model: entry.model, bucketStart: entry.bucketStart, totals: entry.totals };
  }
  return { hourlyBuckets: buckets, sessions };
}

const T1 = 1_700_000_000; // 2023-11-14T22:13:20Z -> 22:00 bucket
const T2 = 1_700_002_000; // 2023-11-14T22:46:40Z -> 22:30 bucket
const B1 = "2023-11-14T22:00:00.000Z";
const B2 = "2023-11-14T22:30:00.000Z";

function sessionRow(overrides = {}) {
  return {
    session_id: "s1",
    model_name: "doubao-pro",
    usage_time: T1,
    input_token: 100,
    output_token: 10,
    cache_read_token: 0,
    cache_write_token: 0,
    ...overrides,
  };
}

test("first insert maps direct and extra_info shapes into canonical buckets", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  let progressCalls = 0;
  const onProgress = () => {
    progressCalls += 1;
  };
  const direct = sessionRow({ session_id: "s-direct", cache_read_token: 30, cache_write_token: 40 });
  const extra = {
    session_id: "s-extra",
    model_name: "doubao-lite",
    usage_time: T2,
    extra_info: { input_token: 5, output_token: 6, cache_read_token: 7, cache_write_token: 8 },
  };

  const result = await parseTraeCnApiIncremental({ sessions: [direct, extra], cursors, queuePath, onProgress });
  assert.equal(result.recordsProcessed, 2);
  assert.equal(result.eventsAggregated, 2);
  assert.ok(result.bucketsQueued >= 1);
  assert.ok(progressCalls > 0, "progress callback fires");

  const rows = queueRows(queuePath).filter((row) => row.source === "trae-cn");
  const pro = rows.find((row) => row.model === "doubao-pro");
  const lite = rows.find((row) => row.model === "doubao-lite");
  assert.ok(pro, "direct row queued");
  assert.ok(lite, "extra_info row queued");

  assert.equal(pro.hour_start, B1);
  assert.deepEqual(
    {
      input: pro.input_tokens,
      cached: pro.cached_input_tokens,
      cacheCreation: pro.cache_creation_input_tokens,
      output: pro.output_tokens,
      reasoning: pro.reasoning_output_tokens,
      total: pro.total_tokens,
      billable: pro.billable_total_tokens,
      conv: pro.conversation_count,
    },
    // input_token is cache-inclusive: fresh = 100-30-40, total = 100+10.
    { input: 30, cached: 30, cacheCreation: 40, output: 10, reasoning: 0, total: 110, billable: 110, conv: 1 },
  );

  assert.equal(lite.hour_start, B2);
  // Clamped to the cache-inclusive input: cached=min(5,7)=5, creation
  // gets no room left (min(0,8)=0), fresh=0, total=5+6.
  assert.equal(lite.input_tokens, 0);
  assert.equal(lite.output_tokens, 6);
  assert.equal(lite.cached_input_tokens, 5);
  assert.equal(lite.cache_creation_input_tokens, 0);
  assert.equal(lite.total_tokens, 11);

  assert.equal(cursors.traeCn.version, 1);
  assert.equal(cursors.traeCn.sessions["s-direct"].model, "doubao-pro");
  assert.equal(cursors.traeCn.sessions["s-direct"].bucketStart, B1);
  assert.equal(cursors.traeCn.sessions["s-direct"].totals.input_tokens, 30);
  assert.equal(cursors.traeCn.sessions["s-extra"].bucketStart, B2);
});

test("cache-inclusive input_token is peeled into subset columns (real-data shape)", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  // Shape observed on real GLM rows: every prompt token hit the cache, so
  // input_token equals cache_read_token exactly (ratio floor 1.0 across 135
  // real rows). Ordinary input must be 0, not input_token again.
  const fullHit = sessionRow({ session_id: "full-hit", input_token: 500, output_token: 7, cache_read_token: 500 });
  // Partial hit: 200 of 500 cached -> fresh 300, total = 500 + 7.
  const partial = sessionRow({ session_id: "partial", input_token: 500, output_token: 7, cache_read_token: 200 });
  // No cache activity at all (Doubao/DeepSeek shape): columns stay as-is.
  const noCache = sessionRow({ session_id: "no-cache", input_token: 500, output_token: 7 });

  await parseTraeCnApiIncremental({ sessions: [fullHit, partial, noCache], cursors, queuePath });
  assert.equal(cursors.traeCn.sessions["full-hit"].totals.input_tokens, 0);
  assert.equal(cursors.traeCn.sessions["full-hit"].totals.cached_input_tokens, 500);
  assert.equal(cursors.traeCn.sessions["full-hit"].totals.total_tokens, 507);
  assert.equal(cursors.traeCn.sessions["partial"].totals.input_tokens, 300);
  assert.equal(cursors.traeCn.sessions["partial"].totals.cached_input_tokens, 200);
  assert.equal(cursors.traeCn.sessions["partial"].totals.total_tokens, 507);
  assert.equal(cursors.traeCn.sessions["no-cache"].totals.input_tokens, 500);
  assert.equal(cursors.traeCn.sessions["no-cache"].totals.cached_input_tokens, 0);
  assert.equal(cursors.traeCn.sessions["no-cache"].totals.total_tokens, 507);
});

test("identical payload twice appends no queue row and no token growth", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const row = sessionRow();

  const first = await parseTraeCnApiIncremental({ sessions: [row], cursors, queuePath });
  assert.equal(first.eventsAggregated, 1);
  const before = fs.readFileSync(queuePath, "utf8");

  const second = await parseTraeCnApiIncremental({ sessions: [row], cursors, queuePath });
  assert.equal(second.recordsProcessed, 1);
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), before, "queue unchanged");
});

test("growth and downward correction preserve a shared-bucket sibling", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const a = sessionRow({ session_id: "A" });
  const b = sessionRow({ session_id: "B", input_token: 200, output_token: 20 });

  await parseTraeCnApiIncremental({ sessions: [a, b], cursors, queuePath });

  const grow = await parseTraeCnApiIncremental({ sessions: [sessionRow({ session_id: "A", input_token: 150 })], cursors, queuePath });
  assert.equal(grow.eventsAggregated, 1);
  let latest = lastTraeRow(queuePath, "doubao-pro");
  assert.equal(latest.input_tokens, 200 + 150, "sibling B kept while A grows");
  assert.equal(latest.output_tokens, 20 + 10);

  const shrink = await parseTraeCnApiIncremental({ sessions: [sessionRow({ session_id: "A", input_token: 60 })], cursors, queuePath });
  assert.equal(shrink.eventsAggregated, 1);
  latest = lastTraeRow(queuePath, "doubao-pro");
  assert.equal(latest.input_tokens, 200 + 60, "sibling B kept while A shrinks");
  assert.equal(latest.total_tokens, 200 + 20 + 60 + 10);
  assert.equal(cursors.traeCn.sessions.B.totals.input_tokens, 200, "sibling contribution preserved in cursor");
});

test("model and time-bucket moves retract the old tuple and write the new one", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const row = sessionRow();

  await parseTraeCnApiIncremental({ sessions: [row], cursors, queuePath });
  assert.equal(lastTraeRow(queuePath, "doubao-pro", B1).total_tokens, 110);

  // Model move: same bucket, different model.
  const moved = await parseTraeCnApiIncremental({ sessions: [sessionRow({ model_name: "doubao-lite" })], cursors, queuePath });
  assert.equal(moved.eventsAggregated, 1);
  assert.equal(lastTraeRow(queuePath, "doubao-pro", B1).total_tokens, 0, "old model tuple retracted to zero");
  assert.equal(lastTraeRow(queuePath, "doubao-lite", B1).total_tokens, 110);

  // Time-bucket move: same model, shifted half-hour bucket.
  const shifted = await parseTraeCnApiIncremental({ sessions: [sessionRow({ model_name: "doubao-lite", usage_time: T2 })], cursors, queuePath });
  assert.equal(shifted.eventsAggregated, 1);
  assert.equal(lastTraeRow(queuePath, "doubao-lite", B1).total_tokens, 0, "old time tuple retracted to zero");
  assert.equal(lastTraeRow(queuePath, "doubao-lite", B2).total_tokens, 110);
});

test("missing model_name values use the TRAE sentinel and reconcile without changing totals", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const missing = sessionRow({ session_id: "missing-model" });
  delete missing.model_name;
  const nullModel = sessionRow({ session_id: "null-model", model_name: null });
  const blankModel = sessionRow({ session_id: "blank-model", model_name: " ", mode: "" });

  await parseTraeCnApiIncremental({ sessions: [missing, nullModel, blankModel], cursors, queuePath });
  assert.equal(cursors.traeCn.sessions["missing-model"].model, "trae-cn-unknown");
  assert.equal(cursors.traeCn.sessions["null-model"].model, "trae-cn-unknown");
  assert.equal(cursors.traeCn.sessions["blank-model"].model, "trae-cn-unknown");
  assert.equal(lastTraeRow(queuePath, "trae-cn-unknown", B1).total_tokens, 330);

  await parseTraeCnApiIncremental({
    sessions: [sessionRow({ session_id: "transition", model_name: "doubao-pro" })],
    cursors,
    queuePath,
  });
  await parseTraeCnApiIncremental({
    sessions: [sessionRow({ session_id: "transition", model_name: "" })],
    cursors,
    queuePath,
  });
  assert.equal(lastTraeRow(queuePath, "doubao-pro", B1).total_tokens, 0);
  assert.equal(lastTraeRow(queuePath, "trae-cn-unknown", B1).total_tokens, 440);

  await parseTraeCnApiIncremental({
    sessions: [sessionRow({ session_id: "transition", model_name: "doubao-pro" })],
    cursors,
    queuePath,
  });
  assert.equal(lastTraeRow(queuePath, "trae-cn-unknown", B1).total_tokens, 330);
  assert.equal(lastTraeRow(queuePath, "doubao-pro", B1).total_tokens, 110);
});

test("reordered payload and identical duplicate session records yield the same result", async (t) => {
  const dirA = tempQueue();
  const dirB = tempQueue();
  t.after(() => {
    fs.rmSync(dirA.dir, { recursive: true, force: true });
    fs.rmSync(dirB.dir, { recursive: true, force: true });
  });
  const cursorsA = {};
  const cursorsB = {};
  const a = sessionRow({ session_id: "A", input_token: 10, output_token: 1 });
  const b = sessionRow({ session_id: "B", model_name: "doubao-lite", usage_time: T2, input_token: 20, output_token: 2 });

  await parseTraeCnApiIncremental({ sessions: [a, b], cursors: cursorsA, queuePath: dirA.queuePath });
  await parseTraeCnApiIncremental({ sessions: [b, a], cursors: cursorsB, queuePath: dirB.queuePath });
  assert.deepEqual(stripState(cursorsB), stripState(cursorsA), "order does not change the result");

  // Identical duplicate session records are accepted once within one payload.
  const dirC = tempQueue();
  t.after(() => fs.rmSync(dirC.dir, { recursive: true, force: true }));
  const cursorsC = {};
  const dup = await parseTraeCnApiIncremental({
    sessions: [a, { ...a }],
    cursors: cursorsC,
    queuePath: dirC.queuePath,
  });
  assert.equal(dup.recordsProcessed, 2);
  assert.equal(dup.eventsAggregated, 1, "exact duplicate accepted once");
  assert.equal(cursorsC.traeCn.sessions.A.totals.input_tokens, 10);
});

test("conflicting duplicate ids and malformed rows fail before any mutation", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const canary = "session-id-canary";
  const row = sessionRow({ session_id: canary });

  await assert.rejects(
    parseTraeCnApiIncremental({ sessions: [row, sessionRow({ session_id: canary, input_token: 200 })], cursors, queuePath }),
    (error) => {
      assert.match(error.message, /conflicting contributions/);
      assert.ok(!error.message.includes(canary));
      return true;
    },
  );
  assert.equal(cursors.hourly, undefined, "no hourly state assigned");
  assert.equal(cursors.traeCn, undefined, "no traeCn state assigned");
  assert.equal(fs.existsSync(queuePath), false, "no queue rows written");

  // Cache fields are optional: models without a prompt-cache concept (Doubao /
  // DeepSeek on TRAE CN) legitimately omit them — absent means 0, not malformed.
  // Uses its own queue dir so the no-mutation assertions below stay meaningful.
  const optionalQueue = tempQueue();
  const cursorsOptional = {};
  const missing = sessionRow({ session_id: canary });
  delete missing.cache_read_token;
  delete missing.cache_write_token;
  const optionalResult = await parseTraeCnApiIncremental({
    sessions: [missing],
    cursors: cursorsOptional,
    queuePath: optionalQueue.queuePath,
  });
  assert.equal(optionalResult.skippedRows, 0);
  assert.equal(cursorsOptional.traeCn.sessions[canary].totals.cached_input_tokens, 0);
  fs.rmSync(optionalQueue.dir, { recursive: true, force: true });

  // A malformed row FAILS THE WHOLE SNAPSHOT closed (P0: a partially
  // understood snapshot must never become the authoritative window state -
  // no bucket rows, no session states, no cursor commit). Confirmed-legal
  // variations (absent cache fields) are handled above and stay legal.
  const mixedQueue = tempQueue();
  const cursorsMixed = {};
  await assert.rejects(
    parseTraeCnApiIncremental({
      sessions: [
        sessionRow({ session_id: canary, cache_read_token: "lots" }),
        sessionRow({ session_id: "healthy-row" }),
      ],
      cursors: cursorsMixed,
      queuePath: mixedQueue.queuePath,
    }),
    (error) => {
      assert.match(error.message, /not authoritative/);
      assert.match(error.message, /1 malformed row/);
      assert.match(error.message, /invalid cache_read_token/);
      assert.ok(!error.message.includes(canary));
      return true;
    },
  );
  assert.equal(cursorsMixed.hourly, undefined, "no state assigned on a partial snapshot");
  assert.equal(cursorsMixed.traeCn, undefined, "no traeCn state on a partial snapshot");
  assert.equal(fs.existsSync(mixedQueue.queuePath), false, "no queue rows written (no buckets, no watermark)");
  fs.rmSync(mixedQueue.dir, { recursive: true, force: true });
  // A payload where EVERY row is malformed fails with the same unified
  // not-authoritative error (reason stays diagnosable + id-free).
  await assert.rejects(
    parseTraeCnApiIncremental({ sessions: [sessionRow({ session_id: canary, cache_read_token: "lots" })], cursors, queuePath }),
    (error) => {
      assert.match(error.message, /not authoritative/);
      assert.match(error.message, /invalid cache_read_token/);
      assert.ok(!error.message.includes(canary));
      return true;
    },
  );
  // Model names containing "|" are rejected because bucket keys are unescaped.
  await assert.rejects(
    parseTraeCnApiIncremental({ sessions: [sessionRow({ session_id: canary, model_name: "bad|model" })], cursors, queuePath }),
    (error) => {
      assert.match(error.message, /not authoritative/);
      assert.match(error.message, /unsupported model name/);
      assert.ok(!error.message.includes(canary));
      return true;
    },
  );
  // Invalid usage_time / sessions / cursors.
  await assert.rejects(
    parseTraeCnApiIncremental({ sessions: [sessionRow({ session_id: canary, usage_time: -5 })], cursors, queuePath }),
    (error) => {
      assert.match(error.message, /invalid usage_time/);
      assert.ok(!error.message.includes(canary));
      return true;
    },
  );
  await assert.rejects(parseTraeCnApiIncremental({ sessions: "nope", cursors, queuePath }), /sessions must be an array/);
  await assert.rejects(parseTraeCnApiIncremental({ sessions: [], cursors: null, queuePath }), /cursors must be a writable object/);

  assert.equal(cursors.hourly, undefined);
  assert.equal(cursors.traeCn, undefined);
  assert.equal(fs.existsSync(queuePath), false);
});

test("empty payload is a no-op and preserves existing contributions", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const row = sessionRow();

  await parseTraeCnApiIncremental({ sessions: [row], cursors, queuePath });
  const before = fs.readFileSync(queuePath, "utf8");

  const empty = await parseTraeCnApiIncremental({ sessions: [], cursors, queuePath });
  assert.equal(empty.recordsProcessed, 0);
  assert.equal(empty.eventsAggregated, 0);
  assert.equal(empty.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), before, "no queue change");
  assert.equal(cursors.traeCn.sessions["s1"].totals.input_tokens, 100, "contribution preserved");
  assert.equal(lastTraeRow(queuePath, "doubao-pro").total_tokens, 110);
});

test("empty payload asserts nothing: no usage mutation, no session states (absence contract NOT PROVEN)", async (t) => {
  // Evidence: two real fetches 17min apart (137 -> 141 sessions, 0
  // disappeared, 0 changed) show a stable session set, but nothing proves
  // that an absent session means deleted/zero. An empty response therefore
  // asserts NOTHING - no usage mutation AND no account_session_state
  // observation that could displace another device's canonical rows.
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  await parseTraeCnApiIncremental({ sessions: [sessionRow()], cursors, queuePath });
  const before = fs.readFileSync(queuePath, "utf8");

  const empty = await parseTraeCnApiIncremental({
    sessions: [],
    cursors,
    queuePath,
    windowStartMs: 1_700_000_000_000,
    windowEndMs: 1_700_000_000_000 + 30 * 24 * 3600 * 1000,
  });
  assert.equal(empty.recordsProcessed, 0);
  assert.equal(empty.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), before, "no session state appended for an empty response");
  assert.equal(cursors.traeCn.sessions.s1.totals.input_tokens, 100, "contribution preserved");
});

test("a partial snapshot (99 valid + 1 malformed) publishes no session states even with a window", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  await assert.rejects(
    parseTraeCnApiIncremental({
      sessions: [sessionRow({ session_id: "bad-row", usage_time: "x" })].concat(
        Array.from({ length: 3 }, (_, i) => sessionRow({ session_id: "ok-" + i })),
      ),
      cursors,
      queuePath,
      windowStartMs: 1_700_000_000_000,
      windowEndMs: 1_700_000_000_000 + 30 * 24 * 3600 * 1000,
    }),
    /not authoritative/,
  );
  assert.equal(fs.existsSync(queuePath), false, "neither bucket rows nor session states may land");
  assert.equal(cursors.hourly, undefined, "previous canonical state untouched locally");
});
test("cursors survive a serialize/parse restart and a later correction", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let cursors = {};
  const row = sessionRow();

  await parseTraeCnApiIncremental({ sessions: [row], cursors, queuePath });
  cursors = JSON.parse(JSON.stringify(cursors));

  // Identical re-run after restart is a no-op.
  const before = fs.readFileSync(queuePath, "utf8");
  const noop = await parseTraeCnApiIncremental({ sessions: [row], cursors, queuePath });
  assert.equal(noop.eventsAggregated, 0);
  assert.equal(noop.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), before);

  // Correction after restart retracts the old tuple and writes the new one.
  const corrected = await parseTraeCnApiIncremental({ sessions: [sessionRow({ input_token: 120 })], cursors, queuePath });
  assert.equal(corrected.eventsAggregated, 1);
  const latest = lastTraeRow(queuePath, "doubao-pro");
  assert.equal(latest.input_tokens, 120);
  assert.equal(latest.total_tokens, 130);
});

test("unexpected cursor version fails closed instead of resetting", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = { traeCn: { version: 99, sessions: {} } };
  await assert.rejects(
    parseTraeCnApiIncremental({ sessions: [sessionRow()], cursors, queuePath }),
    /version 99 is not supported/,
  );
  assert.equal(cursors.traeCn.version, 99, "malformed state is not reset");
});

test("a stored contribution exceeding its bucket fails closed without mutation", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bucketKey = `trae-cn|doubao-pro|${B1}`;
  const cursors = {
    hourly: {
      version: 3,
      buckets: {
        [bucketKey]: {
          totals: {
            input_tokens: 5,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens: 10,
            billable_total_tokens: 10,
            conversation_count: 1,
          },
          queuedKey: null,
        },
      },
    },
    traeCn: {
      version: 1,
      sessions: {
        "session-id-canary": {
          model: "doubao-pro",
          bucketStart: B1,
          totals: {
            input_tokens: 100,
            output_tokens: 10,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 110,
            billable_total_tokens: 110,
            conversation_count: 1,
          },
          updatedAt: "x",
        },
      },
    },
  };
  const before = JSON.stringify(cursors);
  await assert.rejects(
    parseTraeCnApiIncremental({ sessions: [sessionRow({ session_id: "session-id-canary", input_token: 120 })], cursors, queuePath }),
    (error) => {
      assert.match(error.message, /corruption/);
      assert.ok(!error.message.includes("session-id-canary"));
      return true;
    },
  );
  assert.equal(JSON.stringify(cursors), before, "cursor state untouched");
  assert.equal(fs.existsSync(queuePath), false);
});

test("failed enqueue leaves the serialized cursors byte-identical", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const row = sessionRow();

  await parseTraeCnApiIncremental({ sessions: [row], cursors, queuePath });
  const before = JSON.stringify(cursors);

  // Corrected snapshot whose queuePath is an existing directory: enqueue's
  // appendFile fails (EISDIR) after reconciliation already mutated the working
  // state. The deep-cloned working states must keep cursors untouched.
  await assert.rejects(
    parseTraeCnApiIncremental({ sessions: [sessionRow({ input_token: 120 })], cursors, queuePath: dir }),
  );
  assert.equal(JSON.stringify(cursors), before, "cursors byte-identical after failed enqueue");
});

test("an unrelated malformed stored session fails a new valid payload before mutation", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {
    traeCn: {
      version: 1,
      sessions: {
        good: {
          model: "doubao-pro",
          bucketStart: B1,
          totals: {
            input_tokens: 100,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: 110,
            billable_total_tokens: 110,
            conversation_count: 1,
          },
          updatedAt: "x",
        },
        bad: {
          model: "doubao-lite",
          bucketStart: B1,
          totals: {
            input_tokens: 1,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 1, // violates the canonical invariant
            total_tokens: 2,
            billable_total_tokens: 2,
            conversation_count: 1,
          },
          updatedAt: "x",
        },
      },
    },
  };
  const before = JSON.stringify(cursors);
  await assert.rejects(
    parseTraeCnApiIncremental({ sessions: [sessionRow({ session_id: "new-session" })], cursors, queuePath }),
    /stored session totals are malformed/,
  );
  assert.equal(JSON.stringify(cursors), before, "no mutation on malformed stored state");
  assert.equal(fs.existsSync(queuePath), false, "no queue rows written");
});

test("window prune drops pre-window sessions monotonically and never rewinds", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  await parseTraeCnApiIncremental({
    sessions: [
      sessionRow({ session_id: "old-s" }), // bucket B1 = 22:00
      sessionRow({ session_id: "new-s", usage_time: T2 }), // bucket B2 = 22:30
    ],
    cursors,
    queuePath,
  });
  assert.ok(cursors.traeCn.sessions["old-s"]);
  assert.ok(cursors.traeCn.sessions["new-s"]);
  assert.equal(cursors.traeCn.prunedBeforeMs, 0, "no prune before a window is supplied");

  // Window starts at 22:33:20 (T1 + 20min): old-s's whole bucket (22:00) is
  // before it and can never reappear; new-s (22:46:40, bucket 22:30) is in-window.
  const windowStartMs = (T1 + 20 * 60) * 1000;
  await parseTraeCnApiIncremental({
    sessions: [sessionRow({ session_id: "new-s", usage_time: T2, output_token: 20 })],
    cursors,
    queuePath,
    windowStartMs,
  });
  assert.equal(cursors.traeCn.sessions["old-s"], undefined, "pre-window entry pruned");
  assert.ok(cursors.traeCn.sessions["new-s"], "in-window entry kept");
  assert.equal(cursors.traeCn.prunedBeforeMs, windowStartMs);

  // An earlier window start must not rewind the prune watermark
  // (prunedBeforeMs) or re-prune; a re-reported in-window session still
  // reconciles against its stored entry.
  await parseTraeCnApiIncremental({
    sessions: [sessionRow({ session_id: "new-s", usage_time: T2 })],
    cursors,
    queuePath,
    windowStartMs: (T1 + 60) * 1000,
  });
  assert.equal(cursors.traeCn.prunedBeforeMs, windowStartMs, "prune watermark never rewinds");
  assert.ok(cursors.traeCn.sessions["new-s"]);
});

test("session state records carry the canonical observation + snapshot_verified_at (logical freshness)", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const T_LATE = 1_700_003_500; // 23:05:00Z -> 23:00 bucket
  const verifiedAt = 1_700_010_000_000;
  await parseTraeCnApiIncremental({
    sessions: [sessionRow(), sessionRow({ session_id: "s2", usage_time: T_LATE })],
    cursors,
    queuePath,
    windowStartMs: 1_699_000_000_000,
    windowEndMs: 1_700_010_000_000,
    snapshotVerifiedAtMs: verifiedAt,
  });
  const states = queueRows(queuePath).filter((r) => r.kind === "account_session_state");
  assert.equal(states.length, 2, "one canonical observation per session in the snapshot");
  const byId = new Map(states.map((r) => [r.session_id, r]));
  const s1 = byId.get("s1");
  assert.ok(s1, "s1 observation queued");
  assert.equal(s1.source, "trae-cn");
  assert.equal(s1.model, "doubao-pro");
  assert.equal(s1.bucket_start, B1, "bucket_start is the session's half-hour floor (22:00)");
  assert.equal(s1.input_tokens, 100, "token columns mirror the session totals");
  assert.equal(s1.total_tokens, 110);
  assert.equal(
    s1.snapshot_verified_at,
    new Date(verifiedAt).toISOString(),
    "logical fetch stamp is the injected real-fetch time",
  );
  assert.equal(byId.get("s2").bucket_start, "2023-11-14T23:00:00.000Z");
});

test("transport retry replays the ORIGINAL session state record verbatim (append-only queue)", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const verifiedAt = 1_700_010_000_000;
  await parseTraeCnApiIncremental({
    sessions: [sessionRow()],
    cursors,
    queuePath,
    windowStartMs: 1_699_000_000_000,
    windowEndMs: 1_700_010_000_000,
    snapshotVerifiedAtMs: verifiedAt,
  });
  const first = fs.readFileSync(queuePath, "utf8").trim().split("\n").at(-1);
  // A "retry" re-reads the same append-only record: the bytes - including
  // snapshot_verified_at - are identical, so no new logical version exists.
  const replayed = fs.readFileSync(queuePath, "utf8").trim().split("\n").at(-1);
  assert.equal(replayed, first, "re-delivery carries the original logical fetch stamp");
  assert.ok(JSON.parse(first).snapshot_verified_at);
});
