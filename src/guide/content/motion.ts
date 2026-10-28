import type { GuideArticle } from "../types";

export const motionTemplates: GuideArticle = {
  id: "motion-templates",
  title: "Motion Templates & Brand Kits",
  icon: "videoEdit",
  group: "studio",
  summary: "Ready-made animated scenes for product videos and reels: fill in your words, pictures and logo, and they move like a designer made them.",
  open: { module: "studio", target: "video", label: "Open Video Editor" },
  topics: [
    {
      title: "Add a template",
      steps: [
        "In the Video Editor, open the **Templates** tab on the left (beside Media, Audio and Text).",
        "Pick a category, or type in **Search templates**. Filter by **Shape** and **Length**; the previews show the project's shape.",
        "Click a template to put it on the timeline at the playhead. It's one clip you can move, trim and split like any other.",
        "Turn on **Bangla preview** to see the templates with Bangla text.",
      ],
      tips: [
        "A few templates come with Zazabor; the rest come from Zazabor's online library and keep growing. Each downloads with its fonts the first time it's shown (they're small), so they work offline afterwards.",
        "Each template works in 9:16, 1:1, 4:5 and 16:9: the layout rearranges itself rather than cropping.",
      ],
    },
    {
      title: "Fill it in",
      steps: [
        "Select the template clip. The Inspector shows its **Content**: the texts, the pictures and the logo.",
        "Type your words. Long text shrinks and wraps the way the design allows, so it never runs off the screen.",
        "Drop a product photo into a picture slot. **Cut out product** removes its background with Photo's AI (the model downloads once, after asking).",
        "Change **Length** to stretch or squeeze the animation; its timing keeps its proportions.",
        "**Add suggested sounds** puts the template's whooshes and pops on the timeline at the right moments.",
      ],
    },
    {
      title: "Brand Kits: your colours and fonts, everywhere",
      steps: [
        "Press **Brand Kits…** (in the Templates tab or the Inspector) and **New kit**.",
        "Choose the **Primary**, **Secondary**, **Accent**, **Background** and **Text** colours, or press **Colours from logo** after choosing your **Logo**.",
        "Choose a font **Pairing** (or separate **Headings** and **Body** fonts), the **Roundness** of corners and the **Motion** feel: **Snappy**, **Smooth** or **Playful**.",
        "Press **Save kit**, then **Use on all templates** to restyle every template in the project at once.",
        "**Use for new templates** makes it the kit every new template starts with.",
      ],
      tips: [
        "Anything you changed by hand on one template stays; **Reset to kit** brings that template back to the kit.",
        "**Export Brand Kit** saves a .zazkit file to share or back up; **Import Brand Kits** reads one.",
        "About 30 fonts come with Zazabor, including Bangla ones (Hind Siliguri, Anek Bangla, Baloo Da 2, Tiro Bangla, Galada). All are free to use in commercial videos.",
      ],
    },
    {
      title: "Save, reuse and go further",
      steps: [
        "**Save to My Templates** keeps a template with your words, pictures and kit, ready for the next video.",
        "**Save as Poster** writes the current frame as a picture, for a post or a banner.",
        "**Ungroup to layers** turns a template into ordinary text, shape and picture clips you can change one by one (**Regroup** puts it back while you haven't changed them).",
      ],
      tips: [
        "Export takes longer with templates than with plain clips, because fast moves get motion blur.",
      ],
    },
  ],
  related: ["video-editor", "photo"],
};

export const screenRecorder: GuideArticle = {
  id: "screen-recorder",
  title: "Screen Recorder (preview)",
  icon: "recRecord",
  group: "studio",
  summary: "Record your screen, a window or an area, with your voice, the sound you hear and a camera bubble. Not finished yet: try it, but don't rely on it.",
  open: { module: "studio", target: "record", label: "Open Screen Recorder" },
  needs: "This is an early preview. Opening it lists your screens, microphones and cameras, and on some computers that has made Zazabor close; if that happens, it'll be fixed in a later version.",
  topics: [
    {
      title: "Record",
      steps: [
        "Open Studio and choose **Record Screen** (or type zazabor --record in a terminal, or press the shortcut set in Settings).",
        "Choose what to record: **Full Screen** (a screen, or **All screens**), **A Window**, or **An Area** (**Draw an Area**, then drag a box).",
        "Under **Sound and camera**, turn **System sound**, **Microphone** and **Camera** on or off. The meter shows your microphone's level.",
        "Choose the **Quality**: **Standard**, **Smooth** (60 fps) or **Small file**.",
        "Press **Start Recording**. After the countdown, a small bar shows the time with pause, mute and stop.",
      ],
    },
    {
      title: "After recording",
      steps: [
        "The recording plays back. **Trim…** cuts its start and end; **Save Trimmed** keeps the cut version.",
        "Recordings are saved in **Recordings** in your Videos folder (**Save Recordings In** changes that).",
        "**Open in Video Editor** starts a project with it; **Show in Files** and **Copy File** are there too.",
      ],
      tips: [
        "A Bluetooth headset's microphone only works in its call mode, which also makes everything you hear through it mono and low quality.",
      ],
    },
  ],
  related: ["video-editor", "studio"],
};
