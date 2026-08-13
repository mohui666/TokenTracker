const assert = require("node:assert/strict");
const { test } = require("node:test");

const { resolveRuntimeConfig } = require("../src/lib/runtime-config");

test("resolveRuntimeConfig prefers CLI flags over config and env", () => {
  const result = resolveRuntimeConfig({
    cli: { httpTimeoutMs: 5000 },
    config: { httpTimeoutMs: 9000, debug: false },
    env: { TOKENTRACKER_DEBUG: "1" },
  });

  assert.equal(result.httpTimeoutMs, 5000);
  // Precedence is cli > config > env: the persisted false beats the env flag.
  assert.equal(result.debug, false);
  assert.equal(result.sources.httpTimeoutMs, "cli");
  assert.equal(result.sources.debug, "config");
});

test("resolveRuntimeConfig ignores non-TOKENTRACKER env inputs", () => {
  const result = resolveRuntimeConfig({
    env: {
      LEGACY_BASE_URL: "https://legacy.example",
      LEGACY_DEVICE_TOKEN: "legacy",
    },
  });

  assert.equal(result.httpTimeoutMs, 20_000);
  assert.equal(result.debug, false);
  assert.equal(result.sources.httpTimeoutMs, "default");
});

test("resolveRuntimeConfig ignores retired cloud config keys", () => {
  // Pre-local-only installs may still carry baseUrl/deviceToken/dashboardUrl in
  // config.json; none of them may leak into the runtime config anymore.
  const result = resolveRuntimeConfig({
    config: { baseUrl: "https://example.invalid", deviceToken: "tok" },
    env: { TOKENTRACKER_INSFORGE_BASE_URL: "https://example.invalid" },
  });

  assert.equal("baseUrl" in result, false);
  assert.equal("deviceToken" in result, false);
  assert.equal(result.httpTimeoutMs, 20_000);
});

test("resolveRuntimeConfig normalizes timeout and flags", () => {
  const result = resolveRuntimeConfig({
    env: {
      TOKENTRACKER_HTTP_TIMEOUT_MS: "500",
      TOKENTRACKER_DEBUG: "1",
    },
  });

  assert.equal(result.httpTimeoutMs, 1000);
  assert.equal(result.debug, true);
});
