import { blankModel, type Model } from "./engine";

type Builder = (m: Model) => void;

/** Fills cells from rows of text (each cell as if typed: numbers, dates and =formulas work). */
function put(m: Model, top: number, left: number, rows: (string | number | null)[][]) {
  rows.forEach((row, i) => row.forEach((value, j) => {
    if (value != null && value !== "") m.setUserInput(0, top + i, left + j, String(value));
  }));
}

const area = (row: number, column: number, height = 1, width = 1) => ({ sheet: 0, row, column, width, height });

function style(m: Model, a: ReturnType<typeof area>, changes: [string, string][]) {
  for (const [path, value] of changes) m.updateRangeStyle(a, path, value);
}

const TAKA = `"৳"#,##0`;
const HEAD: [string, string][] = [["font.b", "true"], ["fill.color", "#1f7a4d"], ["font.color", "#ffffff"]];
const TITLE: [string, string][] = [["font.b", "true"], ["font.size", "20"], ["font.color", "#1f5f3c"]];

/** Row 1 holds the title: tall enough for its 20 pt text. */
function titleRow(m: Model) {
  m.setRowsHeight(0, 1, 1, 44);
}

const BUILDERS: Record<string, Builder> = {
  budget(m) {
    m.renameSheet(0, "Budget");
    put(m, 1, 1, [["Monthly Budget"], [`=TEXT(TODAY(),"mmmm yyyy")`]]);
    put(m, 4, 1, [
      ["Income", "Planned", "Actual", "Difference"],
      ["Salary", 60000, 60000, "=C5-B5"],
      ["Freelance", 10000, 8500, "=C6-B6"],
      ["Other", 0, 0, "=C7-B7"],
      ["Total income", "=SUM(B5:B7)", "=SUM(C5:C7)", "=C8-B8"],
    ]);
    put(m, 10, 1, [
      ["Expenses", "Planned", "Actual", "Difference"],
      ["Rent", 18000, 18000, "=B11-C11"],
      ["Food and groceries", 12000, 13250, "=B12-C12"],
      ["Transport", 4000, 3600, "=B13-C13"],
      ["Electricity, gas and water", 3500, 3200, "=B14-C14"],
      ["Internet and mobile", 1500, 1500, "=B15-C15"],
      ["Education", 3000, 3000, "=B16-C16"],
      ["Health", 2000, 800, "=B17-C17"],
      ["Family", 5000, 5000, "=B18-C18"],
      ["Savings", 10000, 10000, "=B19-C19"],
      ["Other", 2000, 2650, "=B20-C20"],
      ["Total expenses", "=SUM(B11:B20)", "=SUM(C11:C20)", "=B21-C21"],
    ]);
    put(m, 24, 1, [["Left over", "=B8-B21", "=C8-C21", "=C24-B24"]]);
    style(m, area(1, 1), TITLE);
    titleRow(m);
    style(m, area(2, 1), [["font.color", "#5f6368"]]);
    for (const row of [4, 10]) style(m, area(row, 1, 1, 4), HEAD);
    for (const row of [8, 21, 24]) style(m, area(row, 1, 1, 4), [["font.b", "true"], ["fill.color", "#e8f3ec"]]);
    style(m, area(5, 2, 20, 3), [["num_fmt", TAKA]]);
    m.setColumnsWidth(0, 1, 1, 230);
    m.setColumnsWidth(0, 2, 4, 120);
    m.addConditionalFormatting(0, "D11:D20", { type: "CellIs", operator: "LessThan", formula: "0", formula2: null, format: { font: { color: "#9c0006" }, fill: { color: "#ffc7ce" } }, stop_if_true: false });
  },
  invoice(m) {
    m.renameSheet(0, "Invoice");
    put(m, 1, 1, [
      ["INVOICE", null, null, "Invoice no.", "INV-0001"],
      [null, null, null, "Date", `=TODAY()`],
      [null, null, null, "Due", `=E2+14`],
      ["From", null, null, "Bill to"],
      ["Your name or company"], ["Address"], ["Phone · email"],
    ]);
    put(m, 4, 4, [[null], ["Client name"], ["Client address"], ["Client phone · email"]]);
    put(m, 9, 1, [
      ["Description", null, "Qty", "Unit price", "Amount"],
      ["Design work", null, 10, 1500, "=C10*D10"],
      ["Development", null, 20, 2500, "=C11*D11"],
      ["Hosting (1 year)", null, 1, 6000, "=C12*D12"],
      [null, null, null, null, "=C13*D13"],
      [null, null, null, null, "=C14*D14"],
    ]);
    put(m, 16, 4, [["Subtotal", "=SUM(E10:E14)"], ["Tax rate", "5%"], ["Tax", "=E16*E17"], ["Total", "=E16+E18"]]);
    put(m, 21, 1, [["Thank you for your business."]]);
    style(m, area(1, 1), TITLE);
    titleRow(m);
    style(m, area(4, 1, 1, 5), [["font.b", "true"], ["font.color", "#1f5f3c"]]);
    style(m, area(9, 1, 1, 5), HEAD);
    for (let r = 10; r <= 14; r++) m.mergeCells(area(r, 1, 1, 2));
    m.mergeCells(area(9, 1, 1, 2));
    style(m, area(10, 4, 10, 2), [["num_fmt", TAKA]]);
    style(m, area(2, 5, 2, 1), [["num_fmt", "dd mmm yyyy"]]);
    style(m, area(19, 4, 1, 2), [["font.b", "true"], ["fill.color", "#e8f3ec"], ["font.size", "14"]]);
    style(m, area(21, 1), [["font.i", "true"], ["font.color", "#5f6368"]]);
    m.setColumnsWidth(0, 1, 1, 200);
    m.setColumnsWidth(0, 2, 2, 60);
    m.setColumnsWidth(0, 4, 5, 125);
  },
  todo(m) {
    m.renameSheet(0, "To-do");
    put(m, 1, 1, [["To-do list"]]);
    put(m, 3, 1, [
      ["Task", "Priority", "Due", "Status", "Notes"],
      ["Pay the electricity bill", "High", `=TODAY()+2`, "Not started", ""],
      ["Renew the passport", "Medium", `=TODAY()+20`, "In progress", "Photos ready"],
      ["Plan the weekend trip", "Low", `=TODAY()+9`, "Not started", ""],
      ["Send the invoice", "High", `=TODAY()`, "Done", ""],
    ]);
    put(m, 9, 1, [[`=COUNTIF(D4:D100,"Done")&" of "&COUNTA(A4:A100)&" done"`]]);
    style(m, area(1, 1), TITLE);
    titleRow(m);
    style(m, area(3, 1, 1, 5), HEAD);
    style(m, area(4, 3, 60, 1), [["num_fmt", "dd mmm"]]);
    m.setColumnsWidth(0, 1, 1, 240);
    m.setColumnsWidth(0, 2, 4, 105);
    m.setColumnsWidth(0, 5, 5, 220);
    m.setFrozenRowsCount(0, 3);
    m.addConditionalFormatting(0, "D4:D100", { type: "Text", operator: "Equals", value: "Done", format: { font: { color: "#006100", strike: true }, fill: { color: "#c6efce" } }, stop_if_true: false });
    m.addConditionalFormatting(0, "B4:B100", { type: "Text", operator: "Equals", value: "High", format: { font: { color: "#9c0006", b: true } }, stop_if_true: false });
  },
  timesheet(m) {
    m.renameSheet(0, "Timesheet");
    put(m, 1, 1, [["Timesheet"], ["Name", "Your name"], ["Week of", `=TODAY()-WEEKDAY(TODAY(),2)+1`]]);
    put(m, 5, 1, [["Day", "Date", "Start", "End", "Break (min)", "Hours"]]);
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    days.forEach((day, i) => {
      const r = 6 + i;
      put(m, r, 1, [[day, `=$B$3+${i}`, i < 5 ? "09:00" : "", i < 5 ? "18:00" : "", i < 5 ? 60 : "", `=IF(AND(C${r}<>"",D${r}<>""),(D${r}-C${r})*24-E${r}/60,0)`]]);
    });
    put(m, 13, 5, [["Total", "=SUM(F6:F12)"]]);
    style(m, area(1, 1), TITLE);
    titleRow(m);
    style(m, area(5, 1, 1, 6), HEAD);
    style(m, area(3, 2), [["num_fmt", "dd mmm yyyy"]]);
    style(m, area(6, 2, 7, 1), [["num_fmt", "ddd dd mmm"]]);
    style(m, area(6, 3, 7, 2), [["num_fmt", "h:mm AM/PM"]]);
    style(m, area(6, 6, 8, 1), [["num_fmt", "0.00"]]);
    style(m, area(13, 5, 1, 2), [["font.b", "true"], ["fill.color", "#e8f3ec"]]);
    m.setColumnsWidth(0, 1, 6, 110);
  },
};

/** A template as IronCalc's bytes (loaded with no undo history). */
export function buildTemplate(id: string): Uint8Array {
  const m = blankModel("Book");
  try {
    BUILDERS[id]?.(m);
    m.evaluate();
    return m.toBytes();
  } finally {
    m.free();
  }
}
