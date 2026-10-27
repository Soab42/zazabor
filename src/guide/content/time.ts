import type { GuideArticle } from "../types";

export const time: GuideArticle = {
  id: "time",
  title: "Time",
  icon: "stopwatch",
  group: "productivity",
  summary: "Check in for your working day, time your tasks, breaks and prayer, and write the day's report.",
  open: { module: "time", label: "Open Time" },
  topics: [
    {
      title: "Your working day",
      steps: [
        "Press **Check In** when you start (or **Check In at…** for an earlier time).",
        "Press **Start Task Timer**, pick a task in progress (or add one with its project) and add a note if you like.",
        "For a break, press **Short Break**, **Lunch**, **Prayer**, **Meeting** or **Other**. A running task pauses, and starts again when the break ends.",
        "Press **Check Out** when you finish.",
      ],
      tips: [
        "The counters show Total, Work, Break, Prayer, Lunch, Meeting, Others and Idle, ticking every second.",
        "The rail's Time button shows a dot while you're checked in: pulsing while a task runs, amber on a break.",
        "A day left checked in closes at midnight.",
      ],
    },
    {
      title: "Fix the log",
      steps: [
        "Today's log lists every session and break. Switch to another day range, or filter **Work** or **Breaks & Prayer**.",
        "Forgot to start a timer? Use **Log past session** or **Log past activity**.",
        "Click an entry to edit or delete it. Overlaps, future times and an end before the start are refused.",
      ],
      keys: [["Ctrl+F", "Search the log (Esc clears it)"]],
    },
    {
      title: "The daily report",
      steps: [
        "Open **Daily Report**: Zazabor writes it from the day's entries (check-in and check-out, time per task with notes, breaks, idle time).",
        "Edit the text, or press **Regenerate** to write it again.",
        "**Copy** it, **Save as Draft**, or **Submit Report**. There's one report per day; step back to earlier days.",
      ],
    },
  ],
  related: ["wallet", "notes"],
};
