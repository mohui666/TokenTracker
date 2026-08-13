const fs = require("node:fs/promises");
const { constants } = require("node:fs");

const { readJsonStrict } = require("./fs");

async function buildDoctorReport({
  runtime = {},
  diagnostics = null,
  now = () => new Date(),
  paths = {},
} = {}) {
  const checks = [];

  checks.push(...buildRuntimeChecks(runtime));

  if (paths.trackerDir) {
    checks.push(await checkTrackerDir(paths.trackerDir));
  }
  if (paths.configPath) {
    checks.push(await checkConfigJson(paths.configPath));
  }
  if (paths.cliPath) {
    checks.push(await checkCliEntrypoint(paths.cliPath));
  }

  if (diagnostics) {
    checks.push(...buildDiagnosticsChecks(diagnostics));
  }

  const summary = summarizeChecks(checks);

  return {
    version: 1,
    generated_at: now().toISOString(),
    ok: summary.critical === 0,
    summary,
    checks,
    diagnostics,
  };
}

function buildRuntimeChecks(runtime = {}) {
  const checks = [];
  const httpTimeoutMs = Number.isFinite(Number(runtime.httpTimeoutMs))
    ? Number(runtime.httpTimeoutMs)
    : null;
  const debug = Boolean(runtime.debug);

  checks.push({
    id: "runtime.http_timeout_ms",
    status: "ok",
    detail: "http timeout resolved",
    critical: false,
    meta: {
      http_timeout_ms: httpTimeoutMs,
      source: runtime?.sources?.httpTimeoutMs || null,
    },
  });

  checks.push({
    id: "runtime.debug",
    status: "ok",
    detail: debug ? "debug enabled" : "debug disabled",
    critical: false,
    meta: {
      debug,
      source: runtime?.sources?.debug || null,
    },
  });

  return checks;
}

async function checkTrackerDir(trackerDir) {
  try {
    const st = await fs.stat(trackerDir);
    if (!st.isDirectory()) {
      return {
        id: "fs.tracker_dir",
        status: "fail",
        detail: "tracker dir is not a directory",
        critical: true,
        meta: { path: trackerDir },
      };
    }
    await fs.access(trackerDir, constants.R_OK);
    return {
      id: "fs.tracker_dir",
      status: "ok",
      detail: "tracker dir readable",
      critical: false,
      meta: { path: trackerDir },
    };
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return {
        id: "fs.tracker_dir",
        status: "warn",
        detail: "tracker dir missing",
        critical: false,
        meta: { path: trackerDir },
      };
    }
    if (err && (err.code === "EACCES" || err.code === "EPERM")) {
      return {
        id: "fs.tracker_dir",
        status: "fail",
        detail: "tracker dir permission denied",
        critical: true,
        meta: { path: trackerDir, code: err.code },
      };
    }
    return {
      id: "fs.tracker_dir",
      status: "fail",
      detail: "tracker dir error",
      critical: true,
      meta: { path: trackerDir, code: err?.code || "error" },
    };
  }
}

async function checkConfigJson(configPath) {
  const res = await readJsonStrict(configPath);
  if (res.status === "ok") {
    return {
      id: "fs.config_json",
      status: "ok",
      detail: "config.json readable",
      critical: false,
      meta: { path: configPath },
    };
  }
  if (res.status === "missing") {
    return {
      id: "fs.config_json",
      status: "warn",
      detail: "config.json missing",
      critical: false,
      meta: { path: configPath },
    };
  }
  if (res.status === "invalid") {
    return {
      id: "fs.config_json",
      status: "fail",
      detail: "config.json invalid",
      critical: true,
      meta: { path: configPath },
    };
  }
  return {
    id: "fs.config_json",
    status: "fail",
    detail: "config.json read error",
    critical: true,
    meta: { path: configPath },
  };
}

async function checkCliEntrypoint(cliPath) {
  try {
    const st = await fs.stat(cliPath);
    if (!st.isFile()) {
      return {
        id: "cli.entrypoint",
        status: "fail",
        detail: "cli entrypoint is not a file",
        critical: false,
        meta: { path: cliPath },
      };
    }
    await fs.access(cliPath, constants.R_OK);
    if (process.platform !== "win32") {
      await fs.access(cliPath, constants.X_OK);
    }
    return {
      id: "cli.entrypoint",
      status: "ok",
      detail: "cli entrypoint readable",
      critical: false,
      meta: { path: cliPath },
    };
  } catch (err) {
    return {
      id: "cli.entrypoint",
      status: "fail",
      detail: "cli entrypoint not accessible",
      critical: false,
      meta: { path: cliPath, code: err?.code || "error" },
    };
  }
}

function buildDiagnosticsChecks(diagnostics) {
  const checks = [];
  const notify = diagnostics?.notify || {};
  const notifyConfigured = Boolean(
    notify.codex_notify_configured ||
    notify.every_code_notify_configured ||
    notify.claude_hook_configured ||
    notify.gemini_hook_configured ||
    notify.opencode_plugin_configured ||
    notify.openclaw_hook_configured,
  );

  checks.push({
    id: "notify.configured",
    status: notifyConfigured ? "ok" : "warn",
    detail: notifyConfigured ? "notify configured" : "notify not configured",
    critical: false,
    meta: { configured: notifyConfigured },
  });

  // Dual-install visibility (#306): surface resolved Kiro installs in the  // human-readable doctor output, not just the embedded diagnostics JSON.
  const kiro = diagnostics?.kiro;
  if (kiro && typeof kiro.wsl_mode === "string") {
    const fmt = (present) => (present ? "yes" : "no");
    const wslPart = kiro.wsl_installs
      ? `wsl ide=${fmt(kiro.wsl_installs.ide_present)} cli=${fmt(kiro.wsl_installs.cli_present)}`
      : "wsl not detected";
    checks.push({
      id: "kiro.installs",
      status: "ok",
      detail: `native ide=${fmt(kiro.ide_present)} cli=${fmt(kiro.cli_present)}; ${wslPart} (mode ${kiro.wsl_mode})`,
      critical: false,
      meta: { wsl_mode: kiro.wsl_mode, wsl_installs: kiro.wsl_installs || null },
    });
  }

  return checks;
}

function summarizeChecks(checks = []) {
  const summary = { ok: 0, warn: 0, fail: 0, critical: 0 };
  for (const check of checks) {
    if (!check || typeof check.status !== "string") continue;
    if (check.status === "ok") summary.ok += 1;
    else if (check.status === "warn") summary.warn += 1;
    else if (check.status === "fail") summary.fail += 1;
    if (check.status === "fail" && check.critical) summary.critical += 1;
  }
  return summary;
}

module.exports = { buildDoctorReport };
