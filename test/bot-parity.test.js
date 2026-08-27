const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const APPEARANCE = "dashboard/src/lib/bot-appearance.js";
const PERSONALITY = "dashboard/src/lib/pet-personality.js";
const PET_APPEARANCE = "dashboard/src/lib/pet-appearance.js";
const CLAWD_VIEW = "TokenTrackerBar/TokenTrackerBar/Views/ClawdCompanionView.swift";
const PET_CONTROLLER = "TokenTrackerBar/TokenTrackerBar/Services/DesktopPetWindowController.swift";
const ICON_STYLE = "TokenTrackerBar/TokenTrackerBar/Models/MenuBarIconStyle.swift";
const WIDGETS_PAGE = "dashboard/src/pages/WidgetsPage.jsx";
const FRAMES = "TokenTrackerBar/TokenTrackerBar/BotFrames.json";

/** The pet-state keys of the SCENES table in bot-appearance.js. */
function webMappedPetStates() {
  const source = read(APPEARANCE);
  const body = source.slice(source.indexOf("const SCENES = {"), source.indexOf("const FALLBACK_SCENE"));
  assert.ok(body.length > 0, "SCENES must remain a literal object");
  return [...body.matchAll(/^\s{2}"?([a-z][a-z0-9-]*)"?:\s*\{/gm)].map((entry) => entry[1]);
}

/** The strings returned by ClawdState.petStateName in Swift. */
function swiftPetStateNames() {
  const source = read(CLAWD_VIEW);
  const body = source.slice(source.indexOf("var petStateName: String {"));
  assert.ok(body.length > 0, "petStateName must stay a literal switch so parity can be checked");
  return [...body.matchAll(/case \.[A-Za-z]+: return "([a-z0-9-]+)"/g)].map((entry) => entry[1]);
}

test("every state macOS can ask for is one the web mapping knows", () => {
  const web = new Set(webMappedPetStates());
  const swift = swiftPetStateNames();
  assert.ok(swift.length >= 20, `expected the full ClawdState set, saw ${swift.length}`);
  for (const name of swift) {
    assert.ok(web.has(name), `Swift emits "${name}" but bot-appearance.js does not map it`);
  }
});

test("the pre-rendered frames cover every state macOS can ask for", () => {
  const payload = JSON.parse(read(FRAMES));
  assert.equal(payload.schema, 4, "bump BotFrames.expectedSchema in Swift alongside the generator");
  for (const name of swiftPetStateNames()) {
    const engineState = payload.scenes[name];
    assert.ok(engineState, `BotFrames.json has no scene for "${name}" — run npm run gen:bot-frames`);
    const clip = payload.states[engineState];
    assert.ok(clip?.frames?.length > 0, `clip "${engineState}" has no frames`);
  }
});

test("the shipped frames match what the engine produces now", () => {
  // The file is committed because the Xcode build needs it and CI's macOS job does
  // not run Node; a stale copy would silently ship old animations.
  const { status, stderr } = require("node:child_process").spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/gen-bot-frames.cjs"), "--check"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(status, 0, stderr);
});

test("renderer classification agrees between web and macOS", () => {
  // Object.create(null)-based to keep prototype keys ("constructor") from resolving.
  const web = read(PERSONALITY).match(/const RENDERERS\s*=\s*Object\.assign\(\s*Object\.create\(null\)\s*,\s*\{([^}]+)\}/);
  assert.ok(web, "RENDERERS must remain a literal object behind Object.create(null)");
  const webPairs = [...web[1].matchAll(/([a-z0-9-]+)\s*:\s*"([a-z]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(webPairs, [["clawd", "clawd"], ["bot", "vector"]]);

  const swift = read(PET_CONTROLLER);
  assert.match(swift, /if self == Self\.clawd \{ return \.clawd \}/);
  assert.match(swift, /if self == Self\.bot \{ return \.vector \}/);
  assert.match(swift, /return \.atlas/);
});

test("visual scale agrees between web and macOS", () => {
  const web = read(PET_APPEARANCE);
  const clawd = web.match(/CLAWD_VISUAL_SCALE = ([\d.]+)/);
  const bot = web.match(/BOT_VISUAL_SCALE = ([\d.]+)/);
  assert.ok(clawd && bot);

  const swift = read(PET_CONTROLLER);
  const swiftClawd = swift.match(/case \.clawd: return ([\d.]+)/);
  const swiftVector = swift.match(/case \.vector: return ([\d.]+)/);
  assert.ok(swiftClawd && swiftVector, "visualScale must stay a literal switch");
  assert.equal(swiftClawd[1], clawd[1], "Clawd visual scale drifted between web and macOS");
  assert.equal(swiftVector[1], bot[1], "bot visual scale drifted between web and macOS");
});

test("the menu bar icon styles offered by the dashboard all exist in Swift", () => {
  const web = read(WIDGETS_PAGE).match(/const iconStyles = (\[[^\]]+\])/);
  assert.ok(web, "iconStyles must remain a literal array");
  const offered = JSON.parse(web[1].replace(/'/g, '"'));
  assert.ok(offered.includes("bot"), "the bot icon style must be selectable");

  const swift = read(ICON_STYLE);
  // Scoped to the enum body: MenuBarRunnerMotion further down has cases at the
  // same indentation (idle / syncing / ...) that are not icon styles.
  const enumBody = swift.slice(
    swift.indexOf("enum MenuBarIconStyle"),
    swift.indexOf("static let defaultsKey"),
  );
  assert.ok(enumBody.length > 0, "MenuBarIconStyle must keep its cases above defaultsKey");
  const cases = [...enumBody.matchAll(/^\s+case `?([a-z]+)`?$/gm)].map((entry) => entry[1]);
  assert.deepEqual([...offered].sort(), [...cases].sort());

  // Every style must have a pacing entry, or the animator falls back silently.
  const pace = swift.slice(swift.indexOf("static func frameInterval"));
  for (const style of offered) {
    // Styles may share a case arm, e.g. `case .clawd, .static:`.
    assert.match(pace, new RegExp(`case [^\\n]*\\.\`?${style}\`?[,:]`),
      `${style} has no frameInterval entry`);
  }
});

test("the colour palette offered to users is the one macOS ships", () => {
  const choices = read(APPEARANCE).match(/BOT_COLOR_CHOICES = (\[[^\]]+\])/);
  assert.ok(choices, "BOT_COLOR_CHOICES must remain a literal array");
  const offered = JSON.parse(choices[1]);
  assert.equal(offered[0], "auto", "auto must stay first — it is the default");
  assert.ok(!offered.includes("encre") && !offered.includes("creme"),
    "ink and cream are what auto resolves to; offering them as fixed choices is a regression");

  const payload = JSON.parse(read(FRAMES));
  assert.deepEqual(Object.keys(payload.palette).sort(), offered.slice(1).sort());
  assert.ok(payload.autoColors.light && payload.autoColors.dark);
});

test("the menu bar plays clips that loop cleanly, and never the triangle morph", () => {
  const clips = read(APPEARANCE).match(/BOT_MENUBAR_CLIPS = \{([^}]+)\}/);
  assert.ok(clips, "BOT_MENUBAR_CLIPS must remain a literal object");
  const table = Object.fromEntries(
    [...clips[1].matchAll(/([a-z]+):\s*"([a-z]+)"/g)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(Object.keys(table).sort(), ["active", "disconnected", "idle", "sleeping"]);

  // orbit morphs the body out of a spinning triangle and its first/last frames are
  // 171 units apart, so looping it in the menu bar reads as the icon glitching.
  assert.notEqual(table.active, "orbit", "the menu bar must not loop the orbit morph");

  const payload = JSON.parse(read(FRAMES));
  assert.deepEqual(payload.menubarClips, table, "run npm run gen:bot-frames");
  for (const state of Object.values(table)) {
    assert.ok(payload.states[state]?.frames?.length > 0, `menu bar clip ${state} has no frames`);
  }
});

test("clips the menu bar plays are sampled densely, since it cannot interpolate", () => {
  const payload = JSON.parse(read(FRAMES));
  const menubar = new Set(Object.values(payload.menubarClips));
  for (const [id, clip] of Object.entries(payload.states)) {
    assert.ok(clip.fps > 0, `${id} has no fps`);
    assert.equal(clip.frames.length, Math.max(1, Math.round(clip.duration * clip.fps)),
      `${id} frame count does not match its duration x fps`);
    if (menubar.has(id)) {
      assert.ok(clip.fps >= 24, `${id} is played by the menu bar and must be >= 24fps`);
    }
  }

  // The Swift pace table must reproduce those clips at their authored speed.
  const pace = read(ICON_STYLE);
  assert.match(pace, /case \.bot:[\s\S]{0,400}?1\.0 \/ 24\.0/,
    "MenuBarRunnerPace must play bot at 24fps to match the sampling rate");
});
