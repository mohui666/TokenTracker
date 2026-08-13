const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
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
  return JSON.parse(res.body.toString("utf8")).token;
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

async function runLocalSync(body, options = {}) {
  const calls = [];
  const tmpHome = options.tmpHome || fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-local-api-background-"));
  const ownsTmpHome = !options.tmpHome;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: options.queuePath || path.join(process.cwd(), "tmp-queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify(body),
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
    return calls[0];
  } finally {
    restore();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (ownsTmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

test("local-api forwards strict boolean auto background sync", async () => {
  const call = await runLocalSync({ auto: true, background: true });
  const args = call.args;
  assert.deepEqual(args.slice(-4), [
    path.join(process.cwd(), "bin/tracker.js"),
    "sync",
    "--auto",
    "--background",
  ]);
});

test("local-api treats lightweight true as background alias", async () => {
  const call = await runLocalSync({ auto: true, lightweight: true });
  const args = call.args;
  assert.deepEqual(args.slice(-4), [
    path.join(process.cwd(), "bin/tracker.js"),
    "sync",
    "--auto",
    "--background",
  ]);
});

test("local-api combines background scan with drain priority", async () => {
  const call = await runLocalSync({
    drain: true,
    auto: true,
    background: true,
    allLocalSources: true,
    publishAccount: true,
  });
  const args = call.args;
  assert.deepEqual(args.slice(-7), [
    path.join(process.cwd(), "bin/tracker.js"),
    "sync",
    "--auto",
    "--background",
    "--publish-account",
    "--all-local-sources",
    "--drain",
  ]);
});

test("local-api background and lightweight require boolean true", async () => {
  const cases = [
    { background: false },
    { background: "true" },
    { background: 1 },
    { lightweight: false },
    { lightweight: "true" },
    { lightweight: 1 },
  ];

  for (const body of cases) {
    const call = await runLocalSync({ auto: true, ...body });
    const args = call.args;
    assert.deepEqual(args.slice(-3), [path.join(process.cwd(), "bin/tracker.js"), "sync", "--auto"]);
  }
});
