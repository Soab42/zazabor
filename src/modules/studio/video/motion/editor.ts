import type { Aspect } from "../../app";
import { TemplateBrowser } from "./browser";
import type { MenuItem } from "../../../../ui/menu";
import { templateContent, templateInfo, templateLook, templateMenu, type TemplateActions } from "./fields";
import { openKits } from "./kits";
import { MyTemplates } from "./mine";
import { MotionTools, type MotionHost } from "./tools";
import type { Syncs } from "../controls";
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

  /** The left panel's Templates tab: its pinned head, its cards, its ⋯ menu and its search. */
  readonly tab = {
    head: (): Node[] => this.browser.head(),
    body: (): Node[] => this.browser.body(),
    menu: (): MenuItem[] => this.browser.menu(),
    focusSearch: () => this.browser.focusSearch(),
  };

  private get actions(): TemplateActions {
    return {
      openKits: () => this.openKits(),
      saveToMine: (clip) => void this.mine.saveClip(clip),
      exportPackage: (clip) => void this.mine.exportClip(clip),
    };
  }

  /** The inspector's views of a template clip: its name, its Content and Look tabs and its ⋯ menu. */
  readonly views = {
    info: (id: string) => templateInfo(this.tools, id),
    content: (id: string, syncs: Syncs): Node[] => templateContent(this.tools, id, syncs),
    look: (id: string, syncs: Syncs): Node[] => templateLook(this.tools, this.actions, id, syncs),
    menu: (id: string): MenuItem[] => templateMenu(this.tools, this.actions, id),
  };

  openKits() {
    openKits(this.tools, { selected: () => {
      const id = this.selected();
      return id && this.tools.clip(id) ? id : null;
    } });
  }
}
