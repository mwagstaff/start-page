// Roll back a guest-only cutover with sync writes paused. Refuse to flatten provider accounts.
import { writeFile } from 'node:fs/promises';
import { mongoProfiles } from '../lib/profile-store.js';
import { readFile } from 'node:fs/promises';

const [destination, configPath] = process.argv.slice(2);
const uri = process.env.TAB1_CHECK_URI || JSON.parse(await readFile(configPath,'utf8')).TAB1_MONGO_URI;
const store = mongoProfiles(uri);
try {
  if (!await store.db.collection('migrations').findOne({_id:'profiles-json-v1'}))
    throw Error('Expected an already migrated tab1 database.');
  if (await store.db.collection('profiles').findOne({$or:[{apple:{$exists:true}},{google:{$exists:true}},{github:{$exists:true}}]}) ||
      await store.db.collection('accountDeletions').findOne({}))
    throw Error('Provider accounts require the Mongo-backed service.');
  const data = { profiles:{}, devices:{}, pairs:{} };
  for await (const p of store.db.collection('profiles').find({}, {projection:{_id:1}}))
    data.profiles[p._id] = await store.profile(p._id);
  for await (const device of store.db.collection('devices').find())
    data.devices[device._id] = device.profileId;
  for await (const pair of store.db.collection('pairs').find({expires:{$gt:new Date()}}))
    data.pairs[pair._id] = { id:pair.id, expires:pair.expires.getTime() };
  await writeFile(destination, JSON.stringify(data), {mode:0o600,flag:'wx'});
  console.log('Created guest rollback file.');
} finally { await store.close(); }
