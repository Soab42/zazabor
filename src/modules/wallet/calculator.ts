import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { calculate, showNumber } from "./calc-math";

const SPOT = "zazabor.wallet.calculator";

interface Spot {
  x: number;
  y: number;
}

function loadSpot(): Spot | null {
  try {
    const raw = localStorage.getItem(SPOT);
    const spot = raw ? (JSON.parse(raw) as Spot) : null;
    return spot && Number.isFinite(spot.x) && Number.isFinite(spot.y) ? spot : null;
  } catch {
    return null;
  }
}

function saveSpot(spot: Spot) {
  try {
    localStorage.setItem(SPOT, JSON.stringify(spot));
  } catch {
    // Without storage it opens in its usual place next time.
  }
}

export interface Calculator {
  toggle(): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Hides it while Wallet isn't showing (it comes back with it). */
  setVisible(on: boolean): void;
  dispose(): void;
}

/**
 * A small calculator that floats over Wallet (and its sheets) and can be dragged by its bar:
 * type a sum or use the keys, Enter to work it out, Insert to put the answer into the amount
 * field last typed in. Alt+C opens and closes it.
 */
export function createCalculator(): Calculator {
  let open = false;
  let visible = true;
  let lastAmount: HTMLInputElement | null = null;
  const history: { sum: string; value: number }[] = [];

  const display = h("input", { class: "wl-calc-input", type: "text", inputmode: "decimal", spellcheck: "false", autocomplete: "off", placeholder: "0", "aria-label": "Sum" });
  const answer = h("div", { class: "wl-calc-answer", "aria-live": "polite" });
  const past = h("div", { class: "wl-calc-history" });
  const insert = h("button", { class: "btn small primary wl-calc-insert", type: "button", title: "Put the answer into the amount field last typed in" }, "Insert");
  const close = h("button", { class: "icon-btn small", type: "button", title: "Close (Alt+C)", "aria-label": "Close the calculator" }, icon("close", 13));
  const bar = h("header", { class: "wl-calc-bar" }, icon("calculator", 14), h("span", null, "Calculator"), h("span", { class: "spacer" }), close);
  const keys: [string, string, string?][] = [
    ["C", "clear", "fn"], ["(", "("], [")", ")"], ["÷", "/", "op"],
    ["7", "7"], ["8", "8"], ["9", "9"], ["×", "*", "op"],
    ["4", "4"], ["5", "5"], ["6", "6"], ["−", "-", "op"],
    ["1", "1"], ["2", "2"], ["3", "3"], ["+", "+", "op"],
    ["%", "%", "op"], ["0", "0"], [".", "."], ["=", "equals", "eq"],
  ];
  const pad = h("div", { class: "wl-calc-keys" }, ...keys.map(([label, key, kind]) => {
    const b = h("button", { class: `wl-calc-key${kind ? ` ${kind}` : ""}`, type: "button", tabindex: -1 }, label);
    // Keeps the focus in the sum while the keys are pressed.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => press(key));
    return b;
  }));
  const el = h("section", { class: "wl-calc glass", role: "dialog", "aria-label": "Calculator", hidden: true },
    bar, h("div", { class: "wl-calc-screen" }, past, display, answer), pad, h("div", { class: "wl-calc-foot" }, h("span", { class: "tt-hint" }, "Enter works it out · Esc closes"), insert));
  document.body.append(el);

  let result: number | null = null;
  function work(final: boolean) {
    const text = display.value.trim();
    if (!text) {
      result = null;
      answer.textContent = "";
      answer.classList.remove("error");
      return;
    }
    try {
      result = calculate(text);
      answer.textContent = `= ${showNumber(result)}`;
      answer.classList.remove("error");
      if (final && /[-+*/×÷−%()]/.test(text.replace(/^-/, ""))) {
        history.unshift({ sum: text, value: result });
        history.splice(4);
        drawHistory();
        display.value = String(Math.round(result * 1e6) / 1e6);
        answer.textContent = "";
      }
    } catch (err) {
      result = null;
      answer.textContent = final ? (err as Error).message : "";
      answer.classList.toggle("error", final);
    }
  }
  function drawHistory() {
    past.replaceChildren(...history.slice().reverse().map((x) => h("button", { class: "wl-calc-past", type: "button", title: "Use this answer", onclick: () => ((display.value = String(x.value)), work(false), display.focus()) },
      h("span", null, x.sum), h("strong", null, showNumber(x.value)))));
  }
  function press(key: string) {
    if (key === "clear") {
      display.value = "";
    } else if (key === "equals") {
      work(true);
      display.focus();
      return;
    } else {
      const start = display.selectionStart ?? display.value.length;
      const end = display.selectionEnd ?? start;
      display.value = display.value.slice(0, start) + key + display.value.slice(end);
      display.setSelectionRange(start + key.length, start + key.length);
    }
    work(false);
    display.focus();
  }
  display.addEventListener("input", () => work(false));
  display.addEventListener("keydown", (e) => {
    // The calculator's keys stay its own (not the section's or a sheet's under it).
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "=") {
      e.preventDefault();
      work(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (display.value) display.value = "", work(false);
      else hide();
    }
  });
  // Amount fields typed in, for Insert.
  const onFocus = (e: FocusEvent) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t !== display && (t.inputMode === "decimal" || t.classList.contains("wl-amount-input"))) lastAmount = t;
  };
  document.addEventListener("focusin", onFocus);
  insert.addEventListener("click", () => {
    if (result == null) work(true);
    if (result == null) return;
    const value = String(Math.round(result * 100) / 100);
    if (lastAmount?.isConnected) {
      lastAmount.value = value;
      lastAmount.dispatchEvent(new Event("input", { bubbles: true }));
      lastAmount.focus();
    } else {
      void navigator.clipboard?.writeText(value).catch(() => undefined);
      answer.textContent = "Copied: no amount field open";
    }
  });
  close.addEventListener("click", () => hide());

  // Dragged by its bar, kept inside the window.
  function place(x: number, y: number) {
    const w = el.offsetWidth || 260;
    const hgt = el.offsetHeight || 380;
    const nx = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    const ny = Math.min(Math.max(8, y), window.innerHeight - hgt - 8);
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
    return { x: nx, y: ny };
  }
  bar.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    el.classList.add("dragging");
    const move = (ev: PointerEvent) => place(ev.clientX - dx, ev.clientY - dy);
    const up = (ev: PointerEvent) => {
      bar.removeEventListener("pointermove", move);
      el.classList.remove("dragging");
      saveSpot(place(ev.clientX - dx, ev.clientY - dy));
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up, { once: true });
    bar.addEventListener("pointercancel", up, { once: true });
  });
  const onResize = () => open && visible && place(el.offsetLeft, el.offsetTop);
  window.addEventListener("resize", onResize);

  function show() {
    open = true;
    el.hidden = !visible;
    const spot = loadSpot();
    place(spot?.x ?? window.innerWidth - 300, spot?.y ?? 90);
    requestAnimationFrame(() => {
      display.focus();
      display.select();
    });
  }
  function hide() {
    open = false;
    el.hidden = true;
    lastAmount?.focus();
  }
  // Alt+C anywhere in Wallet, sheets included (capture: before a sheet keeps its keys).
  const onKey = (e: KeyboardEvent) => {
    if (!visible || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== "c") return;
    e.preventDefault();
    e.stopPropagation();
    open ? hide() : show();
  };
  window.addEventListener("keydown", onKey, true);

  return {
    toggle: () => (open ? hide() : show()),
    open: show,
    close: hide,
    isOpen: () => open,
    setVisible(on) {
      visible = on;
      el.hidden = !(open && on);
    },
    dispose() {
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      el.remove();
    },
  };
}
