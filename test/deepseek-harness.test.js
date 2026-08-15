/**
 * DeepSeek Harness (dsh) parser test.
 *
 * The harness persists each session as an append-only JSONL log under
 * `$DSH_HOME/sessions/<project-key>/<session-id>/session.jsonl[.zstd]`. This
 * suite builds synthetic trees under a tempdir and verifies:
 *   - `resolveDshHome` precedence (TOKENTRACKER_DSH_HOME > DSH_HOME > ~/.dsh)
 *   - `resolveDshSessionFiles` finds both plaintext and zstd artifacts
 *   - `readDshSessionText` reassembles a concatenated-frame zstd container
 *     frame-by-frame with a bounded aggregate output
 *   - usage mapping (disjoint input/cache_read/cache_write/reasoning/output)
 *   - model from `assistant/message.data.message.source.model` with a
 *     `request/header` fallback
 *   - per-file `seq` watermark dedup: a second run adds nothing; an appended
 *     event adds only the delta
 *
 * No real harness install is required: fixtures are written under a tempdir
 * and passed directly to the parser.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");

const {
  resolveDshHome,
  resolveDshSessionFiles,
  readDshSessionText,
  normalizeDshModelName,
  dshUsageToTotals,
  extractDshSessionUsage,
  parseDshIncremental,
} = require("../src/lib/rollout");

async function zstdCompress(data) {
  if (typeof zlib.zstdCompressSync === "function") {
    return zlib.zstdCompressSync(data);
  }
  return Buffer.from(await require("@mongodb-js/zstd").compress(data));
}

const T0 = new Date("2026-05-01T12:00:00Z").getTime();

function headerLine(id = "sess-1") {
  return JSON.stringify({
    type: "session",
    version: 0,
    id,
    createdAt: T0,
    cwd: "/proj",
  });
}

function requestHeaderLine(seq, model = "deepseek-v4-pro") {
  return JSON.stringify({
    type: "request/header",
    seq,
    time: T0,
    data: { header: { config: { provider: "deepseek-official", model } } },
  });
}

function assistantLine(seq, usage, { model, time = T0 } = {}) {
  const source = model
    ? { kind: "model", provider: "deepseek-official", model }
    : undefined;
  return JSON.stringify({
    type: "assistant/message",
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [], source, id: `m-${seq}` },
      usage,
    },
  });
}

async function writeSessionLog(dir, name, lines, { zstd = false } = {}) {
  const filePath = path.join(dir, name);
  const text = lines.join("\n") + "\n";
  let data;
  if (zstd) {
    // Split across two independent frames so the concatenated-frame decoder is
    // exercised; the frame boundary is arbitrary (all fixture bytes are ASCII).
    data = Buffer.concat([
      await zstdCompress(Buffer.from(text.slice(0, 60))),
      await zstdCompress(Buffer.from(text.slice(60))),
    ]);
  } else {
    data = Buffer.from(text);
  }
  fs.writeFileSync(filePath, data);
  return filePath;
}

async function makeTree({ compression = "zstd", lines } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-test-"));
  const sessionsRoot = path.join(dir, ".dsh", "sessions");
  const projectDir = path.join(sessionsRoot, "--proj--");
  const sessionDir = path.join(projectDir, "sess-1");
  fs.mkdirSync(sessionDir, { recursive: true });
  const name = compression === "zstd" ? "session.jsonl.zstd" : "session.jsonl";
  const logPath = await writeSessionLog(sessionDir, name, lines, { zstd: compression === "zstd" });
  return { dir, dshHome: path.join(dir, ".dsh"), sessionDir, sessionsRoot, logPath };
}

test("resolveDshHome honors TOKENTRACKER_DSH_HOME, DSH_HOME, then default", () => {
  assert.equal(resolveDshHome({ TOKENTRACKER_DSH_HOME: "/tmp/a" }), path.resolve("/tmp/a"));
  assert.equal(resolveDshHome({ TOKENTRACKER_DSH_HOME: "  ", DSH_HOME: "/tmp/b" }), path.resolve("/tmp/b"));
  assert.equal(resolveDshHome({ DSH_HOME: "/tmp/c" }), path.resolve("/tmp/c"));
  assert.equal(resolveDshHome({}), path.join(os.homedir(), ".dsh"));
});

test("normalizeDshModelName drops provider-qualified prefixes", () => {
  assert.equal(normalizeDshModelName("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(normalizeDshModelName("deepseek/deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(normalizeDshModelName("  "), null);
  assert.equal(normalizeDshModelName(null), null);
  assert.equal(normalizeDshModelName("/"), null);
});

test("dshUsageToTotals maps disjoint columns 1:1 and rejects all-zero", () => {
  assert.deepEqual(
    dshUsageToTotals({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 7,
    }),
    {
      input_tokens: 100,
      cached_input_tokens: 10,
      cache_creation_input_tokens: 5,
      output_tokens: 50,
      reasoning_output_tokens: 7,
      total_tokens: 172,
      conversation_count: 1,
    },
  );
  assert.equal(dshUsageToTotals({ inputTokens: 0, outputTokens: 0 }), null);
  assert.equal(dshUsageToTotals(null), null);
});

test("extractDshSessionUsage parses header, model source, header fallback, watermark", () => {
  const text = [
    headerLine("sess-1"),
    requestHeaderLine(0, "deepseek-v4-flash"),
    assistantLine(1, { inputTokens: 10, outputTokens: 5 }),
    // message.source carries the model and overrides the header model.
    assistantLine(2, { inputTokens: 20, outputTokens: 5 }, { model: "deepseek-v4-pro" }),
    // all-zero usage is dropped.
    assistantLine(3, { inputTokens: 0, outputTokens: 0 }, { model: "deepseek-v4-pro" }),
  ].join("\n");

  const parsed = extractDshSessionUsage(text, -1);
  assert.equal(parsed.sessionId, "sess-1");
  assert.equal(parsed.maxSeq, 3);
  assert.equal(parsed.deltas.length, 2);
  // seq 1 used the request/header fallback model.
  assert.equal(parsed.deltas[0].model, "deepseek-v4-flash");
  assert.equal(parsed.deltas[0].totals.total_tokens, 15);
  // seq 2 used message.source.model.
  assert.equal(parsed.deltas[1].model, "deepseek-v4-pro");
  assert.equal(parsed.deltas[1].totals.total_tokens, 25);

  // A watermark at seq 1 skips seq <= 1 and only returns seq 2.
  const tail = extractDshSessionUsage(text, 1);
  assert.equal(tail.deltas.length, 1);
  assert.equal(tail.deltas[0].totals.total_tokens, 25);
});

test("extractDshSessionUsage never materializes assistant content", () => {
  const secret = "SECRET_PROMPT_MUST_NOT_BE_PARSED";
  const line = JSON.stringify({
    type: "assistant/message",
    seq: 1,
    time: T0,
    data: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: secret }],
        source: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      },
      usage: { inputTokens: 4, outputTokens: 2 },
    },
  });
  const originalParse = JSON.parse;
  let leaked = false;
  JSON.parse = function privacyGuard(value, ...args) {
    if (String(value).includes(secret)) leaked = true;
    return originalParse.call(this, value, ...args);
  };
  try {
    const parsed = extractDshSessionUsage(`${headerLine()}\n${line}\n`, -1);
    assert.equal(parsed.deltas.length, 1);
    assert.equal(parsed.deltas[0].totals.total_tokens, 6);
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(leaked, false, "message content was passed to JSON.parse");
});

test("readDshSessionText reassembles concatenated-frame zstd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zstd-"));
  const lines = [headerLine(), assistantLine(1, { inputTokens: 1, outputTokens: 1 })];
  const full = lines.join("\n") + "\n";
  const f1 = await zstdCompress(Buffer.from(full.slice(0, 80)));
  const f2 = await zstdCompress(Buffer.from(full.slice(80)));
  const p = path.join(dir, "session.jsonl.zstd");
  fs.writeFileSync(p, Buffer.concat([f1, f2]));

  const text = await readDshSessionText(p);
  assert.equal(text, full, "both frames must be reassembled");

  await assert.rejects(
    readDshSessionText(p, { maxOutputBytes: Buffer.byteLength(full) - 1 }),
    /decompressed session log exceeds/i,
    "declared frame sizes must be rejected before unbounded decompression",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveDshSessionFiles only accepts exact project/session transcript leaves", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-files-"));
  const root = path.join(dir, ".dsh", "sessions");
  fs.mkdirSync(path.join(root, "--a--", "s1"), { recursive: true });
  fs.mkdirSync(path.join(root, "--a--", "s2"), { recursive: true });
  fs.mkdirSync(path.join(root, "--a--", "s3", "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "--a--", "s4"), { recursive: true });
  fs.writeFileSync(path.join(root, "--a--", "s1", "session.jsonl"), "x\n");
  fs.writeFileSync(path.join(root, "--a--", "s2", "session.jsonl.zstd"), "y\n");
  fs.writeFileSync(path.join(root, "--a--", "s2", "settings.yaml"), "ignore\n");
  fs.writeFileSync(path.join(root, "session.jsonl"), "wrong depth\n");
  fs.writeFileSync(path.join(root, "--a--", "session.jsonl"), "wrong depth\n");
  fs.writeFileSync(path.join(root, "--a--", "s3", "nested", "session.jsonl"), "wrong depth\n");
  const staleRaw = path.join(root, "--a--", "s4", "session.jsonl");
  const activeZstd = path.join(root, "--a--", "s4", "session.jsonl.zstd");
  fs.writeFileSync(staleRaw, "stale encoding\n");
  fs.writeFileSync(activeZstd, "active encoding\n");
  fs.utimesSync(staleRaw, new Date(T0), new Date(T0));
  fs.utimesSync(activeZstd, new Date(T0 + 1000), new Date(T0 + 1000));

  const files = await resolveDshSessionFiles({ TOKENTRACKER_DSH_HOME: path.join(dir, ".dsh") });
  assert.deepEqual(files, [
    path.join(root, "--a--", "s1", "session.jsonl"),
    path.join(root, "--a--", "s2", "session.jsonl.zstd"),
    activeZstd,
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseDshIncremental writes queue rows, dedups on rerun, and adds appended delta", async () => {
  const { dir, logPath } = await makeTree({
    lines: [
      headerLine("sess-1"),
      requestHeaderLine(0),
      assistantLine(1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 7 }),
      assistantLine(2, { inputTokens: 20, outputTokens: 5 }, { time: T0 + 40 * 60 * 1000 }),
    ],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  const res1 = await parseDshIncremental({ sessionFiles: [logPath], cursors, queuePath });
  assert.equal(res1.eventsAggregated, 2);

  const rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const dshRows = rows.filter((r) => r.source === "dsh");
  assert.equal(dshRows.length, 2, "two distinct half-hour buckets");
  assert.ok(dshRows.every((r) => r.model === "deepseek-v4-pro"));
  const first = dshRows.find((r) => r.total_tokens === 172);
  assert.ok(first);
  assert.equal(first.input_tokens, 100);
  assert.equal(first.output_tokens, 50);
  assert.equal(first.cached_input_tokens, 10);
  assert.equal(first.cache_creation_input_tokens, 5);
  assert.equal(first.reasoning_output_tokens, 7);
  assert.equal(first.conversation_count, 1);

  // Second run: file identity is unchanged, nothing new is parsed or queued.
  const res2 = await parseDshIncremental({ sessionFiles: [logPath], cursors, queuePath });
  assert.equal(res2.eventsAggregated, 0, "no delta on unchanged rerun");
  const rowsAfter2 = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean).length;
  assert.equal(rowsAfter2, rows.length, "no new rows on unchanged rerun");

  // Append a third event to the same file; only the new seq contributes.
  const existing = await readDshSessionText(logPath);
  const grown = existing + assistantLine(3, { inputTokens: 300, outputTokens: 30 }, { time: T0 + 80 * 60 * 1000 }) + "\n";
  fs.writeFileSync(logPath, Buffer.concat([
    await zstdCompress(Buffer.from(grown.slice(0, 60))),
    await zstdCompress(Buffer.from(grown.slice(60))),
  ]));

  const res3 = await parseDshIncremental({ sessionFiles: [logPath], cursors, queuePath });
  assert.equal(res3.eventsAggregated, 1, "only the appended event is counted");
  const rows3 = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const dshTokens = rows3.filter((r) => r.source === "dsh").reduce((s, r) => s + r.total_tokens, 0);
  assert.equal(dshTokens, 172 + 25 + 330, "no re-count of the seed events");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseDshIncremental accepts a replacement session whose seq restarts", async () => {
  const { dir, logPath } = await makeTree({
    compression: "none",
    lines: [
      headerLine("sess-old"),
      requestHeaderLine(0),
      assistantLine(1, { inputTokens: 100, outputTokens: 50 }),
      assistantLine(2, { inputTokens: 20, outputTokens: 5 }),
    ],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  const first = await parseDshIncremental({ sessionFiles: [logPath], cursors, queuePath });
  assert.equal(first.eventsAggregated, 2);

  await writeSessionLog(path.dirname(logPath), path.basename(logPath), [
    headerLine("sess-new"),
    requestHeaderLine(0, "deepseek-v4-flash"),
    assistantLine(1, { inputTokens: 7, outputTokens: 3 }),
  ]);

  const second = await parseDshIncremental({ sessionFiles: [logPath], cursors, queuePath });
  assert.equal(second.eventsAggregated, 1, "new session identity resets the seq watermark");
  assert.equal(cursors.dsh.files[logPath].sessionId, "sess-new");

  const rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").map(JSON.parse);
  const total = rows.filter((row) => row.source === "dsh").reduce((sum, row) => sum + row.total_tokens, 0);
  assert.equal(total, 150 + 25 + 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseDshIncremental isolates corrupt logs and prunes deleted-session cursors", async () => {
  const { dir, sessionDir, logPath } = await makeTree({
    compression: "none",
    lines: [
      headerLine("sess-good"),
      requestHeaderLine(0),
      assistantLine(1, { inputTokens: 8, outputTokens: 2 }),
    ],
  });
  const corruptDir = path.join(path.dirname(sessionDir), "sess-corrupt");
  fs.mkdirSync(corruptDir, { recursive: true });
  const corruptPath = path.join(corruptDir, "session.jsonl.zstd");
  fs.writeFileSync(corruptPath, "not-a-zstd-frame");
  const deletedPath = path.join(path.dirname(sessionDir), "sess-deleted", "session.jsonl");
  const cursors = {
    dsh: {
      files: {
        [deletedPath]: { inode: 1, size: 10, mtimeMs: 1, lastSeq: 9 },
      },
    },
  };

  const result = await parseDshIncremental({
    sessionFiles: [corruptPath, logPath],
    cursors,
    queuePath: path.join(dir, "queue.jsonl"),
  });

  assert.equal(result.recordsProcessed, 1);
  assert.equal(result.eventsAggregated, 1, "healthy sessions still aggregate");
  assert.ok(cursors.dsh.files[logPath]);
  assert.equal(cursors.dsh.files[corruptPath], undefined, "failed logs retry on a later sync");
  assert.equal(cursors.dsh.files[deletedPath], undefined, "deleted sessions do not leak cursor state");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseDshIncremental is a no-op with no files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-empty-"));
  const res = await parseDshIncremental({
    sessionFiles: [],
    cursors: {},
    queuePath: path.join(dir, "queue.jsonl"),
  });
  assert.equal(res.recordsProcessed, 0);
  assert.equal(res.eventsAggregated, 0);
  assert.equal(res.bucketsQueued, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
