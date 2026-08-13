// Single-source guardrail: badge thresholds live ONLY in the local CLI
// (src/lib/local-api.js — the "server"). The dashboard receives
// thresholds/next_threshold in the endpoint payload and must not embed its
// own copies — a second copy WILL drift.
//
// Exemptions: dashboard/src/lib/mock-data.ts fakes realistic payloads for
// dashboard:dev (display-only, never used for real evaluation).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Signature literals that identify a threshold table copy. Chosen to be
// specific enough not to collide with unrelated numbers.
const THRESHOLD_SIGNATURES = [
  "100000000000", // token_titan diamond
  "10000000000", // token_titan gold
  "100_000_000_000",
  "10_000_000_000",
];

test("dashboard source carries no badge threshold literals (mock exempt)", () => {
  const files = walk(path.join(ROOT, "dashboard", "src")).filter(
    (f) =>
      /\.(jsx?|tsx?)$/.test(f) &&
      !/\.test\.[jt]sx?$/.test(f) && // test fixtures aren't display code
      !f.endsWith(`lib${path.sep}mock-data.ts`),
  );
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const sig of THRESHOLD_SIGNATURES) {
      assert.ok(
        !content.includes(sig),
        `${path.relative(ROOT, file)} embeds badge threshold ${sig}`,
      );
    }
  }
});

test("badge id sets agree across local-api, frontend catalog, and copy.csv", () => {
  const catalog = read("dashboard/src/ui/achievements/badge-catalog.js");
  const copyCsv = read("dashboard/src/content/copy.csv");
  const localApi = read("src/lib/local-api.js");

  // The full local-only catalog: every badge is computed by the local CLI.
  const BADGE_IDS = [
    "token_titan",
    "big_day",
    "wordsmith",
    "marathoner",
    "streak",
    "weekend_warrior",
    "momentum",
    "polyglot",
    "multitool",
    "veteran",
    "project_hopper",
    "project_devotion",
    "night_owl",
  ];
  const DROPPED_IDS = ["podium", "trendsetter"];

  for (const id of BADGE_IDS) {
    assert.ok(localApi.includes(id), `local-api missing badge ${id}`);
    assert.ok(catalog.includes(`"${id}"`), `frontend catalog missing ${id}`);
    assert.ok(
      copyCsv.includes(`achievements.badge.${id}.name`),
      `copy.csv missing name key for ${id}`,
    );
    assert.ok(
      copyCsv.includes(`achievements.badge.${id}.desc`),
      `copy.csv missing desc key for ${id}`,
    );
  }
  for (const id of DROPPED_IDS) {
    assert.ok(!catalog.includes(`"${id}"`), `frontend catalog still has dropped badge ${id}`);
    assert.ok(
      !copyCsv.includes(`achievements.badge.${id}.`),
      `copy.csv still has keys for dropped badge ${id}`,
    );
  }
});
