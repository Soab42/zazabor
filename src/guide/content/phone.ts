import type { GuideArticle } from "../types";

export const phone: GuideArticle = {
  id: "phone",
  title: "Phone",
  icon: "phone",
  group: "productivity",
  summary: "Your Android phone on this PC, like Phone Link: texts, calls, photos, files and notifications, and its screen.",
  open: { module: "phone", label: "Open Phone" },
  needs: "An Android phone with the Zazabor Link app, on the same Wi-Fi as this PC. Calls through this PC also need Bluetooth.",
  topics: [
    {
      title: "Link your phone",
      steps: [
        "Open **Phone** on the rail. Press **Get Zazabor Link** and install the app on the phone (it comes with every Zazabor Home release).",
        "Press **Turn On Phone Link**. This PC now shows up for phones on the same Wi-Fi.",
        "In Zazabor Link, tap **Phone Link** and pick this PC.",
        "Both screens show six digits. When they match, press **Pair** on both.",
      ],
      tips: [
        "Pairing questions show in whatever section is open, so you don't need to be in Phone.",
        "Everything between the phone and this PC is encrypted with a key made while pairing.",
        "On the phone, Zazabor Link asks for each permission (texts, call log, contacts, notifications, files, photos) one at a time. A tab whose permission wasn't given stays empty and says so.",
        "While the phone is away, Phone shows what it last saw, marked **Last synced**.",
      ],
    },
    {
      title: "Texts",
      steps: [
        "**Messages** lists the phone's conversations. Click one to read it.",
        "Type in the box at the bottom and press {Enter} to send ({Shift+Enter} starts a new line).",
        "The pencil (or {Ctrl+N}) starts a new message: pick a contact or type a number.",
      ],
      tips: [
        "New texts show as desktop notifications (Settings → Phone).",
        "Pictures and other attachments in a text open on the phone.",
      ],
      keys: [
        ["Ctrl+F", "Search conversations"],
        ["Ctrl+N", "New message"],
        ["Alt+1 … Alt+5", "Messages, Calls, Photos, Files, Notifications"],
      ],
    },
    {
      title: "Calls",
      steps: [
        "**Calls** shows the call history and the contacts. The handset beside one calls it; double-click a call to call back.",
        "Or type a number on the keypad (or just type digits) and press the green button.",
        "An incoming call shows a card at the top of the window, in any section: **Answer** or **Decline**.",
        "During a call the bar at the top has mute, the keypad, hold, where you hear the call (**PC** or **Phone**) and End.",
      ],
      tips: [
        "To talk through this PC, press **Set Up** on the \"Set up calls through this PC\" card. Zazabor Home then becomes the phone's Bluetooth hands-free, like a car kit. The phone must be paired with this PC in the system's Bluetooth settings first.",
        "Setting up calls restarts the sound server once, which cuts sound for a moment. Headsets keep working.",
        "Without Bluetooth calls, the phone places the call itself and the sound stays on the phone.",
      ],
    },
    {
      title: "Photos and files",
      steps: [
        "**Photos** shows the phone's recent pictures and videos. Click one to look at it; **Save** copies the original to this PC.",
        "{Ctrl}-click or {Shift}-click picks several to save together.",
        "**Files** browses the phone's storage. Double-click a folder to open it, or a file to download it.",
        "To send files to the phone, drop them from your desktop onto the Files list (they go into the open folder), or press **Upload**.",
        "Dropping files anywhere else in Phone sends them to the phone's **Download/Zazabor** folder.",
      ],
      tips: [
        "Files from the phone go to **Downloads › Zazabor Link** (change it in Settings → Phone).",
        "The **Transfers** button at the bottom of the sidebar shows what's moving, with Cancel.",
        "Deleting a file on the phone can't be undone: Android has no Trash for it.",
      ],
    },
    {
      title: "Notifications, ringing and the screen",
      steps: [
        "**Notifications** shows what's in the phone's notification shade. **Reply** answers right there; the × dismisses it on the phone too.",
        "**Ring** on the phone's card plays a loud sound on the phone until you touch it, to find it.",
        "**Mirror** shows the phone's screen on this PC: allow screen sharing on the phone, and it opens in Video.",
      ],
      tips: [
        "Mirroring uses Cast to Zazabor Home; Mirror turns it on if it was off.",
        "The ⋯ on the phone's card renames or forgets the phone, or switches to another paired phone.",
      ],
    },
  ],
  related: ["video-player", "settings"],
};
