import type { GuideArticle } from "../types";

export const wallet: GuideArticle = {
  id: "wallet",
  title: "Wallet",
  icon: "wallet",
  group: "productivity",
  summary: "Your money in one place: accounts and mobile wallets, spending and income, budgets, bills and reports.",
  open: { module: "wallet", label: "Open Wallet" },
  topics: [
    {
      title: "Set up your accounts",
      steps: [
        "In the sidebar, press **Add Account**. Choose cash, a bank account, a card, savings or a mobile wallet (bKash, Nagad, Rocket) and type its opening balance.",
        "Amounts are in taka with lakh and crore grouping (৳1,25,000). Another currency works too, at a rate you type.",
      ],
    },
    {
      title: "Add spending and income",
      steps: [
        "Click the **Quick add** bar ({Ctrl+K}) and type it as you'd say it: \"250 lunch bkash\" or \"+45000 salary city bank 25 oct\".",
        "Chips show how Zazabor understood it. Press {Enter} to add, or {Tab} to open the full form first.",
        "Or press **New** ({Ctrl+E}) for the full form: amount, category, account, payee, date and note.",
        "For money between your own accounts, choose a transfer; a fee (a bKash cash-out charge) goes to Fees.",
      ],
      keys: [
        ["Ctrl+K", "Quick add"],
        ["Ctrl+E", "New transaction"],
        ["Ctrl+F", "Search transactions"],
        ["Ctrl+H", "Hide amounts (for sharing your screen)"],
      ],
    },
    {
      title: "See where it goes",
      steps: [
        "**Overview** shows the total balance, the month's income and spending, budgets nearest their limit, and what's coming up.",
        "**Transactions** groups everything by day with day totals. Filter by span, account, category or kind; select several to see their sum.",
        "**Budgets**: set a monthly limit per category. Bars turn amber at 80% and red past 100%. **Copy Last Month** repeats last month's limits, and unspent money can roll over.",
        "**Reports**: spending by category, income and spending per month, and net worth, each with a table view.",
      ],
    },
    {
      title: "Bills",
      steps: [
        "Open **Bills** and press **New Bill**: rent, DESCO, Netflix, or income like a salary.",
        "Choose how often it repeats, and whether it posts by itself or only reminds you.",
        "A reminder shows as unpaid until you press **Mark Paid**. If Zazabor was closed for a while, missed periods catch up when it opens.",
      ],
    },
    {
      title: "Receipts",
      steps: [
        "In a transaction's form, press **Attach Receipt…** and pick a photo or PDF, or drop the file on the transaction.",
        "From Files, right-click a receipt and choose **Attach to Wallet Transaction…**.",
        "Wallet keeps its own copy, so moving or deleting the original doesn't lose it. A paperclip marks transactions with receipts.",
      ],
    },
    {
      title: "Earnings from Time",
      steps: [
        "In **Settings → Wallet**, give each Time project an hourly rate.",
        "The Earnings card then shows what Time's hours are worth; press **Record as Income** once a month.",
      ],
    },
    {
      title: "Backups and privacy",
      tips: [
        "A backup is made every day (the last 14 are kept). **Back Up Now** and **Restore** are in **Accounts** and **Settings → Wallet**.",
        "With the privacy lock on, Wallet hides completely while Zazabor is locked.",
      ],
    },
  ],
  related: ["wallet-statements", "time", "privacy-lock"],
};

export const walletStatements: GuideArticle = {
  id: "wallet-statements",
  title: "Statements, import & export",
  icon: "stStatement",
  group: "productivity",
  summary: "Upload a bank or bKash statement and Wallet fills itself in. Import and export Excel and CSV.",
  open: { module: "wallet", label: "Open Wallet" },
  needs: "Digital PDFs, CSV and Excel files are read on this computer. Scans and photos of a statement need Claude (Anthropic's AI): add your API key in **Settings → AI** and turn on **Send statements to Claude**.",
  topics: [
    {
      title: "Upload a statement",
      steps: [
        "Open **Import & Export** and press **Upload Statement…**, or drop the file there: a bank or bKash/Nagad statement as PDF, CSV or Excel.",
        "Zazabor reads it and finds the account by bank and the last four digits, or offers to create it (it remembers your choice).",
        "Review the rows: each has a category from your rules and past payees, and rows already in Wallet are marked as duplicates.",
        "Check the balance check: opening balance + credits − debits must equal the closing balance, row by row. Rows that don't add up are flagged, never changed.",
        "Press **Import … Transactions**. Changed your mind? **Undo Import** takes the whole statement back.",
      ],
      tips: [
        "Uploading the same statement twice adds nothing the second time.",
        "To skip the review when the balance check passes, turn on **Settings → Wallet → Import statements automatically**.",
        "There are no special profiles for particular banks yet; most layouts are read on their own.",
      ],
    },
    {
      title: "Scans and photos (Claude)",
      steps: [
        "Get an API key at console.anthropic.com.",
        "In **Settings → AI**, paste it under **Claude API key** (it's kept in your system keyring, never in the page), pick a model, and turn on **Send statements to Claude**.",
        "Press **Test the Key**.",
        "Now a scan or photo of a statement offers **Read with Claude…**. The statement is sent to Anthropic only then.",
      ],
      tips: ["AI is refused while Zazabor is locked. The balance check still runs on what Claude reads."],
    },
    {
      title: "Statement to Excel",
      steps: [
        "In the review, press **Save as Excel…** for a workbook with real dates and numbers, a summary sheet and flagged rows marked.",
        "In Office's PDF app, **Convert → Statement to Excel** does the same from a PDF, and **Tables to Excel** turns any tables into a workbook.",
      ],
    },
    {
      title: "Import and export your own files",
      steps: [
        "Press **Choose File…** to import any CSV or Excel file: Zazabor maps the date, description and money columns, and you can fix the mapping. Mappings and rules are saved for next time.",
        "Press **Export…** for CSV, Excel (a sheet per month) or JSON. **Open in Sheets** opens an export in Office.",
        "A file you exported can be imported again without making duplicates.",
      ],
    },
  ],
  related: ["wallet", "pdf", "sheets"],
};
