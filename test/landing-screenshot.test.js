const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

test("LandingPage includes screenshot image and copy alt key", () => {
  const src = read("dashboard/src/ui/marketing/MarketingLanding.jsx");
  assert.match(src, /landing\.screenshot\.alt/);
  assert.match(src, /dashboard-dark\.png/);
});

test("copy registry includes landing screenshot alt", () => {
  const src = read("dashboard/src/content/copy.csv");
  assert.ok(src.includes("landing.screenshot.alt"));
});
