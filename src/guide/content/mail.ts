import type { GuideArticle } from "../types";

export const mail: GuideArticle = {
  id: "mail",
  title: "Mail",
  icon: "mail",
  group: "productivity",
  summary: "All your email accounts in one inbox: read conversations, search offline, and answer from the account a message came to.",
  open: { module: "mail", label: "Open Mail" },
  topics: [
    {
      title: "Add an account",
      steps: [
        "Open **Mail** on the rail and press **Add an Email Account** (later: **Add Account** at the bottom of the sidebar).",
        "Enter your name, your email address and the password. Zazabor works out the mail servers from the address.",
        "Press **Add Account**. Zazabor signs in to check both reading and sending, then starts bringing your mail in, newest first.",
      ],
      tips: [
        "**Gmail, Yahoo, iCloud, Fastmail and AOL** want an *app password* here, not your usual one: a note under the password says so and links to the page that makes one.",
        "**Outlook.com, Hotmail and most Microsoft 365** accounts only let mail apps in through Microsoft's own sign-in page, which Zazabor doesn't do yet.",
        "**Proton Mail** works through Proton Mail Bridge: start it and use the password Bridge shows.",
        "For any other address, open **Server settings** to check or type the IMAP and SMTP servers your provider gives you.",
        "Passwords are kept in your desktop's keyring. Mail is kept on this computer, so it reads and searches without a connection.",
      ],
    },
    {
      title: "Several inboxes",
      steps: [
        "**All Inboxes** at the top shows every account's new mail together; a coloured bar on each row says which account it came to.",
        "**Starred**, **Drafts** and **All Sent** work across accounts too.",
        "Under them each account has its own folders. Click an account's name to fold its folders away; the gear beside it opens its settings (name, colour, signature, password, servers).",
      ],
      tips: [
        "The rail's dot on Mail shows while an inbox has unread mail; new mail also shows as a desktop notification.",
        "New mail arrives as it's sent (the inbox is watched), and every folder is checked every few minutes. {F5} checks now.",
        "A red note under an account means it can't sign in: click it to fix the password.",
      ],
    },
    {
      title: "Read",
      steps: [
        "Click a conversation, or move through the list with {↑} and {↓} (or {J} and {K}). Its messages stack in the reading pane, the newest and the unread ones open.",
        "Click a folded message's line to open it. The **…** under an answer shows the earlier messages it quotes.",
        "Click an attachment to open it; the arrow on it (or a right-click) saves it where you choose.",
      ],
      tips: [
        "Pictures a message loads from the web are hidden until you press **Show Pictures**, because loading them tells the sender you opened it. **Always Show** stops asking.",
        "Messages run no scripts, and links open in your browser.",
        "**Unsubscribe** appears beside the recipients when the sender offers it.",
      ],
      keys: [
        ["↑ ↓ or J K", "Previous or next conversation"],
        ["Space", "Scroll the message"],
        ["E", "Archive"],
        ["Delete or #", "Move to Trash (from Trash: delete for good)"],
        ["U", "Mark read or unread"],
        ["S", "Star"],
        ["V", "Move to a folder"],
        ["!", "Junk"],
        ["X", "Tick the conversation"],
        ["Ctrl+A", "Select all"],
        ["/ or Ctrl+F", "Search"],
        ["F5", "Check for mail"],
      ],
    },
    {
      title: "Write and answer",
      steps: [
        "Press **New Message** (or {C}), or **Reply**, **Reply to All** or **Forward** on a conversation ({R}, {A}, {F}).",
        "Type addresses in **To**: people you've written to or heard from are suggested. **Cc Bcc** adds those lines.",
        "With several accounts, **From** picks which one sends; an answer starts from the account the message came to.",
        "Attach files with the paperclip, then press **Send** ({Ctrl+Enter}).",
      ],
      tips: [
        "**Undo** shows for five seconds after Send and brings the message back to edit.",
        "Closing the window keeps what you wrote in **Drafts**.",
        "Forwarding takes the original's attachments along.",
        "Each account's signature (in its settings) is put under a new message.",
      ],
    },
    {
      title: "Search and tidy",
      steps: [
        "Type in the search field: it looks through senders, recipients, subjects and the text of every message on this computer, in all accounts.",
        "Tick several conversations (hover the picture, or {Ctrl}-click and {Shift}-click) to archive, delete, star or move them together.",
        "The filter button shows only unread mail.",
      ],
      tips: [
        "**Undo** after archiving or deleting puts the conversations back.",
        "A folder shows its newest messages first; **Load older messages** at the end of the list fetches more from the server.",
      ],
    },
  ],
  related: ["settings", "privacy-lock"],
};
