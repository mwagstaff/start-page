import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:http2";
import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

const minute = 60_000;
const cooldown = 30 * minute;
const hash = value => createHash("sha256").update(value).digest("hex");
export const storyHashes = cards => [...new Set(cards.flatMap(card =>
  card.items.map(item => hash(item.link).slice(0, 16))))];
const remember = (previous, current) => [...new Set([...current, ...previous])].slice(0, 2500);

// The same personalized card builder supplies the phone and the worker. A new
// subscriber starts with the edition it just fetched, including its app topics.
export function storyPushService(store, loadCards, send, log = console.info) {
  const devices = store.db.collection("storyPushDevices");
  let running = false;
  // Keep enough metadata to recover a missed edition after it leaves the cards.
  function collect(device, cards) {
    const pending = { ...device.pending };
    const known = new Set(device.known);
    const added = [];
    for (const card of cards) for (const story of card.items) {
      const id = hash(story.link).slice(0, 16);
      if (known.has(id) || pending[id]) continue;
      pending[id] = { link: story.link, title: story.title ?? story.link };
      added.push(id);
    }
    return { pending, known: remember(device.known ?? [], added), added };
  }

  async function register(key, config, topics, cards) {
    if (!config || typeof config.enabled !== "boolean" || typeof config.token !== "string" || !/^[0-9a-f]{64,200}$/.test(config.token ?? "")) return { pushRegistered: false };
    const id = hash(config.token);
    if (!config.enabled) {
      await devices.deleteOne({ _id: id, key });
      return { pushRegistered: false };
    }
    if (!["sandbox", "production"].includes(config.environment)) return { pushRegistered: false };
    // A worker or acknowledgement can change the queue while a phone polls.
    for (;;) {
      const previous = await devices.findOne({ _id: id });
      const same = previous?.key === key;
      const state = same ? previous : {};
      const tracksSaves = config.confirmSaves === true;
      const edition = tracksSaves ? collect(state.confirmSaves ? state : {}, cards) : null;
      const fields = {
        key, token: config.token, environment: config.environment, revision: randomUUID(),
        topics: Array.isArray(topics) ? topics.filter(x => typeof x === "string").slice(0, 60) : [],
        refreshed: new Date(), confirmSaves: tracksSaves,
        known: edition?.known ?? remember(state.known ?? [], storyHashes(cards)),
        pending: edition?.pending ?? {},
        discovered: edition && Object.keys(edition.pending).length ? state.discovered ?? new Date() : null,
        lastAccepted: state.lastAccepted ?? null,
      };
      if (previous) {
        const result = await devices.updateOne({ _id: id, revision: previous.revision }, { $set: fields });
        if (!result.modifiedCount) continue;
      } else {
        try { await devices.insertOne({ _id: id, ...fields }); }
        catch (e) { if (e.code === 11000) continue; throw e; }
      }
      await devices.deleteMany({ key, _id: { $ne: id } });
      return { pushRegistered: true, lastStoryPush: fields.lastAccepted,
        pendingStories: edition ? Object.values(edition.pending) : undefined };
    }
  }
  async function acknowledge(key, hashes) {
    if (!Array.isArray(hashes) || !hashes.length || hashes.length > 500 ||
        !hashes.every(id => typeof id === "string" && /^[0-9a-f]{16}$/.test(id))) {
      throw Object.assign(new Error("Invalid story acknowledgements"), { status: 400 });
    }
    const unset = Object.fromEntries(hashes.map(id => ["pending." + id, ""]));
    await devices.updateOne({ key, confirmSaves: true }, { $unset: unset, $set: { revision: randomUUID() } });
    return { ok: true };
  }

  async function check(device) {
    const filter = { _id: device._id, revision: device.revision };
    const binding = await store.device(device.key);
    const profile = binding && await store.metadata(binding.profileId);
    if (!profile) { await devices.deleteOne(filter); return; }
    const { cards } = await loadCards(profile.settings, device.topics);
    const known = new Set(device.known);
    const edition = device.confirmSaves ? collect(device, cards) : null;
    if (edition?.added.length) {
      const revision = randomUUID();
      const update = await devices.updateOne(filter, { $set: { pending: edition.pending, known: edition.known, revision } });
      if (!update.modifiedCount) return;
      filter.revision = revision;
    }
    const fresh = edition ? Object.keys(edition.pending) : storyHashes(cards).filter(id => !known.has(id));
    if (!fresh.length) {
      if (device.discovered) await devices.updateOne(filter, { $unset: { discovered: "" } });
      return;
    }
    if (!device.discovered) {
      const discovered = new Date(), batch = randomUUID();
      const update = await devices.updateOne(filter, { $set: { discovered, batch, revision: randomUUID() } });
      if (update.modifiedCount) log("Story push discovered", JSON.stringify({ batch, discovered, stories: fresh.length }));
      return;
    }
    const now = Date.now();
    if (now - device.discovered.getTime() < minute || device.nextSend > new Date(now)) return;
    const batch = device.confirmSaves ? randomUUID() : device.batch ?? randomUUID();
    // Reserve before network I/O. A restart or competing worker cannot double-send.
    const revision = randomUUID();
    const claimed = await devices.updateOne(filter, { $set: { revision, nextSend: new Date(now + cooldown) } });
    if (!claimed.modifiedCount) return;
    const lease = { _id: device._id, revision };
    const payload = { aps: { "content-available": 1 }, batch, discovered: device.discovered.toISOString(),
      sent: new Date(now).toISOString(), stories: fresh.slice(0, 100), total: fresh.length };
    const result = await send(device, payload);
    log("Story push", JSON.stringify({ batch, discovered: payload.discovered, sent: payload.sent,
      resultAt: new Date().toISOString(), stories: fresh.length, status: result.status, reason: result.reason, apnsUniqueId: result.apnsUniqueId }));
    if (result.status === 200) {
      await devices.updateOne({ _id: device._id, key: device.key }, { $set: { lastAccepted: { batch, accepted: new Date().toISOString() } } });
      if (!device.confirmSaves) await devices.updateOne(lease, { $set: { known: remember(device.known, fresh), discovered: null } });
    } else if (result.status === 410 || result.reason === "BadDeviceToken") {
      await devices.deleteOne(lease);
    }
  }
  async function scan() {
    if (running) return;
    running = true;
    try {
      await store.ready();
      await devices.deleteMany({ refreshed: { $lt: new Date(Date.now() - 30 * 86400_000) } });
      for await (const device of devices.find()) {
        try { await check(device); }
        catch (e) { console.warn("Story push scan failed", e.code ?? e.name); }
      }
    } finally { running = false; }
  }
  return { register, scan, acknowledge };
}

