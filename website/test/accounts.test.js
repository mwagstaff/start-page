import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportPKCS8, SignJWT } from "jose";
import { accounts, combineReading } from "../lib/accounts.js";
import { createCompanion } from "../lib/companion.js";
import { mongoProfiles } from "../lib/profile-store.js";

test("first login keeps favourites and explicit account read status", () => {
  assert.deepEqual(
    combineReading(
      { story: { read: false, saved: false } },
      { story: { read: true, saved: true } },
    ),
    { story: { read: false, saved: true } },
  );
});

test(
  "verified provider sessions, QR scopes, first-login choices and deletion",
  { skip: !process.env.TAB1_TEST_MONGO },
  async (t) => {
    // This test uses a dedicated, empty mongod with no production credentials.
    const uri = new URL(process.env.TAB1_TEST_MONGO);
    assert.equal(uri.hostname, "127.0.0.1");
    assert.notEqual(uri.port, "27017");
    const dir = await mkdtemp(join(tmpdir(), "tab1-account-"));
    const store = mongoProfiles(uri.href, dir);
    t.after(async () => {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    });
    assert.equal(await store.db.collection("profiles").countDocuments(), 0);
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const signing = await generateKeyPair("ES256", { extractable: true });
    let appleToken,
      revocations = 0;
    let githubChallenge, githubLogin = "reader";
    const providerFetch = async (url, options) => {
      if (url === "https://github.com/login/oauth/access_token") {
        assert.equal(options.body.get("client_secret"), "test-secret");
        assert.equal(options.body.get("redirect_uri"), "https://tab1.net/auth/github/callback");
        assert.equal(createHash("sha256").update(options.body.get("code_verifier")).digest("base64url"), githubChallenge);
        return Response.json(options.body.get("code") === "valid" ? { access_token: "test-access" } : { error: "bad_verification_code" });
      }
      if (url === "https://api.github.com/user") {
        assert.equal(options.headers.Authorization, "Bearer test-access");
        return Response.json({ id: 123, login: githubLogin });
      }
      if (url.endsWith("/revoke")) {
        revocations++;
        return new Response(null, { status: 200 });
      }
      return Response.json({
        id_token: appleToken,
        refresh_token: "test-refresh",
      });
    };
    const handler = createCompanion({
      directory: dir,
      store,
      cards: async () => ({}),
      account: accounts(
        store,
        {
          TAB1_GITHUB_CLIENT_ID: "test-github",
          TAB1_GITHUB_CLIENT_SECRET: "test-secret",
          TAB1_GOOGLE_WEB_ID: "web",
          TAB1_GOOGLE_IOS_ID: "ios",
          TAB1_APPLE_KEY: await exportPKCS8(signing.privateKey),
          TAB1_APPLE_KEY_ID: "test",
          TAB1_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
        },
        { google: publicKey, apple: publicKey },
        providerFetch,
      ),
    });
    const server = createServer((req, res) =>
      handler(req, res, new URL(req.url, "http://localhost")),
    );
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => server.close(done)));
    async function call(route, data, token, headers = {}) {
      const r = await fetch(
        "http://127.0.0.1:" + server.address().port + "/api/companion/" + route,
        {
          method: data ? "POST" : "GET",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + (token || ""),
            ...headers,
          },
          body: data && JSON.stringify(data),
        },
      );
      return {
        status: r.status,
        cookie: r.headers.get("set-cookie"),
        ...(await r.json()),
      };
    }
    const signed = (nonce, sub) =>
      new SignJWT({ nonce })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://accounts.google.com")
        .setAudience("web")
        .setSubject(sub)
        .setExpirationTime("2m")
        .sign(privateKey);
    async function proof(token, native = true) {
      const headers = native ? { "x-tab1-platform": "ios" } : {};
      const { nonce } = await call(
        "account/challenge",
        { provider: "google" },
        token,
        headers,
      );
      const verify = { nonce, idToken: await signed(nonce, "reader") };
      const result = await call("account/verify", verify, token, headers);
      assert.equal(result.status, 200);
      assert.equal(
        (await call("account/verify", verify, token, headers)).status,
        400,
      );
      return result;
    }
    const settings = { v: 1, tabs: {}, custom: [], density: "compact" };
    const guest = await call("create", { settings });
    const qr = await call("pair", {}, guest.token);
    const paired = await call("claim", {
      code: new URL(qr.payload).searchParams.get("code"),
    });
    const route = "account/finish",
      native = { "x-tab1-platform": "ios" };
    const first = await call(
      route,
      { proof: (await proof(guest.token)).proof, settings },
      guest.token,
      native,
    );
    assert.equal(first.status, 200);
    assert.ok(first.token);
    assert.equal(first.signInProvider, "google");
    assert.deepEqual(
      (await call("account/status", null, paired.token)).linked,
      [],
    );
    assert.equal((await call("account/delete", {}, paired.token)).status, 403);
    assert.equal(
      (await call("sync", null, paired.token)).revision,
      first.revision,
    );
    const other = { ...settings, density: "balanced" };
    const browser = await call("create", { settings: other });
    const preview = await proof(browser.token, false);
    assert.deepEqual(preview.settings, settings);
    assert.equal(
      (
        await call(
          route,
          { proof: preview.proof, settings: other, revision: preview.revision },
          browser.token,
        )
      ).status,
      409,
    );
    const next = await proof(browser.token, false);
    const restored = await call(
      route,
      {
        proof: next.proof,
        settings: other,
        revision: next.revision,
        choice: "account",
      },
      browser.token,
    );
    assert.deepEqual(restored.settings, settings);
    assert.match(restored.cookie, /HttpOnly/);
    assert.equal(restored.token, undefined);
    const cookie = restored.cookie.split(";")[0];
    assert.equal((await call("account/delete", {}, null, { cookie, "x-tab1-account": "previous-account" })).status, 401);
    assert.equal((await call("sync", null, null, { cookie })).status, 401);
    assert.equal(
      (
        await call("sync", null, null, {
          cookie,
          "x-tab1-account": restored.accountTag,
        })
      ).status,
      200,
    );
    async function proveApple(token) {
      const challenge = await call(
        "account/challenge",
        { provider: "apple" },
        token,
        native,
      );
      appleToken = await new SignJWT({ nonce: challenge.nonce })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://appleid.apple.com")
        .setAudience("tab1.dev.skynolimit")
        .setSubject("apple-reader")
        .setExpirationTime("2m")
        .sign(privateKey);
      return await call(
        "account/verify",
        { nonce: challenge.nonce, idToken: appleToken, code: "test-code" },
        token,
        native,
      );
    }
    const appleProof = await proveApple(first.token);
    const linked = await call(
      route,
      { proof: appleProof.proof },
      first.token,
      native,
    );
    assert.deepEqual(linked.linked, ["google", "apple"]);
    assert.deepEqual(linked.settings, settings);
    assert.equal((await call("account/status", null, linked.token, native)).signInProvider, "google");
    const appleGuest = await call("create", { settings });
    const returning = await proveApple(appleGuest.token);
    const appleSession = await call(route, {
      proof: returning.proof, revision: returning.revision, choice: "account", settings
    }, appleGuest.token, native);
    assert.equal(appleSession.accountTag, linked.accountTag);
    assert.equal((await call("account/status", null, appleSession.token, native)).signInProvider, "apple");
    assert.equal((await call("account/status", null, null, { cookie })).signInProvider, "google");
    const browserHeaders = { cookie, "x-tab1-account": restored.accountTag };
    async function githubProof(token, headers, code = "valid") {
      const challenge = await call("account/challenge", { provider: "github" }, token, headers);
      const params = new URL(challenge.authorize).searchParams;
      assert.equal(params.get("scope"), "");
      assert.equal(params.get("state"), challenge.nonce);
      assert.equal(params.get("code_challenge_method"), "S256");
      githubChallenge = params.get("code_challenge");
      const data = { nonce: challenge.nonce, code };
      const verified = await call("account/verify", data, token, headers);
      assert.equal((await call("account/verify", data, token, headers)).status, 400);
      return verified;
    }
    assert.equal((await call("account/challenge", { provider: "github" }, linked.token, native)).status, 503);
    assert.equal((await githubProof(null, browserHeaders, "expired")).status, 401);
    const linkGitHub = await githubProof(null, browserHeaders);
    const withGitHub = await call(route, { proof: linkGitHub.proof }, null, browserHeaders);
    assert.deepEqual(withGitHub.linked, ["google", "apple", "github"]);
    githubLogin = "renamed";
    const githubGuest = await call("create", { settings: other });
    const githubReturn = await githubProof(githubGuest.token, {});
    assert.equal(githubReturn.chooseLayout, true);
    const githubSession = await call(route, {
      proof: githubReturn.proof, revision: githubReturn.revision, choice: "account",
    }, githubGuest.token);
    assert.equal(githubSession.accountTag, restored.accountTag);
    assert.equal(githubSession.signInProvider, "github");
    assert.equal(
      (await call("account/delete", {}, linked.token, native)).status,
      200,
    );
    assert.equal(revocations, 1);
    assert.equal((await call("sync", null, paired.token)).status, 401);
  },
);
