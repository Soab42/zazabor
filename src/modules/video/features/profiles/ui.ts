import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { openDialog } from "../open/dialog";
import { hint, sectionLabel, textInput } from "../open/ui";
import {
  DEFAULT_PROFILE_ID, deleteProfile, listProfiles, renameProfile, saveProfile, switchProfile, updateProfile, type ProfileHost,
} from "./profiles";
import { mediaSettings } from "./settings";

/**
 * The profile list with its actions: use, rename, update from the current setup, delete, and
 * "save current as…". Used in the Settings page and in the player menu's dialog.
 */
export function profilesPanel(host: ProfileHost): HTMLElement {
  const root = h("div", { class: "mt-profiles" });
  let renaming: string | null = null;

  const render = () => {
    const active = mediaSettings(host).activeProfile;
    const rows = listProfiles(host).map((profile) => {
      const isActive = profile.id === active;
      const builtIn = profile.id === DEFAULT_PROFILE_ID;
      const name = renaming === profile.id
        ? (() => {
          const input = textInput("Profile name", profile.name);
          input.classList.add("inline");
          let done = false;
          const commit = (save: boolean) => {
            if (done) return;
            done = true;
            if (save && input.value.trim()) renameProfile(host, profile.id, input.value);
            renaming = null;
            render();
          };
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") commit(true);
            else if (e.key === "Escape") commit(false);
            else return;
            e.preventDefault();
            e.stopPropagation();
          });
          input.addEventListener("blur", () => commit(true));
          queueMicrotask(() => {
            input.focus();
            input.select();
          });
          return input;
        })()
        : h("span", { class: "mt-profile-name" }, profile.name, builtIn ? h("em", null, "built in") : null);

      const actions: HTMLElement[] = [];
      const action = (label: string, iconName: Parameters<typeof icon>[0], run: () => void, danger = false) => {
        const b = h("button", { class: `icon-btn small${danger ? " danger" : ""}`, type: "button", title: label, "aria-label": `${label}: ${profile.name}` }, icon(iconName, 15));
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          run();
        });
        actions.push(b);
      };
      if (!builtIn) {
        action("Rename", "pencil", () => {
          renaming = profile.id;
          render();
        });
        action("Update with the current layout and settings", "refresh", () => {
          updateProfile(host, profile.id);
          render();
        });
        action("Delete", "trash", () => {
          deleteProfile(host, profile.id);
          render();
        }, true);
      }

      const row = h("div", { class: `mt-profile${isActive ? " active" : ""}` },
        h("span", { class: "mt-profile-mark" }, isActive ? icon("check", 15) : null),
        name,
        h("span", { class: "mt-profile-actions" }, ...actions));
      row.addEventListener("click", () => {
        if (isActive || renaming) return;
        switchProfile(host, profile.id);
        render();
      });
      row.title = isActive ? "In use" : `Switch to ${profile.name}`;
      return row;
    });

    const input = textInput("Name this setup, e.g. Movie night");
    const save = h("button", { class: "btn small", type: "button" }, icon("plus", 14), "Save Current as Profile");
    const create = () => {
      if (!input.value.trim()) {
        input.focus();
        return;
      }
      saveProfile(host, input.value);
      render();
    };
    save.addEventListener("click", create);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      create();
    });
    root.replaceChildren(
      h("div", { class: "mt-list" }, ...rows),
      h("div", { class: "mt-new" }, input, save),
      hint("A profile remembers the control bar's layout together with these video settings."));
  };
  render();
  return root;
}

/** The Profiles dialog (player menu). `host.changed` re-renders the control bar after a switch. */
export function openProfiles(host: ProfileHost) {
  const dialog = openDialog({ title: "Profiles", subtitle: "Switch between saved player setups.", icon: "sparkles" });
  dialog.body.append(sectionLabel("Your profiles"), profilesPanel(host));
  const done = h("button", { class: "btn", type: "button" }, "Done");
  done.addEventListener("click", () => dialog.close());
  dialog.foot.append(h("div", { class: "spacer" }), done);
}
