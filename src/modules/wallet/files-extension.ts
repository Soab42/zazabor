import type { ShellContext } from "../../shell/module";
import type { BrowserExtension } from "../files/browser";
import { isReceipt } from "./drops";

/**
 * Files' context menu for pictures and PDFs: "Attach to Wallet Transaction…" makes them a
 * transaction's receipts. Wallet's code loads only when it's chosen.
 */
export function walletFilesExtension(shell: ShellContext): BrowserExtension {
  return {
    itemMenu(entries) {
      if (!shell.config.features.wallet || !entries.length || entries.some((e) => e.dir || !isReceipt(e.path))) return [];
      return [{
        label: "Attach to Wallet Transaction…", icon: "paperclip",
        action: () => void import("./attach").then((m) => m.attachToTransaction(entries.map((e) => e.path), shell)),
      }];
    },
  };
}
