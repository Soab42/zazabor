import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { errorText, formatCode, phoneApi, type PairRequest } from "./api";
import { subscribe, getState } from "./store";
import { openSheet, type Sheet } from "./ui";

/** The PC gives up on a pairing after this long (§1, numeric comparison). */
const PAIR_TIMEOUT_MS = 120_000;

let open: { sheet: Sheet; phoneId: string } | null = null;

/**
 * "Does your phone show 482 913?" with Pair and Cancel. Both screens show the same six digits;
 * pairing completes only when both sides say yes. Shown in the main window whatever section is
 * open (and from the Phone section's welcome screen).
 */
export function showPairDialog(request: PairRequest) {
  if (open?.phoneId === request.phoneId) return;
  open?.sheet.close();
  let answered = false;
  const answer = (accept: boolean) => {
    if (answered) return;
    answered = true;
    pair.disabled = cancel.disabled = true;
    void phoneApi.pairAnswer(request.phoneId, accept).then(() => {
      if (!accept) return sheet.close();
      status.replaceChildren(h("span", { class: "spinner" }), "Waiting for the phone to confirm…");
    }, (err) => {
      status.replaceChildren(icon("stAlert", 15), errorText(err));
      status.classList.add("error");
      answered = false;
      pair.disabled = cancel.disabled = false;
    });
  };
  const sheet = openSheet({
    title: "Pair with this phone?",
    subtitle: `${request.name} wants to link with this PC.`,
    icon: "phone",
    width: 440,
    class: "pl-pair-sheet",
    onClose: () => {
      clearTimeout(timer);
      stop();
      if (!answered) void phoneApi.pairAnswer(request.phoneId, false).catch(() => undefined);
      if (open?.sheet === sheet) open = null;
    },
  });
  const status = h("p", { class: "pl-pair-status" });
  sheet.body.append(
    h("p", { class: "pl-pair-ask" }, "Does your phone show this code?"),
    h("div", { class: "pl-pair-code", "aria-label": `Code ${request.code.split("").join(" ")}` }, formatCode(request.code)),
    status,
    h("p", { class: "sf-hint" }, "Only pair when both screens show the same six digits. The link between them is then encrypted with a key only this PC and that phone know."),
  );
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
  const pair = h("button", { class: "btn primary", type: "button" }, icon("check", 15), "Pair");
  cancel.addEventListener("click", () => answer(false));
  pair.addEventListener("click", () => answer(true));
  sheet.foot.append(h("span", { class: "spacer" }), cancel, pair);
  queueMicrotask(() => pair.focus());

  const timer = window.setTimeout(() => {
    status.replaceChildren(icon("clock", 15), "This code ran out. Start pairing again on the phone.");
    pair.disabled = true;
    answered = true;
  }, PAIR_TIMEOUT_MS);
  // Paired (the phone shows up) or given up (the request went away): close.
  // (The event can come before the state shows the request: only a request seen and then gone counts.)
  let seen = getState()?.pairing?.phoneId === request.phoneId;
  const stop = subscribe("state", () => {
    const state = getState();
    if (!state) return;
    if (state.pairing?.phoneId === request.phoneId) {
      seen = true;
      return;
    }
    if (state.phones.some((p) => p.phoneId === request.phoneId) && (seen || answered)) {
      answered = true;
      status.replaceChildren(icon("check", 15), `Paired with ${request.name}.`);
      status.classList.remove("error");
      status.classList.add("done");
      pair.disabled = cancel.disabled = true;
      window.setTimeout(() => sheet.close(), 1200);
    } else if (seen || answered) {
      sheet.close();
    }
  });
  open = { sheet, phoneId: request.phoneId };
}
