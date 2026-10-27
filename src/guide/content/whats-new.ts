import type { GuideArticle } from "../types";

export const whatsNew: GuideArticle = {
  id: "whats-new",
  title: "What's New",
  icon: "sparkles",
  group: "new",
  summary: "The highlights of this release.",
  topics: [
    {
      title: "CorePro is now Zazabor",
      tips: ["Same app, new name. Your settings, notes, wallet, time log and clipboard history came across on the first start, and your shortcuts now open Zazabor."],
    },
    {
      title: "This guide",
      tips: ["Press {F1} or the **?** on the rail for help on whatever you're doing. Search finds any step."],
    },
    {
      title: "Liquid Glass video player",
      tips: ["The player's controls float over the picture as macOS-style glass and fade away while you watch. [[video-player|Read more]]"],
    },
    {
      title: "Office",
      tips: [
        "**File** opens a real backstage with Info, Save As, Print preview, Export and Close. [[office|Read more]]",
        "Pictures in Docs wrap, move and size like in Word. [[docs|Read more]]",
        "PDF: redaction that keeps the rest of the page as text, **Edit Text**, OCR in English and Bangla, certificate signatures, PDF to Word and Excel, comment replies. [[pdf|Read more]]",
      ],
    },
    {
      title: "Wallet",
      tips: [
        "Upload a bank or bKash statement and Wallet fills itself in, with a balance check; scans are read by Claude when you allow it. [[wallet-statements|Read more]]",
        "Bills that post or remind, receipts, budget roll-over, Excel import and export, and earnings from Time. [[wallet|Read more]]",
      ],
    },
    {
      title: "Studio",
      tips: [
        "Photo: AI Remove Background, Select Subject, Object Selection and Remove; RAW photos with a Develop panel; masks, selections, adjustment layers, text and PSD. [[photo|Read more]]",
        "Video Editor: keyframes, chroma key, effects, voice-over, auto captions, stickers and sounds, and one-click codec install. [[video-editor|Read more]]",
        "Motion Templates: animated scenes for product videos and reels, with Brand Kits for your colours and fonts. [[motion-templates|Read more]]",
        "Screen Recorder, an early preview. [[screen-recorder|Read more]]",
      ],
    },
    {
      title: "Quit and background mode",
      tips: ["**Quit Zazabor** stops it completely, asking about unsaved Office files first. [[background-quit|Read more]]"],
    },
  ],
  related: ["getting-started"],
};
