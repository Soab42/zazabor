import type { AppModule, ModuleFactory } from "../../shell/module";
import { h } from "../../ui/dom";
import { Browser } from "./browser";
import { Sidebar } from "./sidebar";
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
    handleKey: (e) => browser.handleKey(e),
    configChanged: () => browser.settingsChanged(),
    open(request) {
      if (request.kind === "folder") browser.navigate(request.path);
    },
    dispose() {
      sidebar.dispose();
      browser.dispose();
    },
  };
  return module;
};
