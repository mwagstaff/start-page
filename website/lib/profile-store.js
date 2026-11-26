import { MongoClient } from "mongodb";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const problem = (status, message) =>
  Object.assign(new Error(message), { status });

function legacy(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, "profiles.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { profiles: {}, devices: {}, pairs: {} };
  }
}

// Keep the file-backed companion available to local development and old fixtures.
export function fileProfiles(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const data = legacy(directory);
  const path = join(directory, "profiles.json");
  function save() {
    writeFileSync(path + ".tmp", JSON.stringify(data), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  return {
    create(id, profile) {
      if (Object.keys(data.profiles).length >= 1000)
        throw problem(429, "Profile limit reached");
      data.profiles[id] = profile;
      save();
    },
    profile: (id) => structuredClone(data.profiles[id]),
    update(id, previous, profile) {
      if (data.profiles[id]?.revision !== previous) return false;
      data.profiles[id] = profile;
      save();
      return true;
    },
    device: (key) => data.devices[key] && { profileId: data.devices[key] },
    addDevice(key, id) {
      data.devices[key] = id;
      save();
    },
    unlink(key) {
      delete data.devices[key];
      save();
    },
    pair(key, id, expires) {
      for (const [k, p] of Object.entries(data.pairs))
        if (p.expires <= Date.now()) delete data.pairs[k];
      data.pairs[key] = { id, expires };
      save();
    },
    claim(key) {
      const p = data.pairs[key];
      delete data.pairs[key];
      save();
      return p?.expires > Date.now() ? p.id : null;
    },
  };
}

export function mongoProfiles(uri, directory) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 4000,
    maxPoolSize: 8,
  });
  const db = client.db("tab1");
  const profiles = db.collection("profiles"),
    devices = db.collection("devices");
  const pairs = db.collection("pairs"),
    stories = db.collection("reading");
  let opening;
  async function initialize() {
    await Promise.all([
      pairs.createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
      devices.createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
      db
        .collection("challenges")
        .createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
      stories.createIndex({ profileId: 1, snapshot: 1 }),
      ...["apple", "google", "github"].map((p) =>
        profiles.createIndex({ [p]: 1 }, { unique: true, sparse: true }),
      ),
    ]);
    const migrations = db.collection("migrations");
    if (await migrations.findOne({ _id: "profiles-json-v1" })) return;
    const old = legacy(directory);
    for (const [id, p] of Object.entries(old.profiles)) {
      const rows = Object.entries(p.reading || {}).map(([url, value]) => ({
        profileId: id,
        snapshot: "legacy",
        url,
        value,
      }));
      if (rows.length)
        await stories.bulkWrite(
          rows.map((row) => ({
            updateOne: {
              filter: { _id: digest(id + "\n" + row.url) },
              update: { $setOnInsert: row },
              upsert: true,
            },
          })),
        );
      await profiles.updateOne(
        { _id: id },
        {
          $setOnInsert: {
            settings: p.settings,
            revision: p.revision,
            snapshot: "legacy",
          },
        },
        { upsert: true },
      );
    }
    for (const [key, id] of Object.entries(old.devices))
      await devices.updateOne(
        { _id: key },
        { $setOnInsert: { profileId: id } },
        { upsert: true },
      );
    for (const [key, p] of Object.entries(old.pairs))
      if (p.expires > Date.now())
        await pairs.updateOne(
          { _id: key },
          { $setOnInsert: { id: p.id, expires: new Date(p.expires) } },
          { upsert: true },
        );
    await migrations.updateOne(
      { _id: "profiles-json-v1" },
      { $setOnInsert: { at: new Date() } },
      { upsert: true },
    );
  }
  return {
    db,
    close: () => client.close(),
    ready() {
      return (opening ??= initialize().catch((error) => {
        opening = null;
        throw error;
      }));
    },
    create: (id, p) =>
      profiles.insertOne({ _id: id, settings: p.settings, revision: 0 }),
    metadata: (id) =>
      profiles.findOne({ _id: id }, { projection: { settings: 1 } }),
    async profile(id) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const p = await profiles.findOne({ _id: id });
        if (!p) return null;
        const rows = p.snapshot
          ? await stories
              .find({ profileId: id, snapshot: p.snapshot })
              .toArray()
          : [];
        if (
          await profiles.findOne(
            { _id: id, revision: p.revision },
            { projection: { _id: 1 } },
          )
        )
          return {
            revision: p.revision,
            settings: p.settings,
            reading: Object.fromEntries(
              rows.map((row) => [row.url, row.value]),
            ),
          };
      }
      throw problem(409, "Settings changed. Try again.");
    },
    async update(id, previous, p, changedReading = true) {
      const before = await profiles.findOne({ _id: id, revision: previous });
      if (!before) return false;
      const fields = { revision: previous + 1, settings: p.settings };
      if (changedReading) {
        fields.snapshot = secret();
        const rows = Object.entries(p.reading).map(([url, value]) => ({
          profileId: id,
          snapshot: fields.snapshot,
          url,
          value,
        }));
        if (rows.length) await stories.insertMany(rows);
      }
      const result = await profiles.updateOne(
        { _id: id, revision: previous },
        { $set: fields },
      );
      const obsolete = result.matchedCount ? before.snapshot : fields.snapshot;
      if (changedReading && obsolete)
        await stories.deleteMany({ profileId: id, snapshot: obsolete });
      return !!result.matchedCount;
    },
    device: (key) =>
      devices.findOne({
        _id: key,
        $or: [
          { expires: { $exists: false } },
          { expires: { $gt: new Date() } },
        ],
      }),
    addDevice: (key, profileId, extras = {}) =>
      devices.insertOne({ _id: key, profileId, ...extras }),
    unlink: (key) => devices.deleteOne({ _id: key }),
    pair: (key, id, expires) =>
      pairs.insertOne({ _id: key, id, expires: new Date(expires) }),
    async claim(key) {
      return (
        await pairs.findOneAndDelete({ _id: key, expires: { $gt: new Date() } })
      )?.id;
    },
  };
}
