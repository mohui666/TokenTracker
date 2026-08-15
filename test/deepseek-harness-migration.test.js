"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  migrateLegacyDeepseekHarnessSource,
  DSH_LEGACY_SOURCE_MIGRATION_KEY,
} = require("../src/commands/sync");

test("legacy DeepSeek Harness rows migrate to dsh and retract the old cloud keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-dsh-migration-"));
  const queuePath = path.join(dir, "queue.jsonl");
  const queueStatePath = path.join(dir, "queue.state.json");
  const hour = "2026-08-14T01:00:00Z";
  const legacy = {
    source: "deepseek",
    model: "deepseek-v4-flash",
    hour_start: hour,
    input_tokens: 70,
    output_tokens: 30,
    total_tokens: 100,
    conversation_count: 1,
  };
  const current = { ...legacy, source: "dsh", input_tokens: 84, output_tokens: 36, total_tokens: 120 };
  const codex = { ...legacy, source: "codex", model: "gpt-5", total_tokens: 9 };
  // Keep the legacy alias physically after the canonical row. The migration
  // must re-append the explicit dsh row so last-row-wins readers retain 120.
  await fs.writeFile(queuePath, [JSON.stringify(codex), JSON.stringify(current), JSON.stringify(legacy)].join("\n") + "\n");
  await fs.writeFile(queueStatePath, JSON.stringify({ offset: 999 }));
  const cursors = {};

  assert.equal(await migrateLegacyDeepseekHarnessSource({ cursors, queuePath, queueStatePath }), true);
  const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
  const legacyRows = rows.filter((row) => row.source === "deepseek");
  assert.ok(legacyRows.length > 0, "old cloud keys receive an explicit zero retraction");
  assert.ok(legacyRows.every((row) => row.total_tokens === 0));

  const dshRows = rows.filter((row) => row.source === "dsh" && row.model === current.model && row.hour_start === hour);
  assert.equal(dshRows.at(-1).total_tokens, 120, "the latest canonical row remains authoritative");
  const migratedLegacy = dshRows.find((row) => row.total_tokens === 100);
  assert.equal(migratedLegacy.billable_total_tokens, 100, "legacy billable totals default to total tokens");
  assert.equal(rows.filter((row) => row.source === "codex").length, 1, "unrelated sources stay intact");

  const state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
  assert.equal(state.offset, 0);
  assert.match(state.note, /deepseek_harness_source/);
  assert.equal(cursors.migrations[DSH_LEGACY_SOURCE_MIGRATION_KEY].status, "applied");

  const snapshot = await fs.readFile(queuePath, "utf8");
  assert.equal(await migrateLegacyDeepseekHarnessSource({ cursors, queuePath, queueStatePath }), false);
  assert.equal(await fs.readFile(queuePath, "utf8"), snapshot, "migration is idempotent");
  await fs.rm(dir, { recursive: true, force: true });
});
