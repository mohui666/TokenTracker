"use strict";

// OpenCode v2 (the `opencode2` beta) keeps the same data directory but rewrote
// the storage layer: assistant messages moved from the `message` table to
// `session_message` (role is now a `type` column), the model became a nested
// `model: { id, providerID }` object, and the project directory lives on
// `session_v2.directory` instead of the message's own `path.cwd`. These tests
// pin the reader/parser contract for BOTH generations sharing one parser, all
// aggregating under source="opencode".
//
// Four real database shapes are covered:
//   A  pure v1:        `message`(data) + `session_message`(empty) [+ `session`]
//   B  beta-17887:     `session_message`(data) + `session_v2`
//   C  upstream v2:    `session_message`(data) + `session`
//   D  transitional:   `message`(old data) + `session_message`(new data)
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Probe node:sqlite availability first; only lazy-load the write helper when
// the runtime supports it (fixes the skip-logic bypass where an unconditional
// top-level require threw before the skip could take effect).
let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (_e) {
  sqlite = null;
}

const { runSql } = sqlite ? require("./helpers/sqlite-write") : { runSql: null };
const {
  readOpencodeDbMessages,
  parseOpencodeDbIncremental,
} = require("../src/lib/rollout");

// --- fixture helpers --------------------------------------------------------

function buildMessageTableSql() {
  return (
    "CREATE TABLE message (" +
    " id TEXT PRIMARY KEY," +
    " session_id TEXT NOT NULL," +
    " time_created INTEGER NOT NULL," +
    " time_updated INTEGER NOT NULL," +
    " data TEXT NOT NULL" +
    ")"
  );
}

function buildSessionMessageTableSql() {
  return (
    "CREATE TABLE session_message (" +
    " id TEXT PRIMARY KEY," +
    " session_id TEXT NOT NULL," +
    " type TEXT NOT NULL," +
    " seq INTEGER NOT NULL," +
    " time_created INTEGER NOT NULL," +
    " time_updated INTEGER NOT NULL," +
    " data TEXT NOT NULL" +
    ")"
  );
}

function buildSessionV2TableSql() {
  return "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL)";
}

function buildSessionTableSql() {
  return "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)";
}

// Build a fixture DB of the given type. `messages` always carries v1-shaped
// rows (flat providerID/role); `v2Messages` carries v2-shaped rows (nested
// model/type). The FK target for session_message must be real:
//   A/C → session(id),  B → session_v2(id).
function buildFixtureDb(dbPath, { type, messages = [], v2Messages = [], sessions = [] } = {}) {
  const statements = [];
  const hasMessageTable = type === "A" || type === "D";
  const hasSessionMessageTable = type === "B" || type === "C" || type === "D";
  const sessionTableName = type === "B" ? "session_v2" : "session";

  if (hasMessageTable) statements.push(buildMessageTableSql());
  if (hasSessionMessageTable) statements.push(buildSessionMessageTableSql());
  if (sessions.length > 0) {
    if (sessionTableName === "session_v2") statements.push(buildSessionV2TableSql());
    else statements.push(buildSessionTableSql());
  }
  runSql(dbPath, statements.join(";\n") + ";");

  const db = new sqlite.DatabaseSync(dbPath);
  try {
    for (const s of sessions) {
      db.prepare(`INSERT INTO ${sessionTableName} (id, directory) VALUES (?, ?)`).run(s.id, s.directory);
    }
    for (const m of messages) {
      const createdMs = m.time?.created ?? 0;
      const updatedMs = m.time?.completed ?? createdMs;
      db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ).run(m.id, m.sessionID, createdMs, updatedMs, JSON.stringify(m));
    }
    for (const m of v2Messages) {
      const createdMs = m.time?.created ?? 0;
      const updatedMs = m.time?.completed ?? createdMs;
      db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(m.id, m.sessionID, m.type || "assistant", m.seq ?? 0, createdMs, updatedMs, JSON.stringify(m));
    }
  } finally {
    db.close();
  }
}

// An opencode2-shaped assistant message: nested model object, no top-level
// modelID/providerID, tokens/cache identical to v1.
function v2AssistantMessage({ id, sessionID, modelId = "x-preview-f-free", providerID = "opencode", input = 100, output = 20, cached = 0, cacheWrite = 0, reasoning = 0 }) {
  return {
    id,
    sessionID,
    type: "assistant",
    agent: "build",
    model: { id: modelId, providerID },
    time: { created: Date.parse("2026-08-01T10:00:00.000Z"), completed: Date.parse("2026-08-01T10:00:05.000Z") },
    tokens: { input, output, reasoning, cache: { read: cached, write: cacheWrite } },
  };
}

