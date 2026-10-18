import type { AppModule, ModuleFactory } from "../../shell/module";
import { TerminalTabs } from "../../terminal/tabs";
import { h } from "../../ui/dom";
import "./terminal-module.css";

/**
 * The Terminal section: your shell in glass tabs. New terminals start in the folder of the one in
 * front; a new window (Ctrl+N from the rail) starts there too.
 */
export const createTerminalModule: ModuleFactory = () => {
  let home: string | null = null;
  const tabs = new TerminalTabs({ cwd: () => home });
  const el = h("section", { class: "term-module" }, tabs.el);

  const module: AppModule = {
    id: "terminal",
    title: "Terminal",
    icon: "terminal",
    el,
    activate() {
      void tabs.show();
    },
    deactivate() {
      tabs.hide();
    },
    handleKey: (e) => tabs.handleKey(e),
    appearanceChanged: () => tabs.themeChanged(),
    windowPath: () => tabs.cwd,
    open(request) {
      if (request.kind !== "folder") return;
      // Before the first terminal, this is where it starts; after, a new tab in that folder.
      home = request.path;
      if (tabs.count > 0) void tabs.add(request.path);
    },
    dispose() {
      tabs.dispose();
      el.remove();
    },
  };
  return module;
};
