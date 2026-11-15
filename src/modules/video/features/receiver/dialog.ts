import type { Config } from "../../../../config";
import { h } from "../../../../ui/dom";
import { icon, type IconName } from "../../../../ui/icons";
import { openDialog } from "../open/dialog";
import { errorLine, hint, sectionLabel, textInput } from "../open/ui";
import { applyReceiver, receiverApi, receiverName, receiverSettings, type ReceiverInfo } from "./service";

export interface ReceiverHost {
  readonly config: Config;
  saveConfig(): void;
}

interface Way {
  service: string;
  icon: IconName;
  title: string;
  how: (name: string) => string;
}

const WAYS: Way[] = [
  { service: "cast", icon: "play", title: "VLC", how: (name) => `In VLC on the phone (or on another computer), tap the cast button or ⋮ → Play on…, then choose “${name}”.` },
  { service: "youtube", icon: "play", title: "YouTube", how: (name) => `In the YouTube app, tap Cast and choose “${name}”. If it isn't listed: YouTube → Settings → Watch on TV → Enter TV code.` },
  { service: "dlna", icon: "network", title: "Other apps (DLNA)", how: (name) => `Apps that play to a TV find “${name}”: Web Video Caster, BubbleUPnP, a gallery's Smart View, Windows' Cast to Device.` },
  { service: "mirror", icon: "phone", title: "The phone's screen", how: (name) => `Install the Zazabor Cast app on the phone, open it and tap “${name}”.` },
];

/** The "Cast to This PC" dialog: turn it on, name it, see how each app reaches it. */
export function openReceiverDialog(host: ReceiverHost) {
  const settings = receiverSettings(host.config);
  let info: ReceiverInfo | null = null;
  let busy = false;
  let timer = 0;
  const dialog = openDialog({
    title: "Cast to This PC",
    subtitle: "Phones on the same Wi-Fi can play videos and music here, or show their screen, as on a smart TV.",
    icon: "cast",
    width: 560,
    onClose: () => clearInterval(timer),
  });

  const enabled = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Let phones cast to this PC" });
  enabled.checked = settings.enabled;
  const name = textInput("Zazabor Home", settings.name);
  const error = errorLine();
  const ask = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Ask before a new phone plays" });
  ask.checked = settings.ask;
  const live = h("div", { class: "rc-live" });

  void receiverName({ ...settings, name: "" }).then((n) => (name.placeholder = n));

  const restart = async () => {
    if (busy) return;
    busy = true;
    error.set("");
    try {
      info = await applyReceiver(host);
    } catch (err) {
      error.set(`Couldn't start: ${err}`);
      info = null;
    } finally {
      busy = false;
    }
    render();
  };

  enabled.addEventListener("change", () => {
    settings.enabled = enabled.checked;
    host.saveConfig();
    void restart();
  });
  name.addEventListener("change", () => {
    settings.name = name.value.trim();
    host.saveConfig();
    if (settings.enabled) void restart();
  });
  ask.addEventListener("change", () => {
    settings.ask = ask.checked;
    host.saveConfig();
  });

  const switchRow = (label: string, text: string, input: HTMLInputElement) =>
    h("label", { class: "rc-row" }, h("span", { class: "rc-row-text" }, h("strong", null, label), h("span", null, text)), input);

  dialog.body.append(
    h("div", { class: "mt-card rc-card" },
      switchRow("Let phones cast to this PC", "Zazabor Home listens on your local network while this is on.", enabled),
      h("div", { class: "rc-row" }, h("span", { class: "rc-row-text" }, h("strong", null, "Name phones see")), name),
      switchRow("Ask before a new phone plays", "Phones you allowed always skip the question.", ask)),
    error.el,
    live,
  );

  const render = () => {
    const shownName = name.value.trim() || name.placeholder;
    if (!settings.enabled) {
      live.replaceChildren(hint("Turn it on, then pick this PC from the cast button in VLC, YouTube or another app on your phone."));
      return;
    }
    if (!info) {
      live.replaceChildren(h("div", { class: "mt-loading" }, h("span", { class: "spinner" }), "Starting…"));
      return;
    }
    const ways = WAYS.map((way) => {
      const service = info!.services.find((s) => s.id === way.service);
      const ok = !!service && !service.error;
      const extra: Node[] = [];
      if (way.service === "youtube" && ok) extra.push(tvCode(info!.tvCode));
      return h("div", { class: `rc-way${ok ? "" : " off"}` },
        h("span", { class: "mt-item-icon" }, icon(way.icon, 18)),
        h("div", { class: "rc-way-text" },
          h("div", { class: "rc-way-title" }, way.title, h("span", { class: `rc-dot${ok ? " ok" : ""}`, title: ok ? "Ready" : service?.error ?? "Off" })),
          h("p", null, ok ? way.how(shownName) : `Not available: ${service?.error ?? "not started"}.`),
          ...extra));
    });
    const discovery = info.services.filter((s) => (s.id === "ssdp" || s.id === "mdns") && s.error);
    live.replaceChildren(
      sectionLabel("How to cast"),
      h("div", { class: "rc-ways" }, ...ways),
      ...discovery.map((s) => h("p", { class: "mt-error" }, `${s.label}: ${s.error}. Phones may not find this PC on their own.`)),
      hint(info.addresses.length
        ? `This PC is ${info.addresses.join(", ")} on your network. If phones can't find it, check that they're on the same Wi-Fi and that a firewall allows Zazabor Home.`
        : "This PC doesn't seem to be on a network right now."),
      trustedList(),
    );
  };

  const tvCode = (code: string | null) => {
    const value = h("strong", { class: "rc-code" }, code ?? "—");
    const fresh = h("button", { class: "btn small", type: "button" }, code ? "New Code" : "Get a TV Code");
    fresh.addEventListener("click", async () => {
      fresh.disabled = true;
      try {
        value.textContent = await receiverApi.youtubeCode();
      } catch (err) {
        value.textContent = String(err);
      } finally {
        fresh.disabled = false;
      }
    });
    return h("div", { class: "rc-tv" }, h("span", null, "TV code"), value, fresh);
  };

  const trustedList = () => {
    if (!settings.trusted.length) return h("div");
    return h("div", null,
      sectionLabel("Phones that may always cast"),
      h("div", { class: "mt-card" }, ...settings.trusted.map((t) => {
        const remove = h("button", { class: "btn small", type: "button" }, "Remove");
        remove.addEventListener("click", () => {
          settings.trusted = settings.trusted.filter((x) => x.key !== t.key);
          host.saveConfig();
          render();
        });
        return h("div", { class: "mt-row" }, h("span", { class: "mt-row-label" }, t.name), remove);
      })));
  };

  render();
  if (settings.enabled) {
    void receiverApi.info().then((i) => {
      if (i.running) {
        info = i;
        render();
      } else void restart();
    });
  }
  // The TV code and addresses can change while the dialog is open.
  timer = window.setInterval(() => {
    if (!settings.enabled || busy) return;
    void receiverApi.info().then((i) => {
      if (!i.running) return;
      const changed = JSON.stringify(i) !== JSON.stringify(info);
      info = i;
      if (changed && !dialog.body.contains(document.activeElement)) render();
    });
  }, 3000);
}
