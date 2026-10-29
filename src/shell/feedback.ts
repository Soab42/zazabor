import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { SettingsGroup, SettingsRow } from "../appearance";
import { h } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";

/**
 * Settings → Zazabor → Feedback: reporting a bug or asking for a feature opens GitHub's issue form
 * for it (.github/ISSUE_TEMPLATE) in the browser, with Zazabor's version and the system filled in
 * (src-tauri/src/feedback.rs). Nothing is sent until the report is submitted there.
 */

const NEW_ISSUE = "https://github.com/Soab42/zazabor/issues/new";

/** Opens the issue form for a bug or a feature request. */
export async function openFeedback(kind: "bug" | "feature") {
  const [version, system] = await Promise.all([
    getVersion().catch(() => ""),
    invoke<string>("system_details").catch(() => ""),
  ]);
  const url = new URL(NEW_ISSUE);
  url.searchParams.set("template", kind === "bug" ? "bug_report.yml" : "feature_request.yml");
  if (version) url.searchParams.set("version", version);
  if (system) url.searchParams.set("system", system);
  await invoke("fs_open_default", { path: url.toString() });
}

export function feedbackGroup(): SettingsGroup {
  const row = (title: string, hint: string, face: IconName, action: string, keywords: string, run: () => void): SettingsRow => ({
    label: `${title} ${keywords}`,
    el: h("div", { class: "sf-row plain" },
      h("div", { class: "st-text" }, h("span", { class: "sf-label" }, title), h("p", { class: "sf-hint" }, hint)),
      h("button", { type: "button", class: "btn small", onclick: run }, icon(face, 14), action)),
  });
  return {
    title: "Feedback",
    rows: [
      row("Report a Bug", "Something broken, or not working as it should? Tell us on GitHub. Your Zazabor version and system are filled in; nothing is sent until you submit it there.",
        "bug", "Report a Bug…", "problem crash issue error feedback", () => void openFeedback("bug")),
      row("Request a Feature", "An idea that would make Zazabor better? Describe it on GitHub, where you can also follow what happens to it.",
        "sparkles", "Request a Feature…", "idea suggestion wish feedback", () => void openFeedback("feature")),
    ],
  };
}
