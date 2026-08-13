const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { transform } = require("esbuild");

const repoRoot = path.join(__dirname, "..");

async function parseDashboardFile(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  await transform(source, {
    loader: "jsx",
    sourcefile: relativePath,
  });
}

function readAppSource() {
  return fs.readFileSync(path.join(repoRoot, "dashboard/src/App.jsx"), "utf8");
}

test("App.jsx parses without duplicate identifier errors", async () => {
  await assert.doesNotReject(parseDashboardFile("dashboard/src/App.jsx"));
});

test("App.jsx no longer routes to removed cloud/hosted pages", () => {
  const source = readAppSource();
  for (const gone of [
    '"/leaderboard"',
    '"/login"',
    '"/reset-password"',
    '"/auth/callback"',
    '"/auth/native-callback"',
    '"/device"',
    '"/ip-check"',
    '"/share',
    '"/u/',
  ]) {
    assert.equal(source.includes(gone), false, `Removed route ${gone} should not exist`);
  }
  for (const gone of [
    "LeaderboardPage",
    "LeaderboardProfilePage",
    "LoginPage",
    "ResetPasswordPage",
    "NativeAuthCallbackPage",
    "DevicePage",
    "IpCheckPage",
  ]) {
    assert.equal(source.includes(gone), false, `${gone} should not be referenced`);
  }
});

test("App.jsx keeps the local route set", () => {
  const source = readAppSource();
  for (const route of [
    '"/dashboard"',
    '"/landing"',
    '"/limits"',
    '"/settings"',
    '"/skills"',
    '"/sessions"',
    '"/widgets"',
    '"/pet-settings"',
    '"/service-status"',
    '"/achievements"',
    '"/wrapped"',
  ]) {
    assert.equal(source.includes(route), true, `${route} route should exist`);
  }
  for (const page of [
    "DashboardPage",
    "LimitsPage",
    "SettingsPage",
    "SkillsPage",
    "SessionsPage",
    "WidgetsPage",
    "PetPage",
    "ServiceStatusPage",
    "AchievementsPage",
    "WrappedPage",
    "LandingPage",
  ]) {
    assert.equal(source.includes(page), true, `${page} should be referenced`);
  }
});

test("App.jsx keeps menu bar configuration inside /widgets", () => {
  const source = readAppSource();
  assert.equal(source.includes('"/widgets"'), true, "/widgets route should exist");
  assert.equal(source.includes("WidgetsPage"), true, "WidgetsPage should be referenced");
  assert.equal(source.includes('"/menubar"'), false, "/menubar should not be a separate route");
  assert.equal(source.includes("MenuBarPage"), false, "MenuBarPage should not be referenced");
});

test("App.jsx routes to the desktop pet settings page", () => {
  const source = readAppSource();
  assert.equal(source.includes('"/pet-settings"'), true, "/pet-settings route should exist");
  assert.equal(source.includes("PetPage"), true, "PetPage should be lazy-loaded and referenced");
});
