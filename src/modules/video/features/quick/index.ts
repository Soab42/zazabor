import type { FeatureFactory } from "../../extensions";
import { quickHooks } from "../../quick-api";
import { Bookmarks, bookmarksTab } from "./bookmarks";
import { ResumePrompt } from "./resume";
import { sprites } from "./sprites";
import "./quick.css";

/**
 * Player chrome extras: seek-bar preview frames, the resume prompt, and bookmarks with chapters
 * (Bookmarks tab, Ctrl+B, ticks on the seek bar). The control bar, quick menus and key feedback
 * live in the module itself; `quick-api.ts` is the contract.
 */
export const quickFeature: FeatureFactory = (ctx) => {
  const bookmarks = new Bookmarks(ctx);
  const prompt = new ResumePrompt(ctx);
  const tab = bookmarksTab(ctx, bookmarks);
  quickHooks.addBookmark = () => bookmarks.addHere();

  const unsubscribe = ctx.player.subscribe(() => {
    const { player } = ctx;
    const { path, length } = player.state;
    if (player.current && path === player.current && length > 0) sprites.start(path, length);
    else if (!player.current) sprites.stop();
    bookmarks.followPlayer();
  });

  return {
    panelTabs: [tab],
    menuItems(place) {
      if (place === "open") return [];
      const has = ctx.player.current !== null;
      return [{ label: "Add Bookmark (Ctrl+B)", icon: "star", disabled: !has, action: () => bookmarks.addHere() }];
    },
    handleKey(e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "b") return false;
      if (!ctx.showingPlayer || !ctx.player.current) return false;
      bookmarks.addHere();
      return true;
    },
    dispose() {
      unsubscribe();
      prompt.dispose();
      bookmarks.dispose();
      sprites.stop();
      quickHooks.addBookmark = null;
    },
  };
};
