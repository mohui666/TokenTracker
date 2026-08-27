/**
 * Source-metadata classification tests. Verifies TRAE Work CN is an
 * account-level source (case-insensitively) and that personal scope filters it
 * out while preserving local sources.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getSourceScope,
  isAccountLevelSource,
  normalizeUsageScope,
  filterRowsByUsageScope,
  listExcludedSources,
} = require("../src/lib/source-metadata");

test("trae-cn is classified as an account-level source case-insensitively", () => {
  assert.equal(getSourceScope("trae-cn"), "account");
  assert.equal(getSourceScope("TRAE-CN"), "account");
  assert.equal(getSourceScope(" Trae-Cn "), "account");
  assert.equal(isAccountLevelSource("trae-cn"), true);
  // Pre-existing classification is preserved.
  assert.equal(getSourceScope("cursor"), "account");
  assert.equal(getSourceScope("codex"), "local");
  assert.equal(getSourceScope("claude"), "local");
});

test("personal scope filters account-level trae-cn rows while preserving local sources", () => {
  const rows = [
    { source: "trae-cn", total_tokens: 10 },
    { source: "TRAE-CN", total_tokens: 20 },
    { source: "codex", total_tokens: 30 },
    { source: "claude", total_tokens: 40 },
  ];
  const personal = filterRowsByUsageScope(rows, "personal");
  assert.deepEqual(personal, [
    { source: "codex", total_tokens: 30 },
    { source: "claude", total_tokens: 40 },
  ]);
  assert.equal(filterRowsByUsageScope(rows, "all").length, 4);
  assert.equal(normalizeUsageScope("personal"), "personal");
});

test("listExcludedSources reports trae-cn as excluded from personal scope", () => {
  const excluded = listExcludedSources(
    [{ source: "trae-cn" }, { source: "TRAE-CN" }, { source: "codex" }],
    "personal",
  );
  assert.deepEqual(excluded, [
    { source: "trae-cn", source_scope: "account", reason: "account_level_source" },
  ]);
});
