import type { SettingsRow } from "../../appearance";
import type { Category } from "../../shell/settings";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { errorText, statementsApi, type AiState } from "../statements/api";
import "../statements/statements.css";

const MODELS: [string, string][] = [
  ["claude-opus-5-5", "Claude Opus 5.5 (most careful)"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 (faster)"],
  ["claude-haiku-5-5", "Claude Haiku 5.5 (cheapest)"],
];

/**
 * Settings → AI: Claude reads the statements Zazabor can't (scans, photos, unusual layouts). Off
 * until the user adds an API key and agrees that statements are sent to Anthropic. The key is
 * kept in the desktop's keyring and never shown again.
 */
export function aiCategory(): Category {
  let state: AiState | null = null;
  const wide = (label: string, hint: string, control: HTMLElement): SettingsRow => ({
    label: `${label} ${hint}`,
    el: h("div", { class: "sf-row plain wide st-notes-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), control),
  });
  const status = h("span", { class: "st-ai-status" });
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };
  const fail = (err: unknown) => say(errorText(err) === "locked" ? "Unlock Zazabor to change the AI settings." : errorText(err), true);

  const key = h("input", { type: "password", placeholder: "sk-ant-…", autocomplete: "off", spellcheck: "false", "aria-label": "Claude API key" });
  key.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") void saveKey();
  });
  const saveButton = h("button", { class: "btn small", type: "button", onclick: () => void saveKey() }, "Save Key");
  const removeButton = h("button", { class: "btn small ghost", type: "button", onclick: () => void removeKey() }, "Remove");
  const keyRow = wide("API key", "From the Claude Console (console.anthropic.com → API keys). It's kept in your desktop's keyring, or in a file only you can read when there's no keyring.",
    h("div", { class: "st-ai-key" }, key, saveButton, removeButton));

  const model = h("select", { "aria-label": "Model" }, ...MODELS.map(([v, l]) => h("option", { value: v }, l)));
  model.addEventListener("change", () => void saveSettings());
  const modelRow = wide("Model", "Opus reads difficult scans most reliably. Every statement is checked against its own balances whichever you pick.", model);

  const consent = h("input", { type: "checkbox", class: "switch", role: "switch" });
  consent.addEventListener("change", () => void saveSettings());
  const consentRow: SettingsRow = {
    label: "Send statements to Claude",
    el: h("label", { class: "sf-row sf-toggle" },
      h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Send statements to Claude"),
        h("p", { class: "sf-hint" }, "When Zazabor can't read a statement itself (a scan, a photo, an unusual layout), or you choose Read with Claude, the statement (or its text) is sent to Anthropic's API to be read, and Anthropic's API terms apply. Only the last four digits of the account number are kept. Nothing is sent while this is off.")),
      consent),
  };

  const test = h("button", { class: "btn small", type: "button", onclick: () => void runTest() }, icon("sparkles", 13), "Test the Key");
  const testRow = wide("Check", "Sends a one-word request with the saved key (a tiny charge on your Anthropic account).", h("div", { class: "st-ai-key" }, test, status));

  function draw() {
    if (!state) return;
    key.value = "";
    key.placeholder = state.hasKey ? (state.keyStore === "keyring" ? "Saved in your keyring" : "Saved in a private file") : "sk-ant-…";
    removeButton.hidden = !state.hasKey;
    model.value = MODELS.some(([v]) => v === state!.model) ? state.model : MODELS[0][0];
    consent.checked = state.consent;
    test.disabled = !state.hasKey;
  }

  async function load() {
    try {
      state = await statementsApi.aiState();
      say(state.hasKey ? "" : "Add a key to use Claude.");
    } catch (err) {
      fail(err);
    }
    draw();
  }

  async function saveKey() {
    if (!key.value.trim()) return say("Paste the key first.", true);
    try {
      state = await statementsApi.aiKeySet(key.value);
      say(state.keyStore === "keyring" ? "Saved in your keyring." : "Saved in a private file (no keyring was found).");
    } catch (err) {
      fail(err);
    }
    draw();
  }

  async function removeKey() {
    try {
      state = await statementsApi.aiKeyClear();
      say("The key was removed.");
    } catch (err) {
      fail(err);
    }
    draw();
  }

  async function saveSettings() {
    try {
      state = await statementsApi.aiSettings(model.value, consent.checked);
    } catch (err) {
      fail(err);
    }
    draw();
  }

  async function runTest() {
    say("Asking Claude…");
    test.disabled = true;
    try {
      say(await statementsApi.aiTest());
    } catch (err) {
      fail(err);
    } finally {
      test.disabled = !state?.hasKey;
    }
  }

  return {
    id: "ai", title: "AI", icon: "sparkles", section: "App",
    groups: [
      { title: "Claude", rows: [keyRow, modelRow, consentRow, testRow] },
    ],
    refresh: () => void load(),
  };
}
