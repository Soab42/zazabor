import type { Aspect } from "../../app";
import { TemplateBrowser } from "./browser";
import { templateView } from "./fields";
import { openKits } from "./kits";
import { MyTemplates } from "./mine";
import { MotionTools, type MotionHost } from "./tools";
import type { Syncs } from "./ui";
import "./motion.css";

/**
 * Motion templates in the Video Editor, as one piece the editor holds: the Templates tab, the
 * inspector for template clips, Brand Kits and My Templates.
 */
export class MotionFeatures {
  readonly tools: MotionTools;
  readonly mine: MyTemplates;
  private browser: TemplateBrowser;

  constructor(host: MotionHost, aspect: () => Aspect, private selected: () => string | null) {
    this.tools = new MotionTools(host);
    this.mine = new MyTemplates(this.tools);
    this.browser = new TemplateBrowser(this.tools, this.mine, aspect, () => this.openKits());
  }

  /** The left panel's Templates tab. */
  renderTab(): Node[] {
    return this.browser.render();
  }

  /** The inspector's sections for a template clip. */
  view(id: string, syncs: Syncs): Node[] {
    return templateView(this.tools, {
      openKits: () => this.openKits(),
      saveToMine: (clip) => void this.mine.saveClip(clip),
      exportPackage: (clip) => void this.mine.exportClip(clip),
    }, id, syncs);
  }

  openKits() {
    openKits(this.tools, { selected: () => {
      const id = this.selected();
      return id && this.tools.clip(id) ? id : null;
    } });
  }
}
