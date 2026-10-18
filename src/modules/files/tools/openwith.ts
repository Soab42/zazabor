import { basename, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { fsApi } from "../api";
import { toolsApi, type AppInfo, type AppsFor } from "../tools-api";

let current: { el: HTMLElement; close: () => void } | null = null;

export function closeOpenWith() {
  current?.close();
}

export interface OpenWithOptions {
  path: string;
  ext: string;
  /** Called with a readable message when listing or launching fails. */
  onError(message: string): void;
}

const message = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^Error: /, "");

function appIcon(app: AppInfo): HTMLElement {
  return h("span", { class: "ow-icon" },
    app.icon ? h("img", { src: app.icon, alt: "", draggable: false }) : icon("external", 16));
}

/**
 * The Open With popover: a glass list of the apps that handle the file, the default first and
 * marked. A switch makes the chosen app the default for this kind of file.
 */
export function openOpenWith(x: number, y: number, options: OpenWithOptions) {
  closeOpenWith();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const list = h("div", { class: "ow-list", role: "listbox", "aria-label": "Applications" }, h("div", { class: "ow-loading" }, h("span", { class: "spinner" })));
  const always = h("input", { class: "switch", type: "checkbox", id: "ow-always" });
  const label = options.ext ? `Always use for .${options.ext} files` : "Always use for this type of file";
  const foot = h("label", { class: "ow-foot", for: "ow-always" }, h("span", { class: "ow-foot-text" }, label), always);
  foot.hidden = true;
  const el = h("div", { class: "ow-pop glass-strong", role: "dialog", "aria-label": "Open With" },
    h("div", { class: "ow-head" }, h("span", { class: "ow-title" }, "Open With"), h("span", { class: "ow-file", title: options.path }, basename(options.path))),
    list, foot);
  document.body.append(el);

  const place = () => {
    const left = Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8));
    const top = Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.setProperty("--origin-x", `${x - left}px`);
    el.style.setProperty("--origin-y", `${y - top}px`);
  };
  place();

  const rows = (): HTMLButtonElement[] => Array.from(list.querySelectorAll<HTMLButtonElement>(".ow-app"));
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const buttons = rows();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" && buttons.length) buttons[(index + 1) % buttons.length].focus();
    else if (e.key === "ArrowUp" && buttons.length) buttons[(index - 1 + buttons.length) % buttons.length].focus();
    else return;
    e.preventDefault();
  };
  const onPointer = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("blur", close);
    el.remove();
    if (current?.el === el) current = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("blur", close);
  current = { el, close };

  let mime = "";
  const choose = async (app: AppInfo) => {
    close();
    try {
      if (always.checked && mime) await toolsApi.setDefaultApp(mime, app.id);
      await toolsApi.openWith(options.path, app.id);
    } catch (err) {
      options.onError(message(err));
    }
  };

  const show = (found: AppsFor) => {
    mime = found.mime;
    list.replaceChildren();
    if (found.apps.length === 0) {
      list.append(h("div", { class: "ow-empty" }, "No apps are registered for this kind of file."));
      const fallback = h("button", { class: "btn small ow-fallback", type: "button" }, icon("external", 14), "Open with Default App");
      // Nothing is registered, so there is no desktop file to name: let the system opener decide.
      fallback.addEventListener("click", () => {
        close();
        fsApi.openDefault(options.path).catch((e) => options.onError(message(e)));
      });
      list.append(fallback);
      place();
      return;
    }
    found.apps.forEach((app, i) => {
      const button = h("button", { class: `ow-app${app.isDefault ? " default" : ""}`, type: "button", role: "option", title: app.name },
        appIcon(app), h("span", { class: "ow-name" }, app.name), app.isDefault ? h("span", { class: "ow-badge" }, "Default") : null);
      button.addEventListener("click", () => void choose(app));
      list.append(button);
      if (i === 0) requestAnimationFrame(() => button.focus());
    });
    foot.hidden = false;
    place();
  };

  toolsApi.appsFor(options.path).then((found) => {
    if (current?.el === el) show(found);
  }, (err) => {
    if (current?.el !== el) return;
    close();
    options.onError(message(err));
  });
}
