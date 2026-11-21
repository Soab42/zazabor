import { invoke } from "@tauri-apps/api/core";
import type { SettingsRow } from "../../appearance";
import type { Config } from "../../config";
import type { Category } from "../../shell/settings";
import { h } from "../../ui/dom";
import { errorText, meetApi, onMeet, type MeetState } from "./api";

/**
 * Settings → Meet: the outside link (a Cloudflare quick tunnel) on or off with its address, where
 * recordings go, the STUN servers and an optional TURN server for guests behind strict networks.
 */
export function meetCategory(_host: { readonly config: Config }): Category {
  let state: MeetState | null = null;

  const problem = h("p", { class: "sf-hint pl-settings-error", hidden: true });
  const fail = (err: unknown) => {
    problem.hidden = false;
    problem.textContent = errorText(err);
  };

  // ---- the outside link
  const tunnelInput = h("input", { type: "checkbox", class: "switch", role: "switch" });
  const tunnelHint = h("p", { class: "sf-hint" });
  const tunnelRow: SettingsRow = { label: "Outside link", el: h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Let people outside this Wi-Fi join"), tunnelHint), tunnelInput) };
  tunnelInput.addEventListener("change", () => {
    const on = tunnelInput.checked;
    tunnelInput.disabled = true;
    void meetApi.tunnel(on).then(draw, (err) => {
      tunnelInput.checked = !on;
      fail(err);
    }).finally(() => (tunnelInput.disabled = false));
  });
  const addressText = h("span", { class: "st-value mt-settings-address" }, "—");
  const copy = h("button", { class: "btn small ghost", type: "button" }, "Copy");
  copy.addEventListener("click", () => void navigator.clipboard?.writeText(addressText.textContent ?? "").catch(() => undefined));
  const addressRow: SettingsRow = { label: "Address", el: h("div", { class: "sf-row plain" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Address"), h("p", { class: "sf-hint" }, "Changes each time the link starts; invitations carry the current one.")), h("div", { class: "pl-settings-buttons" }, addressText, copy)) };

  // ---- recordings
  const folder = h("p", { class: "sf-hint pl-settings-path" });
  const show = h("button", { class: "btn small", type: "button" }, "Open Folder");
  show.addEventListener("click", () => state && void invoke("fs_open_default", { path: state.recordingsDir }).catch(fail));
  const folderRow: SettingsRow = { label: "Recordings folder", el: h("div", { class: "sf-row plain" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Recordings go to"), folder), show) };

  // ---- connection
  const field = (placeholder: string, label: string, type = "text") => h("input", { class: "ops-input mt-settings-input", type, placeholder, spellcheck: false, autocomplete: "off", "aria-label": label });
  const stun = h("textarea", { class: "ops-input mt-settings-stun", rows: 3, spellcheck: false, placeholder: "stun:stun.example.com:3478", "aria-label": "STUN servers" });
  const turnUrl = field("turn:turn.example.com:3478", "TURN server address");
  const turnUser = field("Username", "TURN username");
  const turnPass = field("Credential", "TURN credential", "password");
  const save = h("button", { class: "btn small primary", type: "button" }, "Save");
  save.addEventListener("click", () => {
    const servers = stun.value.split(/[\s,]+/).filter(Boolean);
    const url = turnUrl.value.trim();
    save.disabled = true;
    void meetApi.settings(servers, url ? { url, username: turnUser.value.trim(), credential: turnPass.value } : null).then((next) => {
      problem.hidden = true;
      draw(next);
    }, fail).finally(() => (save.disabled = false));
  });
  const stunRow: SettingsRow = { label: "STUN servers", el: h("div", { class: "sf-row wide" }, h("span", { class: "sf-label" }, "STUN servers"), h("p", { class: "sf-hint" }, "One per line. They help two browsers find each other."), stun) };
  const turnRow: SettingsRow = { label: "TURN server", el: h("div", { class: "sf-row wide" }, h("span", { class: "sf-label" }, "TURN server (optional)"), h("p", { class: "sf-hint" }, "Relays sound and picture for guests behind a strict network. Without one, some of them can't connect."), turnUrl, turnUser, turnPass, h("div", { class: "pl-settings-buttons" }, save)) };

  function draw(next: MeetState | null) {
    if (next) state = next;
    const s = state;
    if (!s) {
      tunnelHint.textContent = "Meet isn't available in this version of Zazabor Home.";
      tunnelInput.disabled = true;
      return;
    }
    tunnelInput.disabled = false;
    tunnelInput.checked = s.tunnel.state === "on" || s.tunnel.state === "starting";
    tunnelHint.textContent = s.tunnel.state === "on" ? "On. Guests join through the address below."
      : s.tunnel.state === "starting" ? "Starting…"
      : s.tunnel.state === "error" ? `Couldn't start: ${s.tunnel.error ?? "unknown error"}`
      : "Off. It starts by itself when you share a link: guests need its https address, since browsers only allow the camera and mic on a secure page.";
    addressText.textContent = s.tunnel.url ?? "—";
    copy.hidden = !s.tunnel.url;
    folder.textContent = s.recordingsDir;
    if (document.activeElement !== stun) stun.value = s.stun.join("\n");
    turnUrl.value = s.turn?.url ?? "";
    turnUser.value = s.turn?.username ?? "";
    turnPass.value = s.turn?.credential ?? "";
  }
  void onMeet("meet-changed", () => void meetApi.state().then(draw, () => undefined)).catch(() => undefined);

  return {
    id: "meet", title: "Meet", icon: "video", section: "Modules",
    intro: problem,
    groups: [
      { title: "Outside link", rows: [tunnelRow, addressRow] },
      { title: "Recordings", rows: [folderRow] },
      { title: "Connection", rows: [stunRow, turnRow] },
    ],
    refresh() {
      problem.hidden = true;
      void meetApi.state().then(draw, () => draw(null));
    },
  };
}
