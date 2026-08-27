"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");
const undici = require("undici");
const {
  applyUndiciProxyIfNeeded,
  resetProxyApplyStateForTests,
  readPersistedProxyConfig,
  getLastProxyApplyError,
} = require("../src/lib/proxy-env");

let tmpHome;
let prevHome;
let prevUserProfile;
let previousDispatcher;
const prevProxyEnv = {};
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
];

beforeEach(() => {
  resetProxyApplyStateForTests();
  previousDispatcher = undici.getGlobalDispatcher();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-proxy-config-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  for (const key of PROXY_ENV_KEYS) {
    prevProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  for (const key of PROXY_ENV_KEYS) {
    if (prevProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevProxyEnv[key];
  }
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (previousDispatcher) undici.setGlobalDispatcher(previousDispatcher);
});

function freshHandler(queuePath) {
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  return createLocalApiHandler({ queuePath });
}

function makeReq({ method = "GET", urlObj, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = urlObj.pathname + urlObj.search;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    _headers: headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    writeHead(status, hdrs) {
      this.statusCode = status;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    end(body) {
      if (body) chunks.push(body);
    },
    body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

async function call(handler, opts) {
  const urlObj = new URL(`http://localhost${opts.endpoint}`);
  const req = makeReq({ ...opts, urlObj });
  const res = makeRes();
  const handled = await handler(req, res, urlObj);
  assert.ok(handled, `endpoint must be handled: ${opts.endpoint}`);
  return res;
}

async function authToken(handler) {
  const authRes = await call(handler, { endpoint: "/api/local-auth" });
  return authRes.json().token;
}

function configPath() {
  return path.join(tmpHome, ".tokentracker", "tracker", "config.json");
}

test("GET proxy-config defaults to system when config.json has no proxy key", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({ machineId: "machine-abcdef12", telemetry: true }));
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-proxy-config" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.mode, "system");
  assert.equal(body.protocol, "http");
  assert.equal(body.host, "");
  assert.equal(body.port, 0);
  assert.ok(["none", "env", "system"].includes(body.effective));
  assert.equal(body.applyError, null);
});

test("POST proxy-config requires local auth, rejects illegal payload, and read-modify-writes", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({ machineId: "machine-abcdef12", telemetry: true }));
  const handler = freshHandler(queuePath);

  const denied = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-config",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 }),
  });
  assert.equal(denied.statusCode, 401);

  const token = await authToken(handler);
  const bad = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-config",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ mode: "manual", protocol: "http", host: "http://127.0.0.1", port: 7890 }),
  });
  assert.equal(bad.statusCode, 400);
  const unchanged = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  assert.equal(unchanged.machineId, "machine-abcdef12");
  assert.equal(unchanged.proxy, undefined);

  const ok = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-config",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 }),
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  assert.equal(ok.json().mode, "manual");
  assert.equal(ok.json().effective, "manual");

  const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  assert.equal(saved.machineId, "machine-abcdef12");
  assert.equal(saved.telemetry, true);
  assert.deepEqual(saved.proxy, {
    mode: "manual",
    protocol: "http",
    host: "127.0.0.1",
    port: 7890,
  });
});

test("POST proxy-test requires auth, does not persist, and does not apply globally", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({ machineId: "machine-abcdef12" }));
  const handler = freshHandler(queuePath);

  const denied = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-test",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "http", host: "127.0.0.1", port: 7890 }),
  });
  assert.equal(denied.statusCode, 401);

  const token = await authToken(handler);
  const bad = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-test",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ protocol: "http", host: "http://x", port: 1 }),
  });
  assert.equal(bad.statusCode, 400);

  const beforeDispatcher = undici.getGlobalDispatcher();
  const socks = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-test",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ protocol: "socks5", host: "127.0.0.1", port: 9 }),
  });
  assert.equal(socks.statusCode, 200);
  assert.equal(typeof socks.json().ok, "boolean");
  assert.equal(typeof socks.json().latencyMs, "number");
  assert.equal(undici.getGlobalDispatcher(), beforeDispatcher);

  const after = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  assert.equal(after.proxy, undefined);
  assert.equal(after.machineId, "machine-abcdef12");
});

test("GET proxy-config treats persisted string port and case variants as manual", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({
    machineId: "machine-abcdef12",
    proxy: {
      mode: "MANUAL",
      protocol: "HTTPS",
      host: "  proxy.example  ",
      port: "1080",
    },
  }));
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-proxy-config" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.mode, "manual");
  assert.equal(body.protocol, "https");
  assert.equal(body.host, "proxy.example");
  assert.equal(body.port, 1080);
  assert.equal(body.effective, "manual");

  let captured = null;
  applyUndiciProxyIfNeeded({
    env: {},
    setGlobalDispatcher: (dispatcher) => {
      captured = dispatcher;
    },
    ProxyAgent: function (url) {
      this.url = url;
      captured = this;
    },
    Agent: function () {},
    proxyConfig: readPersistedProxyConfig(),
  });
  assert.equal(captured.url, "https://proxy.example:1080");
});

