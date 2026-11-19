import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompanion } from "../lib/companion.js";

test("pairing is single-use, durable, isolated and revision checked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tab1-companion-"));
  const handler = createCompanion({
    directory,
    cards: async (settings, appTopics) => ({ settings, appTopics, cards: [] }),
  });
  const server = createServer((req, res) =>
    handler(req, res, new URL(req.url, "http://localhost")),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/companion/`;
  async function request(route, body, token) {
    const r = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, ...(await r.json()) };
  }
  try {
    const settings = { v: 1, tabs: {}, custom: [], density: "compact" };
    const first = await request("create", { settings });
    assert.equal(first.status, 200);
    const extras = await request("cards", {settings, appTopics:["science"]}, first.token);
    assert.deepEqual(extras.appTopics, ["science"]);
    const unchanged = await request("sync", undefined, first.token);
    assert.deepEqual(unchanged.settings, extras.settings);
    assert.equal(unchanged.appTopics, undefined);
    assert.equal(unchanged.revision, first.revision);

    assert.equal((await request("sync")).status, 401);
    const pair = await request("pair", {}, first.token);
    const code = new URL(pair.payload).searchParams.get("code");
    const second = await request("claim", { code });
    assert.equal(second.status, 200);
    assert.notEqual(second.token, first.token);
    assert.equal((await request("claim", { code })).status, 410);
    assert.equal(
      (
        await request(
          "sync",
          {
            revision: 0,
            settings: { ...settings, density: "balanced" },
            reading: { "https://example.com/a": { read: true, saved: true } },
          },
          second.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("sync", { revision: 0, settings }, first.token)).status,
      409,
    );
    const current = await request("sync", undefined, first.token);
    assert.equal(current.settings.density, "balanced");
    assert.equal(current.reading["https://example.com/a"].saved, true);
    const other = await request("create", { settings });
    assert.deepEqual(
      (await request("sync", undefined, other.token)).reading,
      {},
    );
    assert.equal(
      (
        await request(
          "article?url=http%3A%2F%2F127.0.0.1",
          undefined,
          first.token,
        )
      ).status,
      400,
    );
    await request("unlink", {}, second.token);
    assert.equal((await request("sync", undefined, second.token)).status, 401);
    assert.equal((await request("sync", undefined, first.token)).status, 200);
    assert.doesNotThrow(() =>
      createCompanion({ directory, cards: async () => ({}) }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("article errors distinguish extraction failure from temporary upstream failure and allow retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tab1-article-"));
  let attempts = 0;
  const handler = createCompanion({ directory, cards: async () => ({}), fetchArticle: async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("Publisher timed out"), { status: 502 });
    if (attempts === 2) return "<html><body>Unavailable</body></html>";
    return `<html><body><article><h1>Recovered</h1><p>${"The publisher recovered and the story is available again. ".repeat(20)}</p></article></body></html>`;
  }});
  const server = createServer((req, res) => handler(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/companion/`;
  try {
    const profile = await fetch(base + "create", { method: "POST", body: "{}" }).then(r => r.json());
    const request = () => fetch(base + "article?url=https%3A%2F%2Fexample.org%2Farticle", { headers: { Authorization: `Bearer ${profile.token}` } });
    let response = await request();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).retryable, true);
    response = await request();
    assert.equal(response.status, 422);
    assert.equal((await response.json()).retryable, false);
    response = await request();
    assert.equal(response.status, 200);
    assert.match((await response.json()).html, /publisher recovered/);
    await request();
    assert.equal(attempts, 3, "successful extraction is cached, failures are not");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing comments fetches the latest discussion and updates the shared cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tab1-comments-"));
  let version = 0;
  const handler = createCompanion({
    directory, cards: async () => ({}),
    fetchDiscussion: async () => JSON.stringify({ comments: [
      { short_id: "a", comment: "Version " + ++version },
    ] }),
  });
  const server = createServer((req, res) => handler(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/companion/`;
  try {
    const profile = await fetch(base + "create", { method: "POST", body: "{}" }).then(r => r.json());
    async function comment(refresh = false) {
      const url = new URL("comments", base);
      url.searchParams.set("url", "https://lobste.rs/s/example/test");
      url.searchParams.set("refresh", String(refresh));
      const response = await fetch(url, { headers: { Authorization: "Bearer " + profile.token } });
      assert.equal(response.status, 200);
      return (await response.json()).comments[0].html;
    }
    assert.equal(await comment(), "Version 1");
    assert.equal(await comment(), "Version 1");
    assert.equal(await comment(true), "Version 2");
    assert.equal(await comment(), "Version 2");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Hacker News counts saved entries and checks whether the reply queue is exhausted", async t => {
  const directory = await mkdtemp(join(tmpdir(), "tab1-comment-count-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let size = 6;
  const handler = createCompanion({
    directory, cards: async () => ({}),
    fetchDiscussion: async url => {
      const id = Number(new URL(url).pathname.split("/").pop().split(".")[0]);
      return JSON.stringify(id === 1
        ? { descendants: 4, kids: Array.from({ length: size }, (_, i) => i + 2) }
        : { parent: 1, deleted: id % 3 === 0, text: "reply" });
    },
  });
  const server = createServer((req, res) => handler(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/companion/`;
  const profile = await fetch(base + "create", { method: "POST", body: "{}" }).then(r => r.json());
  const load = () => fetch(base + "comments?url=https://news.ycombinator.com/item?id=1&refresh=true", {
    headers: { Authorization: "Bearer " + profile.token },
  }).then(r => r.json());
  const full = await load();
  assert.equal(full.total, 6);
  assert.equal(full.comments.filter(c => c.html === "[removed]").length, 2);
  assert.equal(full.complete, true);
  size = 501;
  const partial = await load();
  assert.equal(partial.comments.length, 500);
  assert.equal(partial.complete, false);
});

test("articles finish while a backlog of discussions is stalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tab1-slow-discussions-"));
  const held = Promise.withResolvers();
  const occupied = Promise.withResolvers();
  let started = 0;
  const handler = createCompanion({
    directory, cards: async () => ({}),
    fetchDiscussion: async () => {
      if (++started === 3) occupied.resolve();
      await held.promise;
      return JSON.stringify({ comments: [] });
    },
    fetchArticle: async () => "<html><body><article><p>" + "A readable offline article. ".repeat(20) + "</p></article></body></html>",
  });
  const server = createServer((req, res) => handler(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/companion/`;
  const discussions = [];
  try {
    const profile = await fetch(base + "create", { method: "POST", body: "{}" }).then(r => r.json());
    const headers = { Authorization: "Bearer " + profile.token };
    for (let i = 0; i < 5; i++) {
      discussions.push(fetch(base + "comments?url=https://lobste.rs/s/story" + i, { headers }));
    }
    await occupied.promise;
    const response = await fetch(base + "article?url=https://example.org/story", {
      headers, signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    assert.equal(started, 3);
  } finally {
    held.resolve();
    await Promise.allSettled(discussions);
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