// A v1-shaped assistant message: flat modelID/providerID strings + role key.
function v1AssistantMessage({ id, sessionID, modelID = "claude-sonnet-4", providerID = "anthropic", input = 100, output = 20, cached = 0, cacheWrite = 0 }) {
  return {
    id,
    sessionID,
    role: "assistant",
    modelID,
    providerID,
    time: { created: Date.parse("2026-08-01T10:00:00.000Z"), completed: Date.parse("2026-08-01T10:00:05.000Z") },
    tokens: { input, output, reasoning: 0, cache: { read: cached, write: cacheWrite } },
  };
}

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode2-"));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function readQueue(queuePath) {
  const text = await fs.readFile(queuePath, "utf8").catch(() => "");
  if (!text.trim()) return [];
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function queueTotals(queuePath) {
  const rows = await readQueue(queuePath);
  const latest = new Map();
  for (const row of rows) latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  for (const row of latest.values()) {
    for (const key of Object.keys(totals)) totals[key] += row[key] || 0;
  }
  return { rows, totals };
}

// --- tests ------------------------------------------------------------------

const skipTests = !sqlite
  ? () => {
      console.log("SKIP: node:sqlite unavailable — all opencode2-parser tests skipped");
    }
  : null;

// When sqlite is unavailable, the describe blocks still need to register
// without throwing. node:test allows a conditional describe via function
// evaluation, but the simplest approach is to guard the test() calls.

