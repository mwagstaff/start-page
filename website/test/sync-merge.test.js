import test from "node:test";
import assert from "node:assert/strict";
import { mergeSettings } from "../public/sync-merge.js";
test("offline preference changes preserve unrelated remote changes inside the profile", () => {
  const base = {
    profile: { topics: ["top"], outlets: ["bbc"], pictures: true },
    temperature: "C",
  };
  const local = { ...base, profile: { ...base.profile, pictures: false } };
  const remote = {
    profile: {
      topics: ["top", "tech"],
      outlets: ["bbc", "guardian"],
      pictures: true,
    },
    temperature: "F",
  };
  assert.deepEqual(mergeSettings(base, local, remote), {
    profile: {
      topics: ["top", "tech"],
      outlets: ["bbc", "guardian"],
      pictures: false,
    },
    temperature: "F",
  });
});
test("local deletion and explicit false propagate", () =>
  assert.deepEqual(
    mergeSettings(
      { density: "compact", fill: true },
      { fill: false },
      { density: "compact", fill: true, temperature: "F" },
    ),
    { fill: false, temperature: "F" },
  ));
