"use strict";

const { formatSummaryLine } = require("./cli-ui");

const DIVIDER = "----------------------------------------------";

function renderLocalReport({ summary, isDryRun }) {
  const header = isDryRun
    ? "Dry run complete. Preview only; no changes were applied."
    : "Local configuration complete.";
  const lines = [header, "", "Integration Status:"];
  for (const item of summary || []) lines.push(formatSummaryLine(item));
  process.stdout.write(`${lines.join("\n")}\n`);
}

module.exports = {
  DIVIDER,
  renderLocalReport,
};
