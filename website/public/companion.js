import { mergeSettings } from "./sync-merge.js";
import { loadSettings } from "./settings.js";
import { replaceSettings } from "./page.js";
const key = "tab1:companion";
let connection = JSON.parse(localStorage.getItem(key) || "null"),
  busy = false;
const save = () => localStorage.setItem(key, JSON.stringify(connection));
async function request(route, body) {
  const response = await fetch("/api/companion/" + route, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(connection?.accountTag ? { "X-Tab1-Account": connection.accountTag } : {}),
      ...(connection?.token ? { Authorization: "Bearer " + connection.token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Sync conflict; try again");
  return value;
}
const button = document.createElement("button");
button.textContent = "Connect iPhone";
button.className = "companion-connect";
button.style.cssText =
  "position:fixed;bottom:12px;left:12px;z-index:50;padding:8px 14px;border-radius:20px;border:1px solid #888;background:Canvas;color:CanvasText;font:inherit";
// Pairing is for desktop browsers: on an iPhone or iPad you'd use the app itself, and an Android
// phone can't run it. iPadOS Safari reports itself as a Mac, so a touch "Mac" counts as an iPad.
// A browser that's already connected keeps syncing either way.
const mobile =
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (!mobile) document.body.append(button);
button.onclick = async () => {
  const dialog = document.createElement("dialog");
  dialog.className = "customise companion-dialog";
  dialog.setAttribute("aria-labelledby", "companion-title");
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  const title = document.createElement("h2");
  title.id = "companion-title";
  title.textContent = "Connect tab1 for iPhone";
  dialog.append(title);
  const status = document.createElement("p");
  status.textContent = "Preparing your connection…";
  dialog.append(status);
  const close = document.createElement("button");
  close.textContent = "Close";
  close.className = "primary";
  close.onclick = () => dialog.close();
  const actions = document.createElement("div");
  actions.className = "customise-actions";
  actions.append(close);
  dialog.append(actions);
  document.body.append(dialog);
  dialog.showModal();
  try {
    if (!connection) {
      const p = await request("create", { settings: loadSettings() });
      connection = {
        token: p.token,
        revision: p.revision,
        baseline: loadSettings(),
      };
      save();
    }
    await sync();
    const pair = await request("pair", {});
    const img = document.createElement("img");
    img.src = pair.qr;
    img.alt = "QR code to connect this browser to tab1";
    const expiry = document.createElement("p");
    expiry.className = "customise-status";
    expiry.textContent = "This code expires in five minutes.";
    status.after(img, expiry);
    status.textContent =
      "Scan this code with your iPhone’s Camera and tap the link. If tab1 is installed, it will open and connect automatically.";
    if (connection.accountTag) return;
    const unlink = document.createElement("button");
    unlink.textContent = "Disconnect this browser";
    unlink.onclick = async () => {
      await request("unlink", {});
      connection = null;
      localStorage.removeItem(key);
      dialog.close();
    };
    actions.prepend(unlink);
  } catch (e) {
    status.textContent = e.message;
  }
};
let changing = false;
export async function sync(reportError = false) {
  if (!connection || busy || changing || localStorage.getItem(key) !== JSON.stringify(connection)) return;
  busy = true;
  try {
    const identity = connection.accountTag || connection.token;
    const stillConnected = () => {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      return (saved?.accountTag || saved?.token) === identity;
    };
    const current = loadSettings();
    const remote = await request("sync");
    if (!stillConnected()) return;
    const merged = mergeSettings(connection.baseline, current, remote.settings);
    let result = remote;
    const pending = JSON.parse(
      localStorage.getItem("tab1:reading-pending") || "{}",
    );
    if (
      JSON.stringify(merged) !== JSON.stringify(remote.settings) ||
      Object.keys(pending).length
    )
      result = await request("sync", {
        revision: remote.revision,
        settings: merged,
        reading: pending,
      });
    if (!stillConnected()) return;
    const remaining = JSON.parse(
      localStorage.getItem("tab1:reading-pending") || "{}",
    );
    for (const [key, fields] of Object.entries(pending))
      for (const [field, value] of Object.entries(fields))
        if (JSON.stringify(remaining[key]?.[field]) === JSON.stringify(value)) {
          delete remaining[key][field];
          if (!Object.keys(remaining[key]).length) delete remaining[key];
        }
    const combined = { ...result.reading };
    for (const [key, fields] of Object.entries(remaining))
      combined[key] = { ...combined[key], ...fields };
    localStorage.setItem("tab1:reading", JSON.stringify(combined));
    localStorage.setItem("tab1:reading-pending", JSON.stringify(remaining));
    refreshReadingControls();
    document.dispatchEvent(new Event('reading:change'));
    connection.revision = result.revision;
    connection.baseline = result.settings;
    save();
    const latest = loadSettings();
    const adopted = mergeSettings(current, latest, result.settings);
    if (JSON.stringify(latest) !== JSON.stringify(adopted)) {
      await replaceSettings(adopted, "Synced from another device");
      document.dispatchEvent(new Event("settings:synced"));
    }
    button.title = "Connected · settings and reading activity synced";
  } catch (e) {
    button.title = e.message;
    if (reportError === true) throw e;
  } finally {
    busy = false;
  }
}
setInterval(() => {
  if (document.visibilityState === "visible") sync();
}, 15000);
window.addEventListener("online", sync);
document.addEventListener("history:change", () => setTimeout(sync, 300));
sync();
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.headline");
  if (!a || !a.href.startsWith("http") || a.origin === location.origin) return;
  changeReading(a.href, { read:true });

});

window.addEventListener('storage', event => {
  if (event.key === key && event.newValue !== event.oldValue) {
    const next = JSON.parse(event.newValue || 'null');
    if (connection?.accountTag !== next?.accountTag || connection?.token !== next?.token) location.reload();
    else connection = next;
  }
});
export async function prepareAccount() {
  while (busy) await new Promise(resolve => setTimeout(resolve, 40));
  if (!connection) {
    const p = await request("create", { settings:loadSettings() });
    connection = { token:p.token, revision:p.revision, baseline:loadSettings() }; save();
  }
  await sync(true);
  if (Object.keys(JSON.parse(localStorage.getItem("tab1:reading-pending") || "{}")).length)
    throw Error("Reading changes are still syncing. Please try again.");
  changing = true;
}
export function resumeSync() { changing = false; }
export function accountHeaders() {
  if (connection?.accountTag) return { "X-Tab1-Account":connection.accountTag };
  return connection?.token ? { Authorization:"Bearer " + connection.token } : {};
}
export function adoptAccount(result, destination = "/settings") {
  for (const k of ["start-page:history","tab1:reading-pending","tab1:reading","start-page:settings",key]) localStorage.removeItem(k);
  if (result) {
    if (result.settings) localStorage.setItem("start-page:settings", JSON.stringify(result.settings));
    localStorage.setItem("tab1:reading", JSON.stringify(result.reading));
    connection = { accountTag:result.accountTag, revision:result.revision, baseline:result.settings };
    save();
  } else connection = null;
  location.replace(destination);
}

export function readingState() {
  const result = JSON.parse(localStorage.getItem("tab1:reading") || "{}");
  for (const [url, patch] of Object.entries(JSON.parse(localStorage.getItem("tab1:reading-pending") || "{}")))
    result[url] = { ...result[url], ...patch };
  return result;
}
function changeReading(url, patch) {
  if (changing) return;
  const pending = JSON.parse(localStorage.getItem("tab1:reading-pending") || "{}");
  pending[url] = { ...pending[url], ...patch };
  localStorage.setItem("tab1:reading-pending", JSON.stringify(pending));
  refreshReadingControls();
  document.dispatchEvent(new Event('reading:change'));
}
function refreshReadingControls() {
  if (!connection?.accountTag) return;
  const state = readingState();
  for (const headline of document.querySelectorAll('a.headline')) {
    const meta = headline.closest('.item')?.querySelector('.meta');
    if (!meta) continue;
    let save = meta.querySelector('.favourite-story');
    if (!save) {
      save = document.createElement('button');
      save.type = 'button'; save.className = 'summary-link favourite-story';
      meta.append(' · ',save);
      save.onclick = () => changeReading(headline.href, { saved:!readingState()[headline.href]?.saved,
        story:{link:headline.href,title:headline.textContent} });
    }
    const value = state[headline.href];
    save.textContent = value?.saved ? 'Saved' : 'Save';
    save.setAttribute('aria-pressed', String(!!value?.saved));
    save.setAttribute('aria-label','Save ' + headline.textContent);
    headline.classList.toggle('story-read', !!value?.read);
  }
}
document.addEventListener('cards:change', refreshReadingControls,true);
refreshReadingControls();