export function apnsSender(config) {
  const key = readFileSync(config.TAB1_APNS_KEY_PATH, "utf8");
  let bearer, issued = 0;
  return async (device, payload) => {
    const now = Math.floor(Date.now() / 1000);
    if (!bearer || now - issued >= 45 * 60) {
      bearer = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: config.TAB1_APNS_KEY_ID })
        .setIssuer("SJ8X4DLAN9").setIssuedAt(now).sign(await importPKCS8(key, "ES256"));
      issued = now;
    }
    const host = device.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    const session = connect("https://" + host);
    try {
      return await new Promise((resolve, reject) => {
        session.once("error", reject);
        const req = session.request({ ":method": "POST", ":path": "/3/device/" + device.token,
          authorization: "bearer " + bearer, "apns-topic": "tab1.dev.skynolimit",
          "apns-push-type": "background", "apns-priority": "5", "apns-collapse-id": "story-refresh",
          "apns-expiration": String(now + 3600), "apns-id": payload.batch });
        let status, apnsUniqueId, body = "";
        req.setTimeout(15_000, () => reject(new Error("APNs timeout")));
        req.on("response", headers => {
          status = headers[":status"];
          apnsUniqueId = headers["apns-unique-id"];
        });
        req.on("data", chunk => { body += chunk; });
        req.on("error", reject);
        req.on("end", () => {
          try { resolve({ status, apnsUniqueId, reason: body ? JSON.parse(body).reason : undefined }); }
          catch (error) { reject(error); }
        });
        req.end(JSON.stringify(payload));
      });
    } finally { session.destroy(); }
  };
}
