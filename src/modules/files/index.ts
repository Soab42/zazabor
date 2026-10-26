import type { AppModule, ModuleFactory } from "../../shell/module";
import { h } from "../../ui/dom";
import { Browser } from "./browser";
import { createFileOps } from "./ops";
import { createInfoExtension } from "./info/extension";
import { Sidebar } from "./sidebar";
import { createToolsExtension } from "./tools/extension";
import { walletFilesExtension } from "../wallet/files-extension";
import "./files.css";

/** The Files module: a Finder-style file manager (sidebar, tabs, four views, live folders). */
export const createFilesModule: ModuleFactory = (shell) => {
  const el = h("div", { class: "files" });

  const browser: Browser = new Browser(shell, {
    pathChanged: (path) => sidebar.setCurrent(path),
    pinsChanged: () => sidebar.render(),
  });
  const sidebar: Sidebar = new Sidebar(shell, {
    navigate: (path) => browser.navigate(path),
    openInNewTab: (path) => browser.newTab(path),
    unpin: (path) => browser.unpin(path),
    volumes: (volumes) => browser.setVolumes(volumes),
  });
  el.append(sidebar.el, browser.el);
  browser.addExtension(createFileOps(el));
  const info = createInfoExtension(el, shell);
  browser.addExtension(info);
  const tools = createToolsExtension(shell);
  browser.addExtension(tools);
  browser.addExtension(walletFilesExtension(shell));

  /** Ctrl+K opens Connect to Server. */
  const connectKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return false;
    e.preventDefault();
    sidebar.connectToServer();
    return true;
  };

  const module: AppModule = {
    id: "files",
    title: "Files",
    icon: "folder",
    el,
    activate() {
      sidebar.activate();
      browser.activate();
    },
    deactivate() {
      sidebar.deactivate();
      browser.deactivate();
    },
    handleKey: (e) => connectKey(e) || browser.handleKey(e),
    configChanged: () => browser.settingsChanged(),
    windowPath: () => browser.currentPath || null,
    open(request) {
      if (request.kind === "folder") browser.navigate(request.path);
    },
    dispose() {
      sidebar.dispose();
      info.dispose();
      tools.dispose();
      browser.dispose();
    },
  };
  return module;
};
