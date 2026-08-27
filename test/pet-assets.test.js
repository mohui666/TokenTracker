const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function personalitySource() {
  return fs.readFileSync(path.join(repoRoot, "dashboard/src/lib/pet-personality.js"), "utf8");
}

function configuredCharacterIds() {
  const match = personalitySource().match(/PET_CHARACTER_IDS\s*=\s*(\[[^;]+\])/);
  assert.ok(match, "PET_CHARACTER_IDS must remain a literal array so assets can be validated");
  return JSON.parse(match[1]);
}

/**
 * Characters drawn from something other than a sprite atlas, and so with no
 * sheet to validate. Read from the RENDERERS map rather than hardcoded: "not
 * clawd" used to imply "has an atlas", and `bot` broke that.
 */
function nonAtlasCharacterIds() {
  const match = personalitySource().match(/const RENDERERS\s*=\s*Object\.assign\([^{]*\{([^}]+)\}/);
  assert.ok(match, "RENDERERS must remain a literal object so assets can be validated");
  return [...match[1].matchAll(/([a-z0-9-]+)\s*:/g)].map((entry) => entry[1]);
}

test("every atlas-backed pet ships matching web and macOS assets", () => {
  const vectorOrCustomDrawn = nonAtlasCharacterIds();
  assert.deepEqual(vectorOrCustomDrawn, ["clawd", "bot"]);
  const atlasCharacters = configuredCharacterIds().filter(
    (id) => !vectorOrCustomDrawn.includes(id),
  );
  assert.deepEqual(atlasCharacters, ["sprout", "byte", "ember"]);

  for (const id of atlasCharacters) {
    const webPath = path.join(repoRoot, `dashboard/public/pets/${id}/spritesheet.webp`);
    const macPath = path.join(repoRoot, `TokenTrackerBar/TokenTrackerBar/PetSprites/pet-${id}.png`);
    assert.ok(fs.existsSync(webPath), `${id} web atlas is missing`);
    assert.ok(fs.existsSync(macPath), `${id} macOS atlas is missing`);

    const web = fs.readFileSync(webPath);
    assert.equal(web.subarray(0, 4).toString("ascii"), "RIFF", `${id} web atlas is not RIFF`);
    assert.equal(web.subarray(8, 12).toString("ascii"), "WEBP", `${id} web atlas is not WebP`);

    const png = fs.readFileSync(macPath);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 1_536, `${id} macOS atlas width must be 1536`);
    assert.equal(png.readUInt32BE(20), 1_872, `${id} macOS atlas height must be 1872`);
  }
});
