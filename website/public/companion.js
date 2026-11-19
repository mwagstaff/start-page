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
      ...(connection ? { Authorization: "Bearer " + connection.token } : {}),
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
document.body.append(button);
button.onclick = async () => {
  const dialog = document.createElement("dialog");
  dialog.style.cssText =
    "max-width:360px;padding:24px;border-radius:20px;background:Canvas;color:CanvasText";
  const title = document.createElement("h2");
  title.textContent = "Connect tab1 for iPhone";
  dialog.append(title);
  const status = document.createElement("p");
  status.textContent = "Preparing your connection…";
  dialog.append(status);
  const close = document.createElement("button");
  close.textContent = "Close";
  close.onclick = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(close);
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
    img.alt = "Scan with tab1 on your iPhone";
    img.style.width = "100%";
    dialog.insertBefore(img, status);
    status.textContent =
      "In the app, open Settings → Connect website. This code expires in five minutes.";
    const unlink = document.createElement("button");
    unlink.textContent = "Disconnect this browser";
    unlink.onclick = async () => {
      await request("unlink", {});
      connection = null;
      localStorage.removeItem(key);
      dialog.close();
      dialog.remove();
    };
    dialog.append(unlink);
  } catch (e) {
    status.textContent = e.message;
  }
};
async function sync() {
  if (!connection || busy) return;
  busy = true;
  try {
    const current = loadSettings();
    const remote = await request("sync");
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
    const remaining = JSON.parse(
      localStorage.getItem("tab1:reading-pending") || "{}",
    );
    for (const [key, fields] of Object.entries(pending))
      for (const [field, value] of Object.entries(fields))
        if (remaining[key]?.[field] === value) {
          delete remaining[key][field];
          if (!Object.keys(remaining[key]).length) delete remaining[key];
        }
    const combined = { ...result.reading };
    for (const [key, fields] of Object.entries(remaining))
      combined[key] = { ...combined[key], ...fields };
    localStorage.setItem("tab1:reading", JSON.stringify(combined));
    localStorage.setItem("tab1:reading-pending", JSON.stringify(remaining));
    connection.revision = result.revision;
    connection.baseline = result.settings;
    save();
    const latest = loadSettings();
    const adopted = mergeSettings(current, latest, result.settings);
    if (JSON.stringify(latest) !== JSON.stringify(adopted)) {
      await replaceSettings(adopted, "Synced from another device");
    }
    button.title = "Connected · settings and reading activity synced";
  } catch (e) {
    button.title = e.message;
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
  const reading = JSON.parse(localStorage.getItem("tab1:reading") || "{}");
  const pending = JSON.parse(
    localStorage.getItem("tab1:reading-pending") || "{}",
  );
  pending[a.href] = { ...(pending[a.href] || {}), read: true };
  localStorage.setItem("tab1:reading-pending", JSON.stringify(pending));
});
