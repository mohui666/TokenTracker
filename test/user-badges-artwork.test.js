const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const CATALOG_PATH = path.join(
  ROOT,
  "dashboard",
  "src",
  "ui",
  "achievements",
  "badge-catalog.js",
);

test("every achievement uses an original badge-id artwork file", () => {
  const catalog = fs.readFileSync(CATALOG_PATH, "utf8");
  const rows = [...catalog.matchAll(/id: "([a-z_]+)"[^\n]+art: "\/achievements\/([^"]+)"/g)];

  assert.ok(rows.length >= 13, "expected the full achievement artwork catalog");

  for (const [, id, filename] of rows) {
    const expected = `${id.replaceAll("_", "-")}.png`;
    assert.equal(filename, expected, `${id} still references non-original artwork`);

    const artworkPath = path.join(ROOT, "dashboard", "public", "achievements", filename);
    const png = fs.readFileSync(artworkPath);
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", `${filename} is not a PNG`);
    assert.equal(png.readUInt32BE(16), 256, `${filename} must be 256px wide`);
    assert.equal(png.readUInt32BE(20), 256, `${filename} must be 256px tall`);
    assert.ok(png.includes(Buffer.from("tRNS")), `${filename} must retain transparency`);
  }
});
