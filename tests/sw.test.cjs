const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

function worker({ saved, response, offline = false, full = false } = {}) {
  const handlers = {};
  const writes = [];
  let fetches = 0;
  const cache = {
    match: async () => saved,
    put: async (key, value) => {
      if (full) throw new Error("Quota exceeded");
      writes.push({ key, value });
    },
  };
  const context = vm.createContext({
    self: { addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: {
      open: async name => {
        assert.equal(name, "stork-flight-app-v27");
        return cache;
      },
      match: () => { throw new Error("Must not search other apps' caches"); },
    },
    fetch: async () => {
      fetches++;
      if (offline) throw new Error("Offline");
      return response;
    },
  });
  vm.runInContext(readFileSync(join(__dirname, "../sw.js"), "utf8"), context);
  return {
    writes,
    fetches: () => fetches,
    request(mode = "navigate", method = "GET") {
      let result;
      handlers.fetch({
        request: { mode, method },
        respondWith: promise => { result = promise; },
      });
      return result;
    },
  };
}

test("successful navigation refreshes the saved page", async () => {
  const response = new Response("new game");
  const app = worker({ response });
  assert.equal(await app.request(), response);
  assert.equal(app.writes[0].key, "index.html");
  assert.equal(await app.writes[0].value.text(), "new game");
});

for (const status of [404, 500, 503]) {
  test(`HTTP ${status} preserves and serves the saved game`, async () => {
    const saved = new Response("working game");
    const app = worker({ saved, response: new Response("error", { status }) });
    assert.equal(await app.request(), saved);
    assert.equal(app.writes.length, 0);
  });
}

test("HTTP errors are returned when no saved page exists", async () => {
  const response = new Response("unavailable", { status: 503 });
  assert.equal(await worker({ response }).request(), response);
});

test("offline navigation uses only this version's saved game", async () => {
  const saved = new Response("offline game");
  assert.equal(await worker({ saved, offline: true }).request(), saved);
});

test("offline navigation without a saved page rejects", async () => {
  await assert.rejects(worker({ offline: true }).request(), /Offline/);
});

test("cached assets require no network request", async () => {
  const saved = new Response("game code");
  const app = worker({ saved });
  assert.equal(await app.request("cors"), saved);
  assert.equal(app.fetches(), 0);
});

test("successful asset downloads are saved before completion", async () => {
  const response = new Response("game code");
  const app = worker({ response });
  assert.equal(await app.request("cors"), response);
  assert.equal(app.writes.length, 1);
});

test("failed asset downloads are not cached", async () => {
  const response = new Response("error", { status: 500 });
  const app = worker({ response });
  assert.equal(await app.request("cors"), response);
  assert.equal(app.writes.length, 0);
});

for (const mode of ["navigate", "cors"]) {
  test(`full storage still returns a successful ${mode} response`, async () => {
    const response = new Response("game");
    assert.equal(await worker({ response, full: true }).request(mode), response);
  });
}

test("non-GET requests are left to the browser", () => {
  const app = worker();
  assert.equal(app.request("cors", "POST"), undefined);
  assert.equal(app.fetches(), 0);
});
