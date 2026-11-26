import {
  accountHeaders,
  adoptAccount,
  prepareAccount,
  resumeSync,
} from "./companion.js";
import { currentProfile } from "./page.js";
import { loadSettings } from "./settings.js";

const scripts = new Map();
function sdk(url) {
  if (!scripts.has(url))
    scripts.set(
      url,
      new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.onload = resolve;
        script.onerror = () => {
          scripts.delete(url);
          script.remove();
          reject(Error("Sign-in could not load. Try again."));
        };
        document.head.append(script);
      }),
    );
  return scripts.get(url);
}
async function api(route, data) {
  const r = await fetch("/api/companion/account/" + route, {
    method: data ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...accountHeaders() },
    body: data && JSON.stringify(data),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || "Account unavailable");
  return value;
}
function button(container, label, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = action;
  container.append(b);
  return b;
}
const providerNames = { google: "Google", apple: "Apple", github: "GitHub" };
const providerName = id => providerNames[id] ?? id;
const githubStateKey = "tab1:github-state";
let githubReturn;
if (location.pathname === "/settings" && location.hash.startsWith("#github=")) {
  githubReturn = new URLSearchParams(location.hash.slice(8));
  history.replaceState(history.state, "", "/settings");
}

async function signOut() {
  try {
    await prepareAccount();
    await api('signout', {});
    adoptAccount(null);
  } catch (error) {
    resumeSync();
    throw error;
  }
}

export async function initAccountMenu(openSettings) {
  const menu = document.querySelector('.account-menu');
  if (!menu) return;
  const toggle = menu.querySelector('.account-avatar');
  const panel = menu.querySelector('.account-actions');
  const openAccount = async () => {
    await openSettings();
    document.querySelector('[data-account]')?.focus();
  };
  const close = () => { if (panel.classList.contains('signin-menu')) resumeSync(); panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  toggle.setAttribute('aria-controls', panel.id);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.onclick = () => {
    if (!panel.hidden) { close(); return; }
    panel.hidden = false;
    if (panel.classList.contains('signin-menu')) renderAccount(panel);
    panel.focus();
  };
  panel.tabIndex = -1;
  menu.addEventListener('focusout', event => {
    if (event.relatedTarget && !menu.contains(event.relatedTarget)) close();
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !panel.hidden) close(); });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); close(); toggle.focus(); }
  });
  try {
    const status = await api('status');
    if (!status.accountTag) { panel.classList.add('signin-menu'); return; }
    menu.classList.add('signed-in');
    toggle.title = 'Account menu';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-controls', panel.id);
    toggle.setAttribute('aria-expanded', 'false');
    const provider = status.signInProvider;
    if (Object.hasOwn(providerNames, provider)) {
      toggle.dataset.provider = provider;
      toggle.title = 'Account menu · Signed in with ' + providerName(provider);
      toggle.setAttribute('aria-description', 'Signed in with ' + providerName(provider));
    }
    if (provider === 'apple' && !status.initial) {
      const mark = document.createElement('img');
      mark.src = '/static/apple-profile.svg';
      mark.alt = '';
      mark.width = mark.height = 21;
      toggle.replaceChildren(mark);
    } else {
      toggle.textContent = status.initial || (provider === 'google' ? 'G' : '✓');
    }
    toggle.onclick = () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) panel.querySelector('button').focus();
    };
    menu.querySelector('[data-account-settings]').onclick = async () => {
      close();
      await openAccount();
    };
    menu.querySelector('[data-signout]').onclick = async () => {
      try { await signOut(); } catch (e) { menu.querySelector('[role=status]').textContent = e.message; }
    };
  } catch { panel.classList.add('signin-menu'); }
  finally { menu.hidden = false; }
}

