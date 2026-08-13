const { cmdInit } = require("./commands/init");
const { cmdSync } = require("./commands/sync");
const { cmdStatus } = require("./commands/status");
const { cmdDiagnostics } = require("./commands/diagnostics");
const { cmdDoctor } = require("./commands/doctor");
const { cmdUninstall } = require("./commands/uninstall");
const { cmdServe } = require("./commands/serve");
const { cmdWrapped } = require("./commands/wrapped");
const { cmdSessions } = require("./commands/sessions");

async function run(argv) {
  const [command, ...rest] = argv;

  // No args → launch dashboard
  if (!command) {
    await cmdServe(argv);
    return;
  }

  if (command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "-v" || command === "--version") {
    const pkg = require("../package.json");
    console.log(`v${pkg.version}`);
    return;
  }

  switch (command) {
    case "serve":
      await cmdServe(rest);
      return;
    case "init":
      await cmdInit(rest);
      return;
    case "sync":
      await cmdSync(rest);
      return;
    case "status":
      await cmdStatus(rest);
      return;
    case "diagnostics":
      await cmdDiagnostics(rest);
      return;
    case "doctor":
      await cmdDoctor(rest);
      return;
    case "uninstall":
      await cmdUninstall(rest);
      return;
    case "wrapped":
      await cmdWrapped(rest);
      return;
    case "sessions":
      await cmdSessions(rest);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function printHelp() {
  // Keep this short; npx users want quick guidance.
  process.stdout.write(
    [
      "tokentracker",
      "",
      "Usage:",
      "  npx tokentracker                                         Open local dashboard",
      "  npx tokentracker -v, --version                           Show version info",
      "  npx tokentracker [--debug] serve [--port 7680] [--no-open] [--no-sync]",
      "  npx tokentracker [--debug] init [--yes] [--dry-run] [--no-open]",
      "  npx tokentracker [--debug] sync [--auto] [--from-openclaw]",
      "  npx tokentracker [--debug] status [--probe-keychain] [--probe-keychain-details]",
      "  npx tokentracker [--debug] diagnostics [--out diagnostics.json]",
      "  npx tokentracker [--debug] doctor [--json] [--out doctor.json]",
      "  npx tokentracker [--debug] uninstall [--purge]",
      "  npx tokentracker [--debug] wrapped [--year 2026] [--json]",
      "  npx tokentracker sessions [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--format json|csv] [--out file] [--refresh] [--no-git]",
      "",
      "Notes:",
      "  - init: consent first, local setup next.",
      "  - --yes skips the consent menu (non-interactive safe).",
      "  - --dry-run previews changes without writing files.",
      "  - Every Code notify installs when ~/.code/config.toml exists.",
      "  - OpenClaw session plugin auto-links when OpenClaw is installed (requires hooks.allowConversationAccess enabled + gateway restart).",
      "  - sync parses ~/.codex/sessions/**/rollout-*.jsonl and ~/.code/sessions/**/rollout-*.jsonl into the local queue.",
      "  - --from-openclaw marks sync runs triggered by the OpenClaw session plugin.",
      "  - --debug shows original backend errors.",
      "  - sessions exports metadata-only Claude/Codex efficiency analytics; no prompt or response text is retained.",
      "",
    ].join("\n"),
  );
}

module.exports = { run };
