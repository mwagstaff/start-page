import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  importPKCS8,
  CompactEncrypt,
  compactDecrypt,
} from "jose";
import { compareHomepages } from './homepage-comparison.js';
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { secret, digest, problem } from "./profile-store.js";
import { validSettings } from "../public/settings.js";

const appleIssuer = "https://appleid.apple.com";
const keys = {
  apple: createRemoteJWKSet(new URL(appleIssuer + "/auth/keys")),
  google: createRemoteJWKSet(
    new URL("https://www.googleapis.com/oauth2/v3/certs"),
  ),
};
const cookie = "__Host-tab1";
const duration = 90 * 86400;
const providers = ["google", "apple", "github"];
const fresh = (date) => date && Date.now() - date.getTime() < 5 * 60000;
const until = (seconds) => new Date(Date.now() + seconds * 1000);

export function combineReading(account, guest) {
  const merged = { ...account };
  for (const [link, value] of Object.entries(guest)) {
    const existing = account[link];
    merged[link] = existing
      ? { ...value, ...existing, saved: existing.saved || value.saved }
      : value;
  }
  return merged;
}

// The native reader materialises the default homepage even before a person edits it.
export function customised(settings, defaults) {
  const value = validSettings(settings);
  if (!value) return false;
  const { v, tabs, custom, profile, onboarded, welcome, ...options } = value;
  return (
    Object.keys(tabs).length > 0 ||
    custom.length > 0 ||
    Object.keys(options).length > 0 ||
    (!!profile && !isDeepStrictEqual(profile, defaults))
  );
}

