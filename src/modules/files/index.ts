import type { AppModule, ModuleFactory } from "../../shell/module";
import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";

/** Placeholder; replaced by the real Files module at merge. */
class FilesModule implements AppModule {
  readonly id = "files" as const;
  readonly title = "Files";
  readonly icon: IconName = "folder";
  readonly el = h(
    "div",
    { class: "sh-empty-host" },
    h(
      "div",
      { class: "sh-empty" },
      h("div", { class: "sh-empty-icon" }, icon("folder", 38)),
      h("h2", null, "Files is getting ready"),
      h("p", null, "Browse folders, preview anything and organise your files in one calm place. It arrives in the next update."),
    ),
  );

  activate() {}
  deactivate() {}
  handleKey() {
    return false;
  }
}

/** Creates the Files module. */
export const createFilesModule: ModuleFactory = () => new FilesModule();
