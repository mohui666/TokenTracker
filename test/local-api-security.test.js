const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function createRequest({ method = "GET", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;

  process.nextTick(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });

  return req;
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

async function getLocalAuthToken(handler) {
  const req = createRequest({ method: "GET" });
  const res = createResponse();
  const handled = await handler(req, res, new URL("http://127.0.0.1/api/local-auth"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const body = JSON.parse(res.body.toString("utf8"));
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 0);
  return body.token;
}

function loadLocalApiWithSpawn(fakeSpawn) {
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = fakeSpawn;
  delete require.cache[require.resolve("../src/lib/local-api")];
  const mod = require("../src/lib/local-api");
  return {
    mod,
    restore() {
      childProcess.spawn = originalSpawn;
      delete require.cache[require.resolve("../src/lib/local-api")];
    },
  };
}

test("local device metadata exposes the system name separately from machine identity", () => {
  const { getSystemDeviceName } = require("../src/lib/local-api");
  const expected = os.hostname().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128) || null;
  assert.equal(getSystemDeviceName(), expected);
  assert.doesNotMatch(getSystemDeviceName() || "", /^Token Tracker .*#/u);
});

function createSuccessfulSpawn(calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", "sync ok");
      child.emit("close", 0);
    });
    return child;
  };
}

function createBusySpawn(calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stderr.emit(
        "data",
        "Error: SYNC_BUSY: another sync is still running; no refresh was performed\n",
      );
      child.emit("close", 1);
    });
    return child;
  };
}

test("local sync preserves the SYNC_BUSY failure code", async () => {
  const calls = [];
  const tempDir = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "tt-local-sync-busy-"));
  const { mod, restore } = loadLocalApiWithSpawn(createBusySpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(tempDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ drain: true }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body.toString("utf8"));
    assert.equal(body.ok, false);
    assert.equal(body.code, "SYNC_BUSY");
    assert.match(body.error, /no refresh was performed/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
    require("node:fs").rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local sync drain request runs sync with --drain", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ drain: true }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-3), [path.join(process.cwd(), "bin/tracker.js"), "sync", "--drain"]);
  } finally {
    restore();
  }
});

test("local sync auto background request runs sync with --auto --background", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        auto: true,
        background: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
  } finally {
    restore();
  }
});

test("local sync all-local background request forwards the source expansion flag", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        auto: true,
        background: true,
        allLocalSources: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-5), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
      "--all-local-sources",
    ]);
  } finally {
    restore();
  }
});

test("local sync lightweight alias forwards background mode", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        auto: true,
        lightweight: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
  } finally {
    restore();
  }
});

test("local sync combines background scan with drain priority", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        drain: true,
        auto: true,
        background: true,
        lightweight: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-5), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
      "--drain",
    ]);
  } finally {
    restore();
  }
});

test("local sync only treats boolean true as background or lightweight", async () => {
  const cases = [
    { background: false },
    { background: "true" },
    { background: 1 },
    { lightweight: false },
    { lightweight: "true" },
    { lightweight: 1 },
  ];

  for (const body of cases) {
    const calls = [];
    const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

    try {
      const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
      const localAuthToken = await getLocalAuthToken(handler);
      const req = createRequest({
        method: "POST",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({
          auto: true,
          ...body,
        }),
      });
      const res = createResponse();

      const handled = await handler(
        req,
        res,
        new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
      );

      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(-3), [path.join(process.cwd(), "bin/tracker.js"), "sync", "--auto"]);
    } finally {
      restore();
    }
  }
});

test("local sync only treats boolean true as drain", async () => {
  const cases = [
    {},
    { drain: false },
    { drain: "true" },
    { drain: 1 },
  ];

  for (const body of cases) {
    const calls = [];
    const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

    try {
      const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
      const localAuthToken = await getLocalAuthToken(handler);
      const req = createRequest({
        method: "POST",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({
          ...body,
        }),
      });
      const res = createResponse();

      const handled = await handler(
        req,
        res,
        new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
      );

      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(-2), [path.join(process.cwd(), "bin/tracker.js"), "sync"]);
    } finally {
      restore();
    }
  }
});

test("local sync never injects cloud credentials into the spawned env", async () => {
  // Regression guard for the local-only build: TOKENTRACKER_DEVICE_TOKEN /
  // TOKENTRACKER_INSFORGE_BASE_URL must not be forwarded even if the caller
  // still posts legacy cloud fields.
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "legacy-device-token",
        insforgeBaseUrl: "https://evil.example",
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, undefined);
    assert.equal(calls[0].options.env.TOKENTRACKER_INSFORGE_BASE_URL, undefined);
  } finally {
    restore();
  }
});

test("local sync rejects requests without the local auth token", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const req = createRequest({
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
      ok: false,
      error: "Unauthorized",
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});
