import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import sanitize from "sanitize-html";
import { extractArticle } from "./article.js";
import { fetchSafely, checkFeedUrl } from "./custom.js";
import { validSettings } from "../public/settings.js";
const token = () => randomBytes(32).toString("base64url");
const hash = (s) => createHash("sha256").update(s).digest("hex");
export function createCompanion({ directory, cards, fetchArticle = url => fetchSafely(url, "text/html, application/xhtml+xml"), fetchDiscussion = url => fetchSafely(url, "application/json") }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "profiles.json");
  let db = { profiles: {}, devices: {}, pairs: {} };
  try {
    db = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const save = () => {
    writeFileSync(path + ".tmp", JSON.stringify(db), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  };
  const cached = new Map();
  let active = 0;
  const waiting = [];
  let activeDiscussions = 0;
  function startWaiting() {
    while (active < 4) {
      // Reserve capacity for articles when slow discussion trees occupy the server.
      const index = waiting.findIndex(job => !job.discussion || activeDiscussions < 3);
      if (index < 0) return;
      const [job] = waiting.splice(index, 1);
      active++;
      if (job.discussion) activeDiscussions++;
      job.start();
    }
  }
  let creationWindow = Date.now(),
    creations = 0;
  async function memo(key, work, refresh = false) {
    const prev = cached.get(key);
    if (prev && (!prev.settled || (!refresh && Date.now() - prev.at < 600000))) return prev.promise;
    if (waiting.length >= 128)
      throw Object.assign(new Error("Downloads busy. Try again shortly."), {
        status: 429,
      });
    const promise = (async () => {
      const discussion = key.startsWith("comments:");
      await new Promise(start => {
        waiting.push({ discussion, start });
        startWaiting();
      });
      try {
        return await work();
      } finally {
        active--;
        if (discussion) activeDiscussions--;
        startWaiting();
      }
    })();
    const entry = { at: Date.now(), promise, settled: false };
    cached.set(key, entry);
    if (cached.size > 200) cached.delete(cached.keys().next().value);
    try {
      const result = await promise;
      entry.settled = true;
      return result;
    } catch (e) {
      if (cached.get(key) === entry) cached.delete(key);
      throw e;
    }
  }
  async function body(req) {
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (Buffer.byteLength(data) > 262144)
        throw Object.assign(new Error("Request too large"), { status: 413 });
    }
    return data ? JSON.parse(data) : {};
  }
  function send(res, status, value) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  function addDevice(id) {
    const secret = token();
    db.devices[hash(secret)] = id;
    save();
    return secret;
  }
  return async (req, res, url) => {
    if (!url.pathname.startsWith("/api/companion/")) return false;
    try {
      if (
        req.headers.origin &&
        req.headers.origin !== `https://${req.headers.host}` &&
        req.headers.origin !== `http://${req.headers.host}`
      )
        throw Object.assign(new Error("Origin refused"), { status: 403 });
      const route = url.pathname.slice("/api/companion/".length);
      const auth = String(req.headers.authorization ?? "").replace(
        /^Bearer /,
        "",
      );
      let id = db.devices[hash(auth)];
      let profile = db.profiles[id];
      if (route === "create" && req.method === "POST") {
        if (Date.now() - creationWindow > 3600000) {
          creationWindow = Date.now();
          creations = 0;
        }
        if (++creations > 100)
          throw Object.assign(new Error("Please try connecting again later"), {
            status: 429,
          });
        if (Object.keys(db.profiles).length >= 1000)
          throw new Error("Profile limit reached");
        const b = await body(req);
        id = token();
        profile = {
          revision: 0,
          settings: validSettings(b.settings),
          reading: {},
        };
        db.profiles[id] = profile;
        send(res, 200, { token: addDevice(id), ...profile });
        return true;
      }
      if (route === "claim" && req.method === "POST") {
        const b = await body(req);
        const key = hash(String(b.code));
        const pair = db.pairs[key];
        if (!pair || pair.expires < Date.now())
          throw Object.assign(
            new Error("Pairing code expired or already used"),
            { status: 410 },
          );
        delete db.pairs[key];
        send(res, 200, { token: addDevice(pair.id), ...db.profiles[pair.id] });
        return true;
      }
      if (!profile)
        throw Object.assign(new Error("Please connect this device"), {
          status: 401,
        });
      if (route === "pair" && req.method === "POST") {
        for (const [k, p] of Object.entries(db.pairs))
          if (p.expires < Date.now()) delete db.pairs[k];
        const code = token();
        db.pairs[hash(code)] = { id, expires: Date.now() + 300000 };
        save();
        const origin = process.env.TAB1_PUBLIC_URL || "https://tab1.net";
        const payload = `tab1://pair?server=${encodeURIComponent(origin)}&code=${code}`;
        send(res, 200, {
          payload,
          qr: await QRCode.toDataURL(payload),
          expires: Date.now() + 300000,
        });
      } else if (route === "sync" && req.method === "POST") {
        const b = await body(req);
        if (b.revision !== profile.revision) {
          send(res, 409, profile);
          return true;
        }
        if (b.settings !== undefined) {
          const s = validSettings(b.settings);
          if (!s) throw new Error("Invalid settings");
          profile.settings = s;
        }
        for (const [key, value] of Object.entries(b.reading ?? {})) {
          if (key.length > 2048 || !value || typeof value !== "object")
            continue;
          profile.reading[key] = {
            ...(profile.reading[key] || { read: false, saved: false }),
            ...(typeof value.read === "boolean" ? { read: value.read } : {}),
            ...(typeof value.saved === "boolean" ? { saved: value.saved } : {}),
            ...(value.story &&
            value.story.link === key &&
            typeof value.story.title === "string"
              ? {
                  story: {
                    link: key,
                    title: value.story.title.slice(0, 1000),
                    ...(typeof value.story.date === "string" ? { date: value.story.date.slice(0, 64) } : {}),
                    ...(Number.isSafeInteger(value.story.comments) && value.story.comments >= 0
                      ? { comments: value.story.comments } : {}),
                    ...(typeof value.story.source === "string" ? { source: value.story.source.slice(0, 256) } : {}),
                    ...(typeof value.story.image === "string"
                      ? { image: value.story.image.slice(0, 2048) }
                      : {}),
                    ...(typeof value.story.commentsUrl === "string"
                      ? { commentsUrl: value.story.commentsUrl.slice(0, 2048) }
                      : {}),
                  },
                }
              : {}),
          };
        }
        profile.revision++;
        save();
        send(res, 200, profile);
      } else if (route === "sync" && req.method === "GET")
        send(res, 200, profile);
      else if (route === "unlink" && req.method === "POST") {
        delete db.devices[hash(auth)];
        save();
        send(res, 200, { ok: true });
      } else if (route === "cards" && req.method === "POST") {
        const b = await body(req);
        send(
          res,
          200,
          await cards(validSettings(b.settings) || profile.settings, b.appTopics),
        );
      } else if (route === "article" && req.method === "GET") {
        const link = checkFeedUrl(url.searchParams.get("url")).href;
        send(
          res,
          200,
          await memo("article:" + link, async () => {
            return extractArticle(await fetchArticle(link), link);
          }),
        );
      } else if (route === "comments" && req.method === "GET") {
        const link = new URL(url.searchParams.get("url"));
        const limit = url.searchParams.get("all") === "true" ? 10000 : 500;
        send(
          res,
          200,
          await memo(`comments:${link}:${limit}`, async () => {
            return loadDiscussion(link, limit, fetchDiscussion);
          }, url.searchParams.get("refresh") === "true"),
        );
      } else send(res, 404, { error: "Unknown companion endpoint" });
    } catch (e) {
      send(res, e.status ?? 502, {
        error: e.message,
        retryable: e.retryable ?? [408, 429, 500, 502, 503, 504].includes(e.status ?? 502),
      });
    }
    return true;
  };
}