test("GET proxy-config falls back to system for truly invalid persisted proxy values", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({
    machineId: "machine-abcdef12",
    proxy: {
      mode: "manual",
      protocol: "http",
      host: "http://127.0.0.1",
      port: 99999,
    },
  }));
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-proxy-config" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.mode, "system");
  // Fail-closed, not direct: the UI must not render "connecting directly"
  // while apply() is refusing outbound traffic.
  assert.equal(body.effective, "blocked");

  let installed = null;
  const applyResult = applyUndiciProxyIfNeeded({
    env: {},
    platform: "linux",
    setGlobalDispatcher: (dispatcher) => {
      installed = dispatcher;
    },
    ProxyAgent: function (url) {
      this.url = url;
      installed = this;
    },
    Agent: function () {
      this.direct = true;
      installed = this;
    },
    warn: () => {},
    proxyConfig: readPersistedProxyConfig(),
  });
  assert.equal(applyResult.ok, false);
  assert.ok(applyResult.error);
  assert.ok(installed);
  assert.equal(typeof installed.dispatch, "function");
  assert.ok(getLastProxyApplyError());

  const after = await call(handler, { endpoint: "/functions/tokentracker-proxy-config" });
  assert.ok(after.json().applyError);
});

test("POST proxy-config writes atomically and leaves no tmp file", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({ machineId: "machine-abcdef12" }));
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);
  const ok = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-config",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ mode: "off" }),
  });
  assert.equal(ok.statusCode, 200);
  const dir = path.dirname(configPath());
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, []);
  const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  assert.equal(saved.machineId, "machine-abcdef12");
  assert.equal(saved.proxy.mode, "off");
});

test("POST system after manual apply stops using the manual proxy URL", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({ machineId: "machine-abcdef12" }));
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);
  const headers = {
    "content-type": "application/json",
    "x-tokentracker-local-auth": token,
  };

  const manual = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-config",
    headers,
    body: JSON.stringify({ mode: "manual", protocol: "http", host: "10.0.0.1", port: 1080 }),
  });
  assert.equal(manual.statusCode, 200);
  assert.equal(manual.json().effective, "manual");
  const afterManual = undici.getGlobalDispatcher();
  assert.ok(afterManual instanceof undici.ProxyAgent);

  const system = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-config",
    headers,
    body: JSON.stringify({ mode: "system" }),
  });
  assert.equal(system.statusCode, 200);
  assert.notEqual(system.json().effective, "manual");
  assert.ok(["none", "env", "system"].includes(system.json().effective));
});

test("POST proxy-config returns ok:false when apply fails after a successful save", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({ machineId: "machine-abcdef12" }));
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);

  const orig = undici.ProxyAgent;
  undici.ProxyAgent = function () {
    throw new Error("apply exploded");
  };
  try {
    const res = await call(handler, {
      method: "POST",
      endpoint: "/functions/tokentracker-proxy-config",
      headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
      body: JSON.stringify({ mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.ok(body.applyError);
    const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    assert.equal(saved.proxy.mode, "manual");
    assert.equal(saved.proxy.host, "127.0.0.1");
  } finally {
    undici.ProxyAgent = orig;
  }
});

test("POST proxy-config keeps config.json at 0600 and preserves other keys", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({
    machineId: "machine-abcdef12",
    deviceToken: "secret-token",
    telemetry: true,
  }));
  fs.chmodSync(configPath(), 0o600);
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);
  const res = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-proxy-config",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ mode: "off" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  assert.equal(saved.machineId, "machine-abcdef12");
  assert.equal(saved.deviceToken, "secret-token");
  assert.equal(saved.telemetry, true);
  assert.equal(saved.proxy.mode, "off");
  if (process.platform !== "win32") {
    const mode = fs.statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("POST proxy-config invalidates the scutil system-proxy cache", async () => {
  const proxyEnv = require("../src/lib/proxy-env");
  let invalidated = 0;
  const orig = proxyEnv.invalidateSystemProxyCache;
  proxyEnv.invalidateSystemProxyCache = () => {
    invalidated += 1;
    orig();
  };
  try {
    const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, "");
    fs.writeFileSync(configPath(), JSON.stringify({ machineId: "machine-abcdef12" }));
    const handler = freshHandler(queuePath);
    const token = await authToken(handler);
    const res = await call(handler, {
      method: "POST",
      endpoint: "/functions/tokentracker-proxy-config",
      headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
      body: JSON.stringify({ mode: "off" }),
    });
    assert.equal(res.statusCode, 200);
    assert.ok(invalidated >= 1);
  } finally {
    proxyEnv.invalidateSystemProxyCache = orig;
  }
});

test("GET proxy-config reports the last manual apply failure", async () => {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  const handler = freshHandler(queuePath);
  applyUndiciProxyIfNeeded({
    env: {},
    setGlobalDispatcher: () => {},
    ProxyAgent: function () {
      throw new Error("socks construct failed");
    },
    Agent: function () {},
    warn: () => {},
    proxyConfig: { mode: "manual", protocol: "socks5", host: "127.0.0.1", port: 7890 },
  });
  const res = await call(handler, { endpoint: "/functions/tokentracker-proxy-config" });
  assert.equal(res.json().applyError, "socks construct failed");
});
