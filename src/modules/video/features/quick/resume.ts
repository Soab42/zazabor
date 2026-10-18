import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { VideoContext } from "../../extensions";
import { formatTime } from "../../format";

/** How long the prompt waits before keeping the resume point. */
export const RESUME_PROMPT_MS = 8000;

/**
 * The continue-watching prompt near the centre controls. When the file already plays from its
 * resume point it asks "Continue from 12:34?" (Start over jumps to 0); when it opened at the start
 * (the "ask" resume setting) it offers "Pick up at 12:34?". Doing nothing for ~8 s keeps playing
 * where it is.
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
    // Nothing to resume in a file that failed to play.
    const key = offer && player.current === offer.path && !player.error ? `${offer.path}|${offer.time}` : "";
    if (key === this.key) return;
    this.key = key;
    this.hide();
    if (offer && key) this.show(offer.time, offer.resumed);
  }

  private show(time: number, resumed: boolean) {
    const { player } = this.ctx;
    const resume = h("button", { class: "btn primary small", type: "button" }, "Resume");
    const restart = h("button", { class: "btn small", type: "button" }, "Start over");
    const countdown = h("span", { class: "vq-prompt-timer", style: { animationDuration: `${RESUME_PROMPT_MS}ms` } });
    const question = resumed
      ? h("span", null, "Continue from ", h("b", null, formatTime(time)), "?")
      : h("span", null, "Pick up at ", h("b", null, formatTime(time)), "?");
    const card = h("div", { class: "vq-prompt", role: "dialog", "aria-label": "Continue watching" },
      h("div", { class: "vq-prompt-text" }, icon("clock", 16), question),
      h("div", { class: "vq-prompt-actions" }, restart, resume),
      countdown);
    resume.addEventListener("click", () => player.acceptResume());
    restart.addEventListener("click", () => (resumed ? player.startOver() : player.dismissResumeOffer()));
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
