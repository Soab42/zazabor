import { h } from "./dom";
import { icon, type IconName } from "./icons";
import "./menu.css";

export type MenuItem =
  | { label: string; icon?: IconName; action: () => void; danger?: boolean; disabled?: boolean; shortcut?: string }
  | "separator";

const KEY_NAMES: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", cmd: "Ctrl", meta: "Ctrl", mod: "Ctrl",
  shift: "Shift", alt: "Alt", option: "Alt",
  del: "Delete", delete: "Delete", esc: "Esc", escape: "Esc", space: "Space", enter: "Enter", return: "Enter",
  tab: "Tab", backspace: "Backspace",
};

/** Normalises a shortcut hint to the Linux style: "ctrl+c" becomes "Ctrl+C", "del" becomes "Delete". */
export function formatShortcut(text: string): string {
  return text.split("+").map((part) => {
    const key = part.trim();
    const named = KEY_NAMES[key.toLowerCase()];
    if (named) return named;
    return /^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : key;
  }).filter(Boolean).join("+");
}

let openMenuEl: HTMLElement | null = null;

export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

/**
 * Shows a context menu at a screen position; arrow keys, Enter and Escape work. `header` sits
 * above the items (e.g. a row of colour swatches).
 */
export function openMenu(x: number, y: number, items: MenuItem[], header?: HTMLElement) {
  closeMenu();
  const buttons: HTMLButtonElement[] = [];
  const menu = h("div", { class: "menu", role: "menu" });
  if (header) menu.append(header);
  for (const item of items) {
    if (item === "separator") {
      menu.append(h("div", { class: "menu-sep" }));
      continue;
    }
    const button = h("button", { class: `menu-item${item.danger ? " danger" : ""}`, role: "menuitem", disabled: item.disabled },
      item.icon ? icon(item.icon, 15) : h("span", { class: "menu-icon-gap" }), item.label,
      ...(item.shortcut ? [h("span", { class: "menu-shortcut" }, formatShortcut(item.shortcut))] : []));
    button.addEventListener("click", () => {
      closeMenu();
      item.action();
    });
    buttons.push(button);
    menu.append(button);
  }
  document.body.append(menu);
  openMenuEl = menu;

  // Keep the menu on screen, and let it grow out of the pointer. Layout sizes, not the bounding
  // rect: the entrance animation is already scaling the latter.
  const left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4));
  const top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.setProperty("--origin-x", `${x - left}px`);
  menu.style.setProperty("--origin-y", `${y - top}px`);

  const enabled = () => buttons.filter((b) => !b.disabled);
  const onKey = (e: KeyboardEvent) => {
    if (!openMenuEl) return;
    e.stopPropagation();
    const list = enabled();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") closeMenu();
    else if (e.key === "ArrowDown") list[(index + 1) % list.length]?.focus();
    else if (e.key === "ArrowUp") list[(index - 1 + list.length) % list.length]?.focus();
    else return;
    e.preventDefault();
  };
  const onPointer = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("blur", closeMenu, { once: true });
  const observer = new MutationObserver(() => {
    if (!menu.isConnected) {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });
  enabled()[0]?.focus();
}
