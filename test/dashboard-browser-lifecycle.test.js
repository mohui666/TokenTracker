const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("macOS releases the dashboard WKWebView after a normal close", () => {
  const source = read(
    "TokenTrackerBar/TokenTrackerBar/Services/DashboardWindowController.swift",
  );

  assert.match(source, /private func releaseDashboardResources\(/);
  assert.match(source, /removeScriptMessageHandler\(forName: "nativeBridge"\)/);
  assert.match(source, /NativeBridge\.shared\.webView = nil/);
  assert.match(source, /closingWindow\.contentView = nil/);
  assert.match(source, /self\.webView = nil/);
  assert.match(source, /self\.window = nil/);
  assert.doesNotMatch(source, /nativeOAuth/);
  assert.doesNotMatch(source, /oauthInFlight/);

  const closeHandler = source.match(
    /func windowWillClose\([\s\S]*?\n    }\n\n    private func releaseDashboardResources/, 
  )?.[0];
  assert.ok(closeHandler, "Dashboard close handler should exist");
  assert.match(closeHandler, /releaseDashboardResources\(closingWindow: closingWindow\)/);
});

test("Windows closes and disposes an idle dashboard WebView2 instead of hiding it", () => {
  const windowSource = read("TokenTrackerWin/DashboardWindow.cs");
  const traySource = read("TokenTrackerWin/TrayApplicationContext.cs");

  assert.match(windowSource, /public event Action<DashboardWindow>\? ReleasedForIdle/);
  assert.match(windowSource, /_webView\.Dispose\(\)/);
  assert.match(windowSource, /ReleasedForIdle\?\.Invoke\(this\)/);
  assert.doesNotMatch(windowSource, /oauth/i);

  const closingHandler = windowSource.match(
    /protected override void OnClosing\([\s\S]*?\n    }\n\n    protected override void OnClosed/,
  )?.[0];
  assert.ok(closingHandler, "Dashboard closing handler should exist");
  assert.doesNotMatch(
    closingHandler,
    /if \(!_exiting\)\s*\{\s*e\.Cancel = true;\s*Hide\(\);/,
    "normal closes must not retain WebView2",
  );

  assert.match(traySource, /dashboard\.ReleasedForIdle \+= OnDashboardReleasedForIdle/);
  assert.match(traySource, /ReferenceEquals\(_dashboard, dashboard\)/);
  assert.match(traySource, /_dashboard = null/);
});