export function accounts(
  store,
  config,
  providerKeys = keys,
  providerFetch = fetch,
) {
  const { db } = store;
  const profiles = db.collection("profiles"),
    challenges = db.collection("challenges");
  const encryption = Buffer.from(config.TAB1_TOKEN_KEY || "", "base64");
  const appleReady = !!(
    config.TAB1_APPLE_KEY &&
    config.TAB1_APPLE_KEY_ID &&
    encryption.length === 32
  );
  const origin = config.TAB1_PUBLIC_URL || "https://tab1.net";
  const bundle = "tab1.dev.skynolimit";
  const githubCallback = new URL("/auth/github/callback", origin).href;
  const clients = (native) => ({
    github: !native && config.TAB1_GITHUB_CLIENT_SECRET && config.TAB1_GITHUB_CLIENT_ID,
    google:
      config.TAB1_GOOGLE_WEB_ID && (!native || config.TAB1_GOOGLE_IOS_ID)
        ? config.TAB1_GOOGLE_WEB_ID
        : null,
    apple:
      appleReady && (native || config.TAB1_APPLE_WEB_ENABLED === "true")
        ? native
          ? bundle
          : config.TAB1_APPLE_SERVICES_ID
        : null,
  });
  async function githubIdentity(code, verifier) {
    if (typeof code !== "string" || !code || !verifier)
      throw problem(401, "GitHub sign-in could not be verified.");
    const response = await providerFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.TAB1_GITHUB_CLIENT_ID,
        client_secret: config.TAB1_GITHUB_CLIENT_SECRET,
        redirect_uri: githubCallback,
        code_verifier: verifier,
        code,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const token = response.ok && (await response.json()).access_token;
    if (!token) throw problem(401, "GitHub sign-in expired. Please try again.");
    const profile = await providerFetch("https://api.github.com/user", {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "tab1.net" },
      signal: AbortSignal.timeout(10000),
    });
    const user = profile.ok && await profile.json();
    if (!Number.isSafeInteger(user.id) || user.id <= 0)
      throw problem(401, "GitHub sign-in could not be verified.");
    return { subject: String(user.id), initial: user.login?.match(/^[a-z0-9]/i)?.[0].toUpperCase() };
  }
  async function appleRequest(endpoint, clientId, fields) {
    const signer = await importPKCS8(
      config.TAB1_APPLE_KEY.replaceAll("\\n", "\n"),
      "ES256",
    );
    const clientSecret = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.TAB1_APPLE_KEY_ID })
      .setIssuer(config.TAB1_APPLE_TEAM || "SJ8X4DLAN9")
      .setSubject(clientId)
      .setAudience(appleIssuer)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signer);
    const response = await providerFetch(appleIssuer + "/auth/" + endpoint, {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        ...fields,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw problem(
        400,
        "Apple could not complete the request. Please sign in again.",
      );
    return endpoint === "token" ? response.json() : null;
  }
  // Keep the deletion intent durable across restarts and provider outages.
  const deletions = db.collection("accountDeletions");
  async function erase(id) {
    await profiles.deleteOne({ _id: id });
    await Promise.all([
      db.collection("reading").deleteMany({ profileId: id }),
      db.collection("devices").deleteMany({ profileId: id }),
      db.collection("pairs").deleteMany({ id }),
      challenges.deleteMany({ existing: id }),
    ]);
  }
  let draining = false;
  async function finishDeletions() {
    if (draining) return;
    draining = true;
    try {
      for await (const entry of deletions.find()) {
        await erase(entry._id);
        try {
          for (const grant of Object.values(entry.grants)) {
            const { plaintext } = await compactDecrypt(grant.token, encryption);
            await appleRequest("revoke", grant.clientId, {
              token: Buffer.from(plaintext).toString(),
              token_type_hint: "refresh_token",
            });
          }
          await deletions.deleteOne({ _id: entry._id });
        } catch {
          console.warn("Apple account revocation is pending");
        }
      }
    } finally {
      draining = false;
    }
  }
  const retry = () =>
    finishDeletions().catch(() =>
      console.warn("Account deletion cleanup will retry"),
    );
  setInterval(retry, 60000).unref();
  async function session(id, native, res, signInProvider) {
    const token = secret();
    await store.addDevice(digest(token), id, {
      owner: true,
      signInProvider,
      authenticated: new Date(),
      expires: until(duration),
    });
    if (!native)
      res.setHeader(
        "Set-Cookie",
        cookie +
          "=" +
          token +
          "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" +
          duration,
      );
    return native ? { token } : {};
  }
  return async ({ route, req, res, device, key, body, send }) => {
    const native = req.headers["x-tab1-platform"] === "ios";
    if (native && req.headers.cookie?.includes(cookie + "="))
      throw problem(403, "Use the browser sign-in flow.");
    const ids = clients(native);
    const owner =
      device?.owner && (await profiles.findOne({ _id: device.profileId }));
    const linked = owner ? providers.filter((p) => owner[p]) : [];
    const currentProvider = linked.includes(device?.signInProvider) ? device.signInProvider
      : linked.length === 1 ? linked[0] : null;
    if (route === "status" && req.method === "GET") {
      send(res, 200, {
        accountTag: owner ? digest(owner._id) : null,
        initial: owner?.initial ?? null,
        signInProvider: currentProvider,
        providers: providers.filter((p) => ids[p]),
        linked,
        googleClientId: ids.google,
        googleIOSId: config.TAB1_GOOGLE_IOS_ID,
        appleClientId: ids.apple,
        origin,
      });
      return;
    }
    if (!native && owner && req.headers["x-tab1-account"] !== digest(owner._id))
      throw problem(401, "Account changed. Reopen Settings.");
    if (
      req.method !== "POST" ||
      !req.headers["content-type"]?.startsWith("application/json")
    )
      throw problem(405, "Use a JSON POST request.");
    const b = await body(req);
    if (route === "signout") {
      if (device?.owner) await store.unlink(key);
      res.setHeader(
        "Set-Cookie",
        cookie + "=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
      );
      send(res, 200, { ok: true });
      return;
    }
    if (route === "challenge") {
      if (!providers.includes(b.provider) || !ids[b.provider])
        throw problem(503, "This provider is not configured.");
      if (!device) throw problem(401, "Connect this device before signing in.");
      if (
        (await challenges.countDocuments(
          { key, expires: { $gt: new Date() } },
          { limit: 30 },
        )) >= 30
      )
        throw problem(429, "Please wait a few minutes before trying again.");
      const nonce = secret();
      const verifier = b.provider === "github" ? secret() : null;
      await challenges.insertOne({
        ...(verifier && { verifier }),
        _id: digest(nonce),
        stage: "verify",
        key,
        provider: b.provider,
        native,
        expires: until(300),
      });
      if (verifier) {
        const authorize = new URL("https://github.com/login/oauth/authorize");
        authorize.search = new URLSearchParams({
          client_id: ids.github, redirect_uri: githubCallback, state: nonce, scope: "",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
        }).toString();
        send(res, 200, { nonce, authorize: authorize.href });
      } else send(res, 200, { nonce });
      return;
    }
    if (route === "verify") {
      const c = await challenges.findOneAndDelete({
        _id: digest(String(b.nonce)),
        key,
        native,
        stage: "verify",
        expires: { $gt: new Date() },
      });
      if (!c) throw problem(400, "Sign-in expired. Please try again.");
      const provider = c.provider,
        audience = ids[provider];
      if (!audience) throw problem(503, "Sign-in is unavailable.");
      const options = {
        issuer:
          provider === "apple"
            ? appleIssuer
            : ["https://accounts.google.com", "accounts.google.com"],
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub", "nonce"],
      };
      let subject, initial;
      if (provider === "github") {
        ({ subject, initial } = await githubIdentity(b.code, c.verifier));
      } else {
        try {
          const { payload } = await jwtVerify(
            b.idToken,
            providerKeys[provider],
            options,
          );
          if (
            payload.nonce !== b.nonce ||
            typeof payload.sub !== "string" ||
            !payload.sub
          )
            throw Error();
          subject = payload.sub;
          if (provider === "google") {
            const label = [payload.given_name, payload.name, payload.email].find(v => typeof v === 'string' && v.trim());
            initial = label?.trim().match(/^[\p{L}\p{N}]/u)?.[0].toLocaleUpperCase();
          }
        } catch {
          throw problem(401, "Sign-in could not be verified.");
        }
      }
      let grant;
      if (provider === "apple") {
        const tokens = await appleRequest("token", audience, {
          grant_type: "authorization_code",
          code: String(b.code),
          ...(!native && { redirect_uri: origin + "/settings" }),
        });
        const { payload } = await jwtVerify(
          tokens.id_token,
          providerKeys.apple,
          options,
        );
        if (
          payload.sub !== subject ||
          payload.nonce !== b.nonce ||
          !tokens.refresh_token
        )
          throw problem(401, "Apple credentials did not match.");
        grant = await new CompactEncrypt(Buffer.from(tokens.refresh_token))
          .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
          .encrypt(encryption);
      }
      const existing = await profiles.findOne({ [provider]: subject });
      if (owner && existing && existing._id !== owner._id)
        throw problem(409, "This sign-in belongs to a different tab1 account.");
      if (owner && !existing && !fresh(device.authenticated))
        throw problem(
          403,
          "Verify a linked provider first, then add the other provider.",
        );
      if (owner && owner[provider] && owner[provider] !== subject)
        throw problem(409, "A different identity is already linked.");
      const proof = secret();
      await challenges.insertOne({
        _id: digest(proof),
        stage: "finish",
        key,
        native,
        provider,
        subject,
        ...(initial && { initial }),
        audience,
        grant,
        existing: existing?._id,
        expires: until(300),
      });
      const local =
        validSettings(b.settings) ||
        (device && (await store.metadata(device.profileId))?.settings);
      const localCustom = customised(local, config.defaultHomepage);
      const remoteCustom = customised(
        existing?.settings,
        config.defaultHomepage,
      );
      const comparison = config.catalogue && existing ? compareHomepages(local, existing.settings, config) : null;
      const chooseLayout =
        !owner &&
        localCustom &&
        remoteCustom &&
        (comparison ? comparison.local.length > 0 : !isDeepStrictEqual(local, existing.settings));
      send(res, 200, {
        proof,
        chooseLayout,
        ...(chooseLayout && comparison && { comparison }),
        suggestedChoice: localCustom && !remoteCustom ? "local" : "account",
        settings: existing?.settings ?? null,
        revision: existing?.revision,
        returning: !!existing,
      });
      return;
    }
    if (route === "finish") {
      const c = await challenges.findOneAndDelete({
        _id: digest(String(b.proof)),
        key,
        native,
        stage: "finish",
        expires: { $gt: new Date() },
      });
      if (!c) throw problem(400, "Sign-in expired. Try again.");
      const guest =
        device && !owner ? await store.profile(device.profileId) : null;
      // A new account can adopt an unowned guest profile, preserving existing QR links.
      const unowned =
        guest &&
        !c.existing &&
        (await profiles.findOne({
          _id: device.profileId,
          apple: { $exists: false },
          google: { $exists: false },
          github: { $exists: false },
        }));
      const id = owner?._id || c.existing || unowned?._id || secret();
      const existing = await profiles.findOne({ _id: id });
      if ((owner || c.existing) && !existing)
        throw problem(409, "Account changed. Try again.");
      const grant = c.grant
        ? {
            ["grants." + (native ? "ios" : "web")]: {
              clientId: c.audience,
              token: c.grant,
            },
          }
        : {};
      const local = validSettings(b.settings) || guest?.settings || null;
      if (
        c.existing &&
        !owner &&
        local &&
        existing.settings &&
        !isDeepStrictEqual(local, existing.settings) &&
        !["local", "account"].includes(b.choice)
      )
        throw problem(409, "Choose which homepage to keep.");
      if (c.existing && !owner && existing.revision !== b.revision)
        throw problem(
          409,
          "The account changed. Sign in again to review its layout.",
        );
      try {
        const filter = {
          _id: id,
          $or: [
            { [c.provider]: c.subject },
            { [c.provider]: { $exists: false } },
          ],
        };
        if (unowned)
          Object.assign(filter, {
            apple: { $exists: false },
            google: { $exists: false },
            github: { $exists: false },
          });
        const result = await profiles.updateOne(
          filter,
          {
            $set: { [c.provider]: c.subject, ...(c.initial && { initial:c.initial }), ...grant },
            $setOnInsert: { settings: local, revision: 0 },
          },
          { upsert: !existing },
        );
        if (!result.matchedCount && !result.upsertedCount)
          throw problem(409, "Account changed. Try again.");
      } catch (e) {
        if (e.code === 11000)
          throw problem(409, "This identity is already linked. Sign in again.");
        throw e;
      }
      let p = await store.profile(id);
      if (!owner) {
        if (c.existing && p.revision !== b.revision)
          throw problem(409, "The layout changed. Please sign in again.");
        const settings =
          unowned || b.choice === "local" ? local : p.settings || local;
        const reading = combineReading(p.reading, guest?.reading || {});
        if (
          !(await store.update(id, p.revision, { settings, reading }, !!guest))
        )
          throw problem(409, "Settings changed. Please sign in again.");
        p = await store.profile(id);
      }
      const signInProvider = owner ? currentProvider ?? c.provider : c.provider;
      const credentials = await session(id, native, res, signInProvider);
      if (device) await store.unlink(key);
      send(res, 200, {
        ...p,
        ...credentials,
        signInProvider,
        accountTag: digest(id),
        linked: providers.filter((k) => k === c.provider || existing?.[k]),
      });
      return;
    }
    if (route === "delete") {
      if (!owner || !fresh(device.authenticated))
        throw problem(
          403,
          "Verify a linked provider, then delete the account.",
        );
      await deletions.updateOne(
        { _id: owner._id },
        { $setOnInsert: { grants: owner.grants || {} } },
        { upsert: true },
      );
      await erase(owner._id);
      await retry();
      res.setHeader(
        "Set-Cookie",
        cookie + "=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
      );
      send(res, 200, { ok: true });
      return;
    }
    throw problem(404, "Unknown account operation.");
  };
}
