import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { VideoContext } from "../../extensions";
import { formatTime } from "../../format";

/** How long the prompt waits before keeping the resume point. */
export const RESUME_PROMPT_MS = 8000;

/**
 * "Continue from 12:34?" near the centre controls. The file already plays from its resume point;
 * Start over jumps back to 0, anything else (or doing nothing for ~8 s) keeps it.
 */
export class ResumePrompt {
  private el: HTMLElement | null = null;
  private key = "";
  private timer = 0;
  private readonly off: () => void;

  constructor(private readonly ctx: VideoContext) {
    this.off = ctx.player.subscribe(() => this.sync());
  }

  private sync() {
    const { player } = this.ctx;
    const offer = player.resumeOffer;
    const key = offer && player.current === offer.path ? `${offer.path}|${offer.time}` : "";
    if (key === this.key) return;
    this.key = key;
    this.hide();
    if (offer && key) this.show(offer.time);
  }

  private show(time: number) {
    const { player } = this.ctx;
    const resume = h("button", { class: "btn primary small", type: "button" }, "Resume");
    const restart = h("button", { class: "btn small", type: "button" }, "Start over");
    const countdown = h("span", { class: "vq-prompt-timer", style: { animationDuration: `${RESUME_PROMPT_MS}ms` } });
    const card = h("div", { class: "vq-prompt", role: "dialog", "aria-label": "Continue watching" },
      h("div", { class: "vq-prompt-text" },
        icon("clock", 16),
        h("span", null, "Continue from ", h("b", null, formatTime(time)), "?")),
      h("div", { class: "vq-prompt-actions" }, restart, resume),
      countdown);
    resume.addEventListener("click", () => player.dismissResumeOffer());
    restart.addEventListener("click", () => player.startOver());
    this.el = card;
    this.ctx.stageLayer.append(card);
    this.timer = window.setTimeout(() => player.dismissResumeOffer(), RESUME_PROMPT_MS);
  }

  private hide() {
    clearTimeout(this.timer);
    const card = this.el;
    this.el = null;
    if (!card) return;
    card.classList.add("leaving");
    window.setTimeout(() => card.remove(), 200);
  }

  dispose() {
    this.off();
    clearTimeout(this.timer);
    this.el?.remove();
    this.el = null;
  }
}