export async function loadDiscussion(link, limit, fetchDiscussion = url => fetchSafely(url, "application/json")) {
  let comments = [],
    total = 0,
    complete;
  if (link.hostname === "news.ycombinator.com") {
    const root = await fetchDiscussion(
      `https://hacker-news.firebaseio.com/v0/item/${Number(link.searchParams.get("id"))}.json`,
    ).then(JSON.parse);
    total = root.descendants ?? 0;
    const queue = (root.kids ?? []).map((id) => ({ id, depth: 0 }));
    while (queue.length && comments.length < limit) {
      const batch = queue.splice(
        0,
        Math.min(12, limit - comments.length),
      );
      const entries = await Promise.all(
        batch.map(async (p) => ({
          ...p,
          item: JSON.parse(
            await fetchDiscussion(
              `https://hacker-news.firebaseio.com/v0/item/${p.id}.json`,
            ),
          ),
        })),
      );
      for (const { id, depth, item } of entries) {
        if (!item) continue;
        comments.push({
          id: String(id),
          parent: item.parent ? String(item.parent) : null,
          depth,
          author: item.by ?? "",
          html: sanitize(
            item.deleted || item.dead
              ? "[removed]"
              : (item.text ?? ""),
          ),
          date: new Date((item.time ?? 0) * 1000).toISOString(),
        });
        queue.push(
          ...(item.kids ?? []).map((id) => ({
            id,
            depth: depth + 1,
          })),
        );
      }
    }
    complete = queue.length === 0;
    total = complete ? comments.length : Math.max(total, comments.length);
  } else if (
    link.hostname === "lobste.rs" &&
    /^\/s\/[a-z0-9]+/.test(link.pathname)
  ) {
    const data = JSON.parse(
      await fetchDiscussion(
        `https://lobste.rs${link.pathname.match(/^\/s\/[a-z0-9]+/)[0]}.json`,
      ),
    );
    total = data.comments?.length ?? 0;
    comments = (data.comments ?? []).slice(0, limit).map((c) => ({
      id: c.short_id,
      parent: c.parent_comment ?? null,
      depth: c.indent_level ?? 0,
      author: c.commenting_user?.username ?? "",
      html: sanitize(c.comment ?? ""),
      date: c.created_at,
    }));
    complete = comments.length === total;
  } else throw new Error("Discussion source not supported");
  return {
    comments,
    total,
    complete,
    downloadedAt: new Date().toISOString(),
  };
}
