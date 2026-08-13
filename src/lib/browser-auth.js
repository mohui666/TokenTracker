const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Local-only build: this module now only knows how to open a URL in the
// user's browser (used by `serve` to open the local dashboard). The OAuth
// callback flow (beginBrowserAuth / startLocalCallbackServer /
// resolvePostAuthRedirect) went away with the cloud backend.

function detectDefaultBrowser() {
  try {
    const raw = cp.execFileSync("defaults", [
      "read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers",
    ], { encoding: "utf8", timeout: 3000 });
    const match = raw.match(/https[\s\S]*?LSHandlerRoleAll\s*=\s*"([^"]+)"/);
    if (!match) return null;
    const bundleId = match[1].toLowerCase();
    if (bundleId.includes("chrome")) return "Google Chrome";
    if (bundleId.includes("safari")) return "Safari";
    if (bundleId.includes("edgemac")) return "Microsoft Edge";
    if (bundleId.includes("thebrowser") || bundleId.includes("arc")) return "Arc";
    return null;
  } catch (_e) {
    return null;
  }
}

function buildBrowserList() {
  const all = ["Google Chrome", "Safari", "Microsoft Edge", "Arc"];
  const def = detectDefaultBrowser();
  if (!def) return all;
  return [def, ...all.filter((b) => b !== def)];
}

function isWslSession(env = process.env) {
  return Boolean(
    (typeof env.WSL_DISTRO_NAME === "string" && env.WSL_DISTRO_NAME.trim()) ||
    (typeof env.WSL_INTEROP === "string" && env.WSL_INTEROP.trim()),
  );
}

function hasGraphicalSession(env = process.env) {
  return Boolean(
    (typeof env.DISPLAY === "string" && env.DISPLAY.trim()) ||
    (typeof env.WAYLAND_DISPLAY === "string" && env.WAYLAND_DISPLAY.trim()),
  );
}

function isCommandAvailable(command, { env = process.env, platform = process.platform } = {}) {
  if (typeof command !== "string" || !command.trim()) return false;

  const pathEntries = String(env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const suffixes = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .map((ext) => ext.trim())
      .filter(Boolean)
    : [""];

  const candidates = [];
  if (hasPathSeparator) {
    candidates.push(command);
  } else {
    for (const dir of pathEntries) {
      if (platform === "win32") {
        candidates.push(path.join(dir, command));
        for (const ext of suffixes) {
          candidates.push(path.join(dir, `${command}${ext}`));
        }
      } else {
        candidates.push(path.join(dir, command));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_e) {}
  }
  return false;
}

function resolveBrowserLaunchCommand(
  url,
  {
    platform = process.platform,
    env = process.env,
    commandExists = isCommandAvailable,
  } = {},
) {
  if (platform === "win32") {
    const escapedUrl = String(url).replace(/'/g, "''");
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start-Process -FilePath '${escapedUrl}'`,
      ],
    };
  }

  if (isWslSession(env) && commandExists("wslview", { env, platform })) {
    return { command: "wslview", args: [url] };
  }

  if (!hasGraphicalSession(env)) return null;

  const candidates = [
    { command: "xdg-open", args: [url] },
    { command: "gio", args: ["open", url] },
    { command: "sensible-browser", args: [url] },
  ];
  for (const candidate of candidates) {
    if (commandExists(candidate.command, { env, platform })) {
      return candidate;
    }
  }
  return null;
}

function openInBrowser(url, { platform = process.platform, env = process.env, spawn = cp.spawn, commandExists = isCommandAvailable } = {}) {

  if (platform === "darwin") {
    // On macOS, prefer reusing a matching tab in a supported running browser.
    // Supported browsers are checked with the user's default browser first.
    const browsers = buildBrowserList();
    const listLiteral = browsers.map((b) => `"${b}"`).join(", ");
    const script = `
tell application "System Events"
  set browserList to {${listLiteral}}
  set runningBrowser to ""
  repeat with b in browserList
    if (exists process (b as text)) then
      set runningBrowser to (b as text)
      exit repeat
    end if
  end repeat
end tell

if runningBrowser is "" then
  open location "${url}"
else if runningBrowser is "Google Chrome" then
  tell application "Google Chrome"
    set found to false
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        if URL of t starts with "${url}" then
          set active tab index of w to tabIndex
          set index of w to 1
          reload t
          activate
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if not found then
      open location "${url}"
      activate
    end if
  end tell
else if runningBrowser is "Safari" then
  tell application "Safari"
    set found to false
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        if URL of t starts with "${url}" then
          set current tab of w to t
          set index of w to 1
          do JavaScript "location.reload()" in t
          activate
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if not found then
      open location "${url}"
      activate
    end if
  end tell
else
  open location "${url}"
end if
`;
    if (commandExists("osascript", { env, platform })) {
      try {
        const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
        child.unref();
        return true;
      } catch (_e) {}
    }

    if (commandExists("open", { env, platform })) {
      try {
        const child = spawn("open", [url], { stdio: "ignore", detached: true });
        child.unref();
        return true;
      } catch (_e2) {}
    }
    return false;
  }

  const launch = resolveBrowserLaunchCommand(url, { platform, env, commandExists });
  if (!launch) return false;

  try {
    const child = spawn(launch.command, launch.args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch (_e) {}
  return false;
}

module.exports = {
  detectDefaultBrowser,
  hasGraphicalSession,
  isCommandAvailable,
  isWslSession,
  openInBrowser,
  resolveBrowserLaunchCommand,
};