if (sqlite) {
  test("readOpencodeDbMessages reads the opencode2 session_message schema (type B: session_v2)", async () => {
    await withTmp(async (tmp) => {
      const dbPath = path.join(tmp, "opencode.db");
      buildFixtureDb(dbPath, {
        type: "B",
        sessions: [{ id: "ses_v2_1", directory: "/Users/alice/dev/widgets" }],
        v2Messages: [
          v2AssistantMessage({ id: "msg_a", sessionID: "ses_v2_1" }),
          // Some OpenCode forks wrote a plain string into `model` — the reader
          // must not care; model resolution happens downstream either way.
          { ...v2AssistantMessage({ id: "msg_s", sessionID: "ses_v2_1" }), model: "string-form-model" },
          // user turns and token-less assistants never carry usage
          { ...v2AssistantMessage({ id: "msg_u", sessionID: "ses_v2_1" }), type: "user" },
          { ...v2AssistantMessage({ id: "msg_e", sessionID: "ses_v2_1" }), tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        ],
      });

      const rows = readOpencodeDbMessages(dbPath);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].id, "msg_a");
      assert.equal(rows[0].sessionID, "ses_v2_1");
      // Nested model object survives untouched…
      assert.deepEqual(rows[0].data.model, { id: "x-preview-f-free", providerID: "opencode" });
      // …and the session's directory is restored as the per-message path.cwd so
      // project attribution works without any downstream change.
      assert.equal(rows[0].data.path.cwd, "/Users/alice/dev/widgets");
    });
  });

  test("readOpencodeDbMessages still reads the v1 message table unchanged (type A)", async () => {
    await withTmp(async (tmp) => {
      const dbPath = path.join(tmp, "opencode.db");
      buildFixtureDb(dbPath, {
        type: "A",
        messages: [v1AssistantMessage({ id: "msg_v1", sessionID: "ses_v1" })],
      });

      const rows = readOpencodeDbMessages(dbPath);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, "msg_v1");
      assert.equal(rows[0].data.modelID, "claude-sonnet-4");
      assert.equal(rows[0].data.providerID, "anthropic");
    });
  });

  test("type C (upstream v2 with session table): directory injected from session.directory", async () => {
    await withTmp(async (tmp) => {
      const dbPath = path.join(tmp, "opencode.db");
      buildFixtureDb(dbPath, {
        type: "C",
        sessions: [{ id: "ses_c", directory: "/Users/bob/dev/phones" }],
        v2Messages: [v2AssistantMessage({ id: "msg_c", sessionID: "ses_c" })],
      });

      const rows = readOpencodeDbMessages(dbPath);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].data.path.cwd, "/Users/bob/dev/phones");
    });
  });

  test("type A: no v2 data SQL is issued (empty session_message → probe.hasRows=false)", async () => {
    await withTmp(async (tmp) => {
      const dbPath = path.join(tmp, "opencode.db");
      // Type A: message table has data, session_message is empty (table exists
      // but has no rows). The probe must report hasRows=false, so the v2 query
      // (which would JOIN against a non-existent session table) is never fired.
      buildFixtureDb(dbPath, {
        type: "A",
        messages: [v1AssistantMessage({ id: "msg_a1", sessionID: "ses_a1" })],
      });

      // Count SQL calls by wrapping readSqliteJsonRows via sqliteOptions.
      const sqlCalls = [];
      const sqliteOptions = {
        requireFn(name) {
          assert.equal(name, "node:sqlite");
          return {
            DatabaseSync: class FakeDatabaseSync {
              prepare(sql) {
                sqlCalls.push(sql);
                if (sql.includes("sqlite_master")) {
                  // The combined probe: hasRows=0 (empty), sessionTable='session'
                  return { all: () => [{ hasRows: 0, sessionTable: "session" }] };
                }
                if (/FROM message /.test(sql)) {
                  return {
                    all: () => [
                      {
                        id: "msg_a1",
                        session_id: "ses_a1",
                        time_updated: Date.parse("2026-08-01T10:00:05.000Z"),
                        data: JSON.stringify(v1AssistantMessage({ id: "msg_a1", sessionID: "ses_a1" })),
                      },
                    ],
                  };
                }
                throw new Error(`unexpected sql: ${sql}`);
              }
              close() {}
            },
          };
        },
        execFileSync() {
          throw new Error("spawn sqlite3 ENOENT");
        },
        stderr: { write() {} },
      };

      const rows = readOpencodeDbMessages(dbPath, sqliteOptions);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, "msg_a1");
      // The v2 data query (which aliases session_message as sm) must NOT have
      // been issued. The probe itself references session_message in a subquery
      // — that is allowed and counted separately.
      const v2DataQueries = sqlCalls.filter((sql) => sql.includes("FROM session_message sm"));
      assert.equal(v2DataQueries.length, 0, "type A must not fire any v2 data query");
    });
  });

  test("type D (transitional): union of v1 + v2 rows, cross-table dedup via parseOpencodeDbIncremental", async () => {
    await withTmp(async (tmp) => {
      const queuePath = path.join(tmp, "queue.jsonl");
      const cursors = { version: 1, files: {}, updatedAt: null };

      // Two tables each carry data. Two rows share sessionID|messageID across
      // tables — the parser must dedup them (cursor key + #426 fingerprint).
      const v1Msg = v1AssistantMessage({ id: "msg_dup", sessionID: "ses_dup", input: 100, output: 20 });
      const v2Msg = v2AssistantMessage({ id: "msg_dup", sessionID: "ses_dup", input: 100, output: 20 });
      const v1Only = v1AssistantMessage({ id: "msg_v1only", sessionID: "ses_v1only", input: 50, output: 10 });
      const v2Only = v2AssistantMessage({ id: "msg_v2only", sessionID: "ses_v2only", input: 60, output: 15 });

      const dbPath = path.join(tmp, "opencode.db");
      buildFixtureDb(dbPath, {
        type: "D",
        messages: [v1Msg, v1Only],
        v2Messages: [v2Msg, v2Only],
      });

      const dbMessages = readOpencodeDbMessages(dbPath);
      // 4 raw rows: 2 v1 + 2 v2 (the duplicate pair is still present at the
      // reader level — dedup happens downstream in parseOpencodeDbIncremental).
      assert.equal(dbMessages.length, 4);

      const res = await parseOpencodeDbIncremental({
        dbMessages,
        cursors,
        queuePath,
        source: "opencode",
        cursorKey: "opencode",
      });
      // 3 unique messages after dedup: msg_dup (deduped to 1), msg_v1only, msg_v2only
      assert.equal(res.eventsAggregated, 3);

      const { totals } = await queueTotals(queuePath);
      assert.equal(totals.input_tokens, 210); // 100 + 50 + 60
      assert.equal(totals.output_tokens, 45);  // 20 + 10 + 15
    });
  });

  test("probe failure degrades to v1-only", async () => {
    await withTmp(async (tmp) => {
      const dbPath = path.join(tmp, "opencode.db");
      await fs.writeFile(dbPath, "", "utf8");
      // Fake reader where the probe itself throws (simulating no session_message
      // table at all). The code must treat this as v1-only and still try the
      // v1 query.
      const sqliteOptions = {
        execFileSync() {
          throw new Error("spawn sqlite3 ENOENT");
        },
        requireFn(name) {
          assert.equal(name, "node:sqlite");
          return {
            DatabaseSync: class FakeDatabaseSync {
              prepare(sql) {
                if (sql.includes("sqlite_master")) {
                  throw new Error("no such table: session_message");
                }
                if (/FROM message /.test(sql)) {
                  return {
                    all: () => [
                      {
                        id: "msg_v1",
                        session_id: "ses_v1",
                        time_updated: Date.parse("2026-08-01T10:00:05.000Z"),
                        data: JSON.stringify(v1AssistantMessage({ id: "msg_v1", sessionID: "ses_v1" })),
                      },
                    ],
                  };
                }
                throw new Error(`unexpected sql: ${sql}`);
              }
              close() {}
            },
          };
        },
        stderr: { write() {} },
      };

      const rows = readOpencodeDbMessages(dbPath, sqliteOptions);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, "msg_v1");
    });
  });

  test("parseOpencodeDbIncremental buckets opencode2 messages under source=opencode with the nested model id", async () => {
    await withTmp(async (tmp) => {
      const queuePath = path.join(tmp, "queue.jsonl");
      const cursors = { version: 1, files: {}, updatedAt: null };

      const res = await parseOpencodeDbIncremental({
        dbMessages: [
          {
            id: "msg_a",
            sessionID: "ses_v2_1",
            data: v2AssistantMessage({ id: "msg_a", sessionID: "ses_v2_1", input: 5644, output: 61, reasoning: 8, cached: 3136 }),
          },
          // String-form `model` (fork variant) must resolve through the same helper.
          {
            id: "msg_s",
            sessionID: "ses_v2_2",
            data: { ...v2AssistantMessage({ id: "msg_s", sessionID: "ses_v2_2", input: 10, output: 5 }), model: "string-form-model" },
          },
        ],
        cursors,
        queuePath,
        source: "opencode",
        cursorKey: "opencode",
      });

      assert.equal(res.eventsAggregated, 2);
      const { rows, totals } = await queueTotals(queuePath);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.source === "opencode"));
      assert.ok(rows.some((r) => r.model === "x-preview-f-free"));
      assert.ok(rows.some((r) => r.model === "string-form-model"));
      assert.equal(totals.input_tokens, 5654);
      assert.equal(totals.output_tokens, 66);
      assert.equal(totals.cached_input_tokens, 3136);
      assert.equal(totals.reasoning_output_tokens, 8);

      // Idempotent: replaying the same snapshot aggregates nothing new.
      const again = await parseOpencodeDbIncremental({
        dbMessages: [
          {
            id: "msg_a",
            sessionID: "ses_v2_1",
            data: v2AssistantMessage({ id: "msg_a", sessionID: "ses_v2_1", input: 5644, output: 61, reasoning: 8, cached: 3136 }),
          },
        ],
        cursors,
        queuePath,
        source: "opencode",
        cursorKey: "opencode",
      });
      assert.equal(again.eventsAggregated, 0);
    });
  });

  test("opencode2 fork copies are deduped via the fingerprint built from the nested model", async () => {
    await withTmp(async (tmp) => {
      const queuePath = path.join(tmp, "queue.jsonl");
      const cursors = { version: 1, files: {}, updatedAt: null };

      // Session.fork re-materialises the parent turn under a new id/session with
      // an identical payload — exactly the #426 shape, now in v2 clothing.
      const wrap = (m) => ({ id: m.id, sessionID: m.sessionID, data: m });
      const parent = v2AssistantMessage({ id: "msg_p", sessionID: "ses_parent", input: 5000, output: 100 });
      const forkCopy = v2AssistantMessage({ id: "msg_f", sessionID: "ses_fork", input: 5000, output: 100 });
      const genuineContinuation = v2AssistantMessage({ id: "msg_g", sessionID: "ses_fork", input: 42, output: 7 });

      const res = await parseOpencodeDbIncremental({
        dbMessages: [wrap(parent), wrap(forkCopy), wrap(genuineContinuation)],
        cursors,
        queuePath,
        source: "opencode",
        cursorKey: "opencode",
      });
      assert.equal(res.eventsAggregated, 2); // parent + continuation; copy suppressed

      const { totals } = await queueTotals(queuePath);
      assert.equal(totals.input_tokens, 5042);
      assert.equal(totals.output_tokens, 107);
    });
  });

  test("end to end: opencode2 fixture DB flows through reader + parser with project attribution (type C)", async () => {
    await withTmp(async (tmp) => {
      // Minimal git repo the project resolver can walk into from the session's
      // recorded directory.
      const repoRoot = path.join(tmp, "widgets");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".git", "config"),
        '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
        "utf8",
      );

      const dbPath = path.join(tmp, "opencode.db");
      buildFixtureDb(dbPath, {
        type: "C",
        sessions: [{ id: "ses_repo", directory: repoRoot }],
        v2Messages: [v2AssistantMessage({ id: "msg_repo", sessionID: "ses_repo", input: 44322, output: 9905 })],
      });

      const queuePath = path.join(tmp, "queue.jsonl");
      const projectQueuePath = path.join(tmp, "project.queue.jsonl");
      const cursors = { version: 1, files: {}, updatedAt: null };

      const dbMessages = readOpencodeDbMessages(dbPath);
      const res = await parseOpencodeDbIncremental({
        dbMessages,
        dbPath,
        cursors,
        queuePath,
        projectQueuePath,
        source: "opencode",
        cursorKey: "opencode",
      });

      assert.equal(res.eventsAggregated, 1);
      const { rows } = await queueTotals(queuePath);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].model, "x-preview-f-free");

      const projectRows = await readQueue(projectQueuePath);
      assert.equal(projectRows.length, 1);
      assert.equal(projectRows[0].project_key, "acme/widgets");
    });
  });

  test("string-form model in v1 message table resolves correctly", async () => {
    await withTmp(async (tmp) => {
      const dbPath = path.join(tmp, "opencode.db");
      buildFixtureDb(dbPath, {
        type: "A",
        messages: [
          { ...v1AssistantMessage({ id: "msg_str", sessionID: "ses_str" }), modelID: "string-form-model" },
        ],
      });

      const rows = readOpencodeDbMessages(dbPath);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].data.modelID, "string-form-model");
    });
  });

  // The mimo/zcode discriminators resolve the provider via
  // opencodeMessageProvider(): flat providerID on v1 rows, model.providerID on
  // v2 rows. Pin the nested branch so a future fork upgrade cannot silently
  // zero out these sources (zcode's empty-provider guard drops everything).
  test("mimo/zcode discriminators resolve nested model.providerID on v2 rows", async () => {
    await withTmp(async (tmp) => {
      const dbPath = path.join(tmp, "opencode.db");
      buildFixtureDb(dbPath, {
        type: "B",
        sessions: [{ id: "ses_m", directory: "/tmp/x" }],
        v2Messages: [
          { ...v2AssistantMessage({ id: "msg_m", sessionID: "ses_m", input: 10, output: 5 }), model: { id: "mimo-v2", providerID: "mimo" } },
          { ...v2AssistantMessage({ id: "msg_c", sessionID: "ses_m", input: 7, output: 3 }), model: { id: "claude-x", providerID: "anthropic" } },
        ],
      });
      const { readMimoDbMessages } = require("../src/lib/rollout");
      const mimoRows = readMimoDbMessages(dbPath);
      assert.equal(mimoRows.length, 1);
      assert.equal(mimoRows[0].data.model.providerID, "mimo");

      buildFixtureDb(path.join(tmp, "zcode.db"), {
        type: "B",
        sessions: [{ id: "ses_z", directory: "/tmp/x" }],
        v2Messages: [
          { ...v2AssistantMessage({ id: "msg_z", sessionID: "ses_z", input: 9, output: 2 }), model: { id: "glm-5", providerID: "builtin:zai" } },
          { ...v2AssistantMessage({ id: "msg_o", sessionID: "ses_z", input: 6, output: 4 }), model: { id: "gpt-x", providerID: "openai" } },
        ],
      });
      const { readZcodeDbMessages } = require("../src/lib/rollout");
      const zcodeRows = readZcodeDbMessages(path.join(tmp, "zcode.db"));
      assert.equal(zcodeRows.length, 1);
      assert.equal(zcodeRows[0].data.model.providerID, "builtin:zai");
    });
  });
} else {
  // node:sqlite unavailable — skip with a visible message.
  test("SKIP: node:sqlite unavailable", () => {
    console.log("SKIP: node:sqlite unavailable — all opencode2-parser tests skipped");
  });
}