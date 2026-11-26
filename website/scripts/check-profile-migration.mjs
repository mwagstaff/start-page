import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mongoProfiles } from "../lib/profile-store.js";

const [directory, configPath] = process.argv.slice(2);
const uri =
  process.env.TAB1_CHECK_URI ||
  JSON.parse(await readFile(configPath, "utf8")).TAB1_MONGO_URI;
const store = mongoProfiles(uri, directory);
try {
  await store.ready();
  const old = JSON.parse(
    await readFile(join(directory, "profiles.json"), "utf8"),
  );
  for (const [id, profile] of Object.entries(old.profiles)) {
    assert.ok(
      isDeepStrictEqual(await store.profile(id), profile),
      "A migrated profile differs",
    );
  }
  for (const [key, id] of Object.entries(old.devices))
    assert.ok(
      (await store.device(key))?.profileId === id,
      "Device mapping differs",
    );
  for (const [key, pair] of Object.entries(old.pairs))
    if (pair.expires > Date.now())
      assert.ok(
        (await store.db.collection("pairs").findOne({ _id: key }))?.id ===
          pair.id,
        "Pair mapping differs",
      );
  console.log(
    JSON.stringify({
      profiles: Object.keys(old.profiles).length,
      devices: Object.keys(old.devices).length,
      reading: Object.values(old.profiles).reduce(
        (n, p) => n + Object.keys(p.reading).length,
        0,
      ),
    }),
  );
} finally {
  await store.close();
}
