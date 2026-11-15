import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { duration, errorText, phoneApi, type AppCallState, type LiveCall } from "./api";
import { callPhone, contactFor, displayFor, getBt, onEvent, setBt, subscribe } from "./store";
import { avatar } from "./ui";
import { showToast } from "../files/ops/toast";

/**
 * Calls in the main window, whatever section is open: an incoming-call card (Answer, Decline),
 * and while a call runs a floating glass capsule with the timer, mute, keypad, hold, where the
 * audio plays (this PC or the phone) and End. Driven by `phone-bt` (AT+CLCC) and `phone-ring`.
 */
export function mountCallBar(openPhone: () => void): () => void {
  const host = h("div", { class: "pl-calls", "aria-live": "polite" });
  document.body.append(host);
  let keypadOpen = false;
  let timer = 0;
  /** A ring the Bluetooth state hasn't shown yet. */
  let ringing: LiveCall | null = null;
  /**
   * A call the Zazabor Link app reported (`call.state`). Shown only while Bluetooth shows no call:
   * then the PC can answer, decline and end it through the app, but its sound stays on the phone.
   */
  let appCall: (LiveCall & { phoneId: string }) | null = null;
  const viaApp = (call: LiveCall) => !!appCall && call === appCall;
  const appPhone = () => appCall?.phoneId;

  const run = (label: string, task: () => Promise<unknown>) => () => void task().catch((err) => showToast(`${label}: ${errorText(err)}`));

  const roundButton = (glyph: IconName, label: string, tone: string, action: () => void, size = 18) => {
    const b = h("button", { class: `pl-round ${tone}`, type: "button", title: label, "aria-label": label }, icon(glyph, size));
    b.addEventListener("click", action);
    return b;
  };

  function whoOf(call: LiveCall) {
    const phoneId = (viaApp(call) ? appCall!.phoneId : callPhone()?.phoneId) ?? null;
    return { phoneId, contact: contactFor(phoneId, call.number), name: displayFor(phoneId, call.number, call.name) };
  }

  function incomingCard(call: LiveCall, waiting: boolean): HTMLElement {
    const who = whoOf(call);
    const via = callPhone()?.name;
    const answer = roundButton("call", waiting ? "Hold and answer" : "Answer", "accept", run("Couldn't answer", () => (waiting ? phoneApi.hold(2) : phoneApi.answer(viaApp(call) ? appPhone() : undefined))), 20);
    const decline = roundButton("callEnd", "Decline", "end", run("Couldn't decline", () => {
      ringing = null;
      return waiting ? phoneApi.hold(0) : phoneApi.decline(viaApp(call) ? appPhone() : undefined);
    }), 20);
    return h("div", { class: "pl-incoming glass-strong", role: "alertdialog", "aria-label": `Incoming call from ${who.name}` },
      h("div", { class: "pl-incoming-who" },
        h("span", { class: "pl-ring-pulse" }, avatar(who.name, 46, who.phoneId, who.contact)),
        h("div", { class: "pl-incoming-text" },
          h("span", { class: "pl-incoming-label" }, waiting ? "Call waiting" : `Incoming call${via ? ` · ${via}` : ""}`),
          h("strong", null, who.name),
          who.name !== call.number ? h("span", { class: "pl-incoming-number" }, call.number) : null)),
      h("div", { class: "pl-incoming-actions" },
        h("div", { class: "pl-round-wrap" }, decline, h("span", null, "Decline")),
        h("div", { class: "pl-round-wrap" }, answer, h("span", null, waiting ? "Hold & Answer" : "Answer"))));
  }

  function keypad(): HTMLElement {
    const pad = h("div", { class: "pl-dtmf glass-strong" });
    for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]) {
      const b = h("button", { class: "pl-dtmf-key", type: "button" }, key);
      b.addEventListener("click", run("Couldn't send the tone", () => phoneApi.dtmf(key)));
      pad.append(b);
    }
    return pad;
  }

  function capsule(call: LiveCall, others: LiveCall[]): HTMLElement {
    const bt = getBt();
    const who = whoOf(call);
    const time = h("span", { class: "pl-capsule-time" });
    const tick = () => {
      time.textContent = call.state === "dialing" || call.state === "alerting" ? "Calling…"
        : call.state === "held" ? "On hold"
        : call.since ? duration((Date.now() - call.since) / 1000) : "Connected";
    };
    tick();
    clearInterval(timer);
    timer = window.setInterval(tick, 1000);

    const muted = !!bt?.muted;
    const mute = h("button", { class: `pl-cap-btn${muted ? " active" : ""}`, type: "button", title: muted ? "Unmute" : "Mute", "aria-pressed": String(muted) }, icon(muted ? "recMicOff" : "veMic", 17));
    mute.addEventListener("click", run("Couldn't change the microphone", () => phoneApi.mute(!muted)));
    const pad = h("button", { class: `pl-cap-btn${keypadOpen ? " active" : ""}`, type: "button", title: "Keypad", "aria-pressed": String(keypadOpen) }, icon("dialpad", 17));
    pad.addEventListener("click", () => {
      keypadOpen = !keypadOpen;
      draw();
    });
    const held = call.state === "held";
    const hold = h("button", { class: `pl-cap-btn${held ? " active" : ""}`, type: "button", title: others.length ? "Swap calls" : held ? "Resume" : "Hold" }, icon(others.length ? "transfer" : held ? "play" : "pause", 16));
    hold.addEventListener("click", run("Couldn't hold the call", () => phoneApi.hold(2)));
    const onPc = bt?.audioOnPc !== false;
    const audio = h("div", { class: "segmented pl-cap-audio", role: "group", "aria-label": "Call audio" },
      h("button", { type: "button", class: onPc ? "active" : "", title: "Hear the call on this PC", onclick: run("Couldn't move the audio", () => phoneApi.audio(true)) }, icon("laptop", 14), "PC"),
      h("button", { type: "button", class: onPc ? "" : "active", title: "Hear the call on the phone", onclick: run("Couldn't move the audio", () => phoneApi.audio(false)) }, icon("phone", 14), "Phone"));
    const volume = h("input", { type: "range", class: "pl-cap-volume", min: 0, max: 15, step: 1, value: String(bt?.volume ?? 10), title: "Call volume", "aria-label": "Call volume" });
    let volumeTimer = 0;
    volume.addEventListener("input", () => {
      clearTimeout(volumeTimer);
      volumeTimer = window.setTimeout(() => void phoneApi.volume(Number(volume.value)).catch(() => undefined), 120);
    });
    const end = h("button", { class: "pl-cap-end", type: "button", title: "End call", "aria-label": "End call" }, icon("callEnd", 18));
    end.addEventListener("click", run("Couldn't end the call", () => phoneApi.hangup(viaApp(call) ? appPhone() : undefined)));
    const name = h("button", { class: "pl-capsule-who", type: "button", title: "Open Phone" },
      avatar(who.name, 30, who.phoneId, who.contact),
      h("span", { class: "pl-capsule-text" }, h("strong", null, who.name), time));
    name.addEventListener("click", openPhone);
    const bar = h("div", { class: `pl-capsule glass-strong${held ? " held" : ""}`, role: "region", "aria-label": "Call" },
      name,
      others.length ? h("span", { class: "pl-capsule-more", title: others.map((c) => whoOf(c).name).join(", ") }, `+${others.length} on hold`) : null,
      h("span", { class: "pl-cap-sep" }),
      // A call through the app has its sound on the phone: only ending it works from here.
      ...(viaApp(call) ? [h("span", { class: "pl-capsule-more" }, "Sound on the phone"), end] : [mute, pad, hold, onPc ? volume : null, audio, end]));
    return h("div", { class: "pl-capsule-wrap" }, bar, keypadOpen ? keypad() : null);
  }

  function draw() {
    const calls = [...(getBt()?.calls ?? [])];
    if (appCall && !calls.length) calls.push(appCall);
    if (ringing && !calls.some((c) => c.idx === ringing!.idx || c.number === ringing!.number)) calls.push(ringing);
    const incoming = calls.find((c) => c.state === "incoming");
    const waiting = calls.find((c) => c.state === "waiting");
    const live = calls.filter((c) => c.state === "active" || c.state === "dialing" || c.state === "alerting" || c.state === "held");
    // The one being talked on leads; the others are on hold.
    const lead = live.find((c) => c.state !== "held") ?? live[0];
    host.replaceChildren();
    if (!lead) {
      clearInterval(timer);
      keypadOpen = false;
    } else {
      host.append(capsule(lead, live.filter((c) => c !== lead)));
    }
    if (incoming && !lead) host.append(incomingCard(incoming, false));
    else if (waiting || (incoming && lead)) host.append(incomingCard((waiting ?? incoming)!, true));
    document.body.classList.toggle("pl-in-call", !!lead);
  }

  const stops = [
    subscribe("bt", () => {
      // Not under a finger moving the volume (the bar is rebuilt on every change).
      if (host.querySelector(".pl-cap-volume:active")) return;
      if (ringing && !getBt()?.calls.some((c) => c.state === "incoming" || c.state === "waiting")) ringing = null;
      draw();
    }),
    subscribe("contacts", draw),
    onEvent("phone-call-state", (c: AppCallState) => {
      if (c.state === "ended") {
        if (appCall?.phoneId === c.phoneId) appCall = null;
      } else {
        const state = c.state === "ringing" ? "incoming" : c.state;
        const since = c.state === "active" ? (appCall?.since ?? c.at ?? Date.now()) : appCall?.since ?? null;
        appCall = { phoneId: c.phoneId, idx: -1, number: c.number, name: c.name, dir: c.state === "ringing" ? "in" : appCall?.dir ?? "out", state, since };
      }
      draw();
    }),
    onEvent("phone-ring", (call) => {
      ringing = call;
      draw();
    }),
  ];
  draw();
  return () => {
    stops.forEach((stop) => stop());
    clearInterval(timer);
    host.remove();
    document.body.classList.remove("pl-in-call");
  };
}

/** Starts a call: through this PC over Bluetooth when that's set up, else the phone dials it itself. */
export async function placeCall(number: string, phoneId: string | null) {
  const clean = number.trim();
  if (!clean) return;
  try {
    await phoneApi.dial(clean, phoneId ?? undefined);
    if (!callPhone()) showToast("Calling on the phone. The call's sound stays on the phone.", undefined, 4000);
  } catch (err) {
    showToast(`Couldn't call: ${errorText(err)}`);
  }
  // The call shows up through `phone-bt`; ask once in case it was missed.
  void phoneApi.btState().then(setBt, () => undefined);
}
