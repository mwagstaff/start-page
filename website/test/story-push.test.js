import test from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { storyHashes, storyPushService } from "../lib/story-push.js";

test("personalized batches survive restarts, deduplicate and respect cooldown and opt-out",
  { skip: !process.env.TAB1_TEST_MONGO }, async t => {
    const uri = new URL(process.env.TAB1_TEST_MONGO);
    assert.equal(uri.hostname, "127.0.0.1");
    assert.notEqual(uri.port, "27017");
    const mongo = new MongoClient(uri.href);
    const db = mongo.db("tab1_push_test_" + process.pid);
    t.after(async () => { await db.dropDatabase(); await mongo.close(); });
    const store = { db, ready: async () => {}, device: async () => ({ profileId: "test" }),
      metadata: async () => ({ settings: { selected: true } }) };
    const cards = [{ items: [{ link: "https://example.org/old" }] }];
    const sent = [];
    const worker = () => storyPushService(store, async (settings, topics) => {
      assert.equal(settings.selected, true);
      assert.deepEqual(topics, ["science"]);
      return { cards };
    }, async (device, payload) => {
      assert.equal(device.environment, "sandbox");
      sent.push(payload);
      return { status: 200 };
    }, () => {});
    const token = { token: "ab".repeat(32), environment: "sandbox", enabled: true };
    const svc = worker();
    const devices = db.collection("storyPushDevices");
    await svc.register("key", token, ["science"], cards);
    await svc.scan();
    assert.equal((await devices.findOne()).discovered, null);
    cards[0].items.push({ link: "https://example.org/new" }, { link: "https://example.org/another" });
    await svc.scan();
    assert.equal(sent.length, 0);
    await devices.updateOne({}, { $set: { discovered: new Date(Date.now() - 61_000) } });
    await Promise.all([worker().scan(), worker().scan()]);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].aps, { "content-available": 1 });
    assert.deepEqual(sent[0].stories, storyHashes(cards).slice(1));
    const received = await svc.register("key", token, ["science"], cards);
    assert.equal(received.lastStoryPush.batch, sent[0].batch);
    cards[0].items.push({ link: "https://example.org/later" });
    await devices.updateOne({}, { $set: { discovered: new Date(Date.now() - 61_000) } });
    await worker().scan();
    assert.equal(sent.length, 1);
    await svc.register("key", { ...token, enabled: false }, [], cards);
    assert.equal(await devices.countDocuments(), 0);

    // An upgraded phone explicitly confirms article bodies, including ones
    // fetched by polling or already saved when it first negotiates the feature.
    const confirming = { ...token, confirmSaves: true };
    await svc.register("key", token, ["science"], cards);
    const initial = await svc.register("key", confirming, ["science"], cards);
    assert.deepEqual(initial.pendingStories.map(x => x.link), cards[0].items.map(x => x.link));
    await svc.acknowledge("key", storyHashes(cards));
    await svc.scan();
    const edition = [{ items: [{ link: "https://example.org/missed" }, { link: "https://example.org/saved" }] }];
    cards[0].items = edition[0].items;
    const [missed, saved] = storyHashes(cards);
    await svc.scan();
    await devices.updateOne({}, { $set: { discovered: new Date(Date.now() - 61_000) } });
    await svc.scan();
    const first = sent.at(-1);
    assert.deepEqual(first.stories, [missed, saved]);
    cards[0].items = [];
    const polled = await svc.register("key", confirming, ["science"], cards);
    assert.equal(polled.pendingStories.length, 2);
    await svc.acknowledge("another-device", [missed]);
    await svc.acknowledge("key", [saved]);
    await svc.acknowledge("key", [saved]);
    await worker().scan();
    assert.equal(sent.at(-1), first);
    await devices.updateOne({}, { $set: { nextSend: new Date(0) } });
    await Promise.all([worker().scan(), worker().scan()]);
    assert.deepEqual(sent.at(-1).stories, [missed]);
    assert.notEqual(sent.at(-1).batch, first.batch);
    assert.equal(sent.length, 3);
    await svc.acknowledge("key", [missed]);
    await devices.updateOne({}, { $set: { nextSend: new Date(0) } });
    cards[0].items = edition[0].items;
    await worker().scan();
    assert.equal(sent.length, 3);
    assert.deepEqual((await svc.register("key", confirming, ["science"], cards)).pendingStories, []);
  });
