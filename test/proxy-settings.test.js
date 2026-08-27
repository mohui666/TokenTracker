"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeProxyConfig,
  parseProxyPayload,
  buildProxyUrl,
} = require("../src/lib/proxy-settings");

test("normalizeProxyConfig treats missing / empty raw as system defaults", () => {
  assert.deepEqual(normalizeProxyConfig(undefined), {
    mode: "system",
    protocol: "http",
    host: "",
    port: 0,
  });
  assert.deepEqual(normalizeProxyConfig(null), {
    mode: "system",
    protocol: "http",
    host: "",
    port: 0,
  });
  assert.deepEqual(normalizeProxyConfig({}), {
    mode: "system",
    protocol: "http",
    host: "",
    port: 0,
  });
});

test("normalizeProxyConfig maps socks to socks5", () => {
  assert.deepEqual(
    normalizeProxyConfig({
      mode: "manual",
      protocol: "socks",
      host: "127.0.0.1",
      port: 1080,
    }),
    {
      mode: "manual",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 1080,
    },
  );
});

test("normalizeProxyConfig accepts a valid manual config", () => {
  assert.deepEqual(
    normalizeProxyConfig({
      mode: "manual",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 7890,
    }),
    {
      mode: "manual",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 7890,
    },
  );
});

test("normalizeProxyConfig accepts off and keeps last-used host fields", () => {
  assert.deepEqual(
    normalizeProxyConfig({
      mode: "off",
      protocol: "https",
      host: "proxy.internal",
      port: 8443,
    }),
    {
      mode: "off",
      protocol: "https",
      host: "proxy.internal",
      port: 8443,
    },
  );
});

test("normalizeProxyConfig falls back to system on dirty values", () => {
  const cases = [
    { raw: "socks5://127.0.0.1:7890", reason: "proxy config must be an object" },
    { raw: { mode: "auto" }, reason: "invalid mode" },
    { raw: { mode: "manual", protocol: "ftp", host: "127.0.0.1", port: 7890 }, reason: "invalid protocol" },
    { raw: { mode: "manual", protocol: "http", host: "", port: 7890 }, reason: "invalid host" },
    { raw: { mode: "manual", protocol: "http", host: "http://127.0.0.1", port: 7890 }, reason: "invalid host" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1/proxy", port: 7890 }, reason: "invalid host" },
    { raw: { mode: "manual", protocol: "http", host: "user@127.0.0.1", port: 7890 }, reason: "invalid host" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1?x=1", port: 7890 }, reason: "invalid host" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1#frag", port: 7890 }, reason: "invalid host" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1\\proxy", port: 7890 }, reason: "invalid host" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1 1", port: 7890 }, reason: "invalid host" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 0 }, reason: "invalid port" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 65536 }, reason: "invalid port" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 80.5 }, reason: "invalid port" },
    { raw: { mode: "manual", protocol: "http", host: "127.0.0.1" }, reason: "invalid port" },
  ];
  for (const { raw, reason } of cases) {
    const out = normalizeProxyConfig(raw);
    assert.equal(out.mode, "system", `expected system fallback for ${JSON.stringify(raw)}`);
    assert.equal(out.reason, reason, `reason mismatch for ${JSON.stringify(raw)}`);
  }
});

test("normalizeProxyConfig coerces numeric port strings in manual mode", () => {
  const out = normalizeProxyConfig({
    mode: "MANUAL",
    protocol: "HTTPS",
    host: "  proxy.example  ",
    port: "1080",
  });
  assert.deepEqual(out, {
    mode: "manual",
    protocol: "https",
    host: "proxy.example",
    port: 1080,
  });
});

test("parseProxyPayload rejects illegal POST bodies instead of coercing", () => {
  assert.equal(parseProxyPayload(null).ok, false);
  assert.equal(parseProxyPayload({ mode: "auto" }).ok, false);
  assert.equal(parseProxyPayload({ mode: "manual", protocol: "http", host: "http://x", port: 1 }).ok, false);
  assert.equal(parseProxyPayload({ mode: "manual", protocol: "http", host: "x", port: 0 }).ok, false);
  assert.equal(parseProxyPayload({ mode: "manual", protocol: "http", host: "user@host", port: 1 }).ok, false);
  assert.equal(parseProxyPayload({ mode: "manual", protocol: "http", host: "host?x", port: 1 }).ok, false);
  assert.equal(parseProxyPayload({ mode: "manual", protocol: "http", host: "host#x", port: 1 }).ok, false);
  assert.equal(parseProxyPayload({ mode: "manual", protocol: "http", host: "host\\x", port: 1 }).ok, false);
  assert.equal(parseProxyPayload({ mode: "manual", protocol: "http", host: "ho st", port: 1 }).ok, false);
  assert.equal(parseProxyPayload({ mode: "system" }).ok, true);
  assert.deepEqual(parseProxyPayload({
    mode: "manual",
    protocol: "http",
    host: "127.0.0.1",
    port: 7890,
  }).value, {
    mode: "manual",
    protocol: "http",
    host: "127.0.0.1",
    port: 7890,
  });
});

test("buildProxyUrl builds a URL only for valid manual configs", () => {
  assert.equal(
    buildProxyUrl({ mode: "manual", protocol: "socks5", host: "127.0.0.1", port: 7890 }),
    "socks5://127.0.0.1:7890",
  );
  assert.equal(
    buildProxyUrl({ mode: "manual", protocol: "http", host: "::1", port: 8080 }),
    "http://[::1]:8080",
  );
  assert.equal(
    buildProxyUrl({ mode: "manual", protocol: "http", host: "[::1]", port: 8080 }),
    "http://[::1]:8080",
  );
  assert.equal(buildProxyUrl({ mode: "manual", protocol: "http", host: "foo:bar", port: 8080 }), null);
  assert.equal(buildProxyUrl({ mode: "manual", protocol: "http", host: "127.0.0.1:8080", port: 8080 }), null);
  assert.equal(buildProxyUrl({ mode: "system", protocol: "http", host: "127.0.0.1", port: 7890 }), null);
  assert.equal(buildProxyUrl({ mode: "off" }), null);
  assert.equal(buildProxyUrl({ mode: "manual", protocol: "http", host: "http://x", port: 1 }), null);
});