export async function renderAccount(panel) {
  resumeSync();
  panel.closest("dialog")?.addEventListener("close",resumeSync,{once:true});
  panel.replaceChildren();
  const title = document.createElement("h2");
  const compact = panel.classList.contains("signin-menu");
  title.textContent = compact ? "Sign in or create an account" : "Account";
  panel.append(title);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  panel.append(status);
  const controls = document.createElement("div");
  controls.className = "settings-buttons";
  panel.append(controls);
  const active = () => panel.contains(controls) && (!compact || !panel.hidden);
  const fail = (e) => {
    resumeSync();
    status.textContent = e.message;
  };
  try {
    const config = await api("status");
    if (!active()) return;
    const marker = JSON.parse(
      localStorage.getItem("tab1:companion") || "null",
    )?.accountTag;
    if (marker !== config.accountTag && (marker || config.accountTag)) {
      status.textContent =
        "This browser session changed. Reconnect to load the current account.";
      button(controls, "Reconnect", async () => {
        try {
          if (!config.accountTag) {
            await api("signout", {});
            adoptAccount(null);
            return;
          }
          const r = await fetch("/api/companion/sync", {
            headers: { "X-Tab1-Account": config.accountTag },
          });
          if (!r.ok) throw Error("Unable to reconnect. Try again.");
          adoptAccount({ ...(await r.json()), accountTag: config.accountTag });
        } catch (e) {
          fail(e);
        }
      });
      return;
    }
    status.textContent = config.linked.length
      ? "Signed in with " +
        new Intl.ListFormat("en-GB").format(config.linked.map(providerName)) +
        ". Your homepage and reading activity sync across devices."
      : compact ? "" : "Sign in or create an account to sync your homepage, favourites and reading activity.";
    if (!config.providers.length)
      status.textContent += " Account sign-in is currently unavailable.";
    const verify = async (nonce, idToken, code, destination) => {
      if (!active()) return;
      const saved = loadSettings();
      // Capture regional suggestions too, so a first sign-in can be restored abroad.
      const settings = saved?.tabs?.home || saved?.profile ? saved :
        { v: 1, tabs: {}, custom: [], ...saved, profile: currentProfile() };
      const proof = await api("verify", {
        nonce,
        idToken,
        code,
        settings,
      });
      const finish = async (choice) => {
        try {
          adoptAccount(
            await api("finish", {
              proof: proof.proof,
              revision: proof.revision,
              settings,
              choice,
            }), destination,
          );
        } catch (e) {
          fail(e);
        }
      };
      if (!active()) return;
      if (proof.chooseLayout) {
        controls.replaceChildren();
        status.textContent =
          "Choose the homepage for all your devices. Favourites from both will be kept.";
        for (const [choice, label] of [['account', 'Use saved homepage'], ['local', 'Use this device’s homepage']]) {
          const option = document.createElement('div');
          option.className = 'homepage-choice';
          const heading = document.createElement('strong');
          heading.textContent = choice === 'account' ? 'Saved homepage' : 'This device';
          option.append(heading);
          for (const line of proof.comparison?.[choice] ?? []) {
            const detail = document.createElement('p');
            detail.textContent = line;
            option.append(detail);
          }
          button(option, label, () => finish(choice));
          controls.append(option);
        }
        button(controls, "Cancel", () => {
          resumeSync();
          renderAccount(panel);
        });
      } else await finish(proof.suggestedChoice);
    };
    if (!compact && githubReturn) {
      const result = githubReturn;
      githubReturn = null;
      const pending = JSON.parse(sessionStorage.getItem(githubStateKey) || "null");
      sessionStorage.removeItem(githubStateKey);
      try {
        if (!pending?.nonce || result.get("state") !== pending.nonce)
          throw Error("GitHub sign-in expired. Please try again.");
        if (!result.get("code") || result.has("error"))
          throw Error("GitHub sign-in was cancelled. You can try again.");
        await prepareAccount();
        await verify(pending.nonce, undefined, result.get("code"), pending.compact ? "/" : "/settings");
        return;
      } catch (error) {
        fail(error);
      }
    }
    for (const provider of config.providers) {
      const name = providerName(provider);
      button(
        controls,
        (config.linked.includes(provider)
          ? "Verify with "
          : config.linked.length
            ? "Link "
            : "Continue with ") + name,
        async () => {
          try {
            await prepareAccount();
            if (!active()) { resumeSync(); return; }
            const { nonce, authorize } = await api("challenge", { provider });
            if (provider === "github") {
              sessionStorage.setItem(githubStateKey, JSON.stringify({ nonce, compact }));
              location.assign(authorize);
              return;
            }
            const destination = compact ? "/" : "/settings";
            if (provider === "google") {
              await sdk("https://accounts.google.com/gsi/client");
              google.accounts.id.initialize({
                client_id: config.googleClientId,
                nonce,
                callback: (r) => verify(nonce, r.credential, undefined, destination).catch(fail),
              });
              controls.replaceChildren();
              const host = document.createElement("div");
              host.className = "google-signin";
              controls.append(host);
              google.accounts.id.renderButton(host, {
                theme: matchMedia("(prefers-color-scheme: dark)").matches ? "filled_black" : "outline",
                shape: "pill",
                width: 216,
                size: "large",
              });
              button(controls, "Cancel", () => {
                resumeSync();
                renderAccount(panel);
              });
            } else {
              await sdk(
                "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js",
              );
              AppleID.auth.init({
                clientId: config.appleClientId,
                redirectURI: config.origin + "/settings",
                nonce,
                state: nonce,
                usePopup: true,
              });
              controls.replaceChildren();
              button(controls, "Continue with Apple", async () => {
                try {
                  const r = await AppleID.auth.signIn();
                  if (r.authorization.state !== nonce)
                    throw Error("Please start sign-in again.");
                  await verify(nonce, r.authorization.id_token, r.authorization.code, destination);
                } catch (e) {
                  fail(e);
                }
              });
              button(controls, "Cancel", () => {
                resumeSync();
                renderAccount(panel);
              });
            }
          } catch (e) {
            fail(e);
          }
        },
      );
    }
    if (config.linked.length)
      for (const [label, route] of [
        ["Sign out", "signout"],
        ["Delete account", "delete"],
      ])
        button(controls, label, async () => {
          if (
            route === "delete" &&
            !confirm(
              "Permanently delete your tab1 account, synced homepage and reading activity from all devices?",
            )
          )
            return;
          try {
            if (route === "signout") { await signOut(); return; }
            await prepareAccount();
            await api(route, {});
            adoptAccount(null);
          } catch (e) {
            fail(e);
          }
        });
  } catch (e) {
    fail(e);
  }
}
