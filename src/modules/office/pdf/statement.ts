import { save } from "../../../shared/dialog";
import { statementToExcel, tablesToExcel, type StatementHost } from "../../../shared/statements/flow";
import { showToast } from "../../files/ops/toast";
import type { EditorHost } from "../editor";

/**
 * Convert → Statement to Excel and Tables to Excel (src/shared/statements): the PDF on disk is
 * read again, so unsaved comments don't matter; a PDF never saved has to be saved first.
 */
export function convertToExcel(path: string | null, host: EditorHost, what: "statement" | "tables") {
  if (!path) return host.toast("Save the PDF first, then convert it.");
  const sh: StatementHost = {
    toast: (text, action) => (action ? showToast(text, action, 8000) : host.toast(text)),
    openSettings: (category) => host.shell.openSettings(category),
    openInSheets: (target) => host.shell.open({ kind: "office", path: target }),
  };
  if (what === "statement") return void statementToExcel(path, sh);
  void tablesToExcel(path, sh, (name) => save({ title: "Save the Tables as Excel", defaultPath: name, filters: [{ name: "Excel workbook", extensions: ["xlsx"] }] }));
}
