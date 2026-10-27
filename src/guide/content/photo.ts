import type { GuideArticle } from "../types";

export const studio: GuideArticle = {
  id: "studio",
  title: "Studio",
  icon: "studio",
  group: "studio",
  summary: "Photo (a layered photo editor) and the Video Editor (reels and videos), with their own rail like Office.",
  open: { module: "studio", target: "home", label: "Open Studio" },
  topics: [
    {
      title: "Start a project",
      steps: [
        "Studio's rail has **Home**, **Photo** and **Video**, then the projects you have open.",
        "On Home, choose **Edit a Photo** (open a picture), **New Canvas**, **Reel** (9:16 for TikTok, Reels and Shorts) or **Video** (16:9 for YouTube). Other shapes: 1:1 and 4:5.",
        "Recent projects are listed below; **Open…** ({Ctrl+O}) picks a file.",
        "Photo projects save as .coreimage and video projects as .corevideo. Opening one from Files gives it a Studio window of its own.",
      ],
      keys: [
        ["Ctrl+O", "Open"],
        ["Ctrl+S", "Save (Ctrl+Shift+S Save As)"],
        ["Ctrl+W", "Close the project"],
      ],
      tips: ["Unsaved reels are kept by AutoRecover; Home offers them back under **Recovered**."],
    },
  ],
  related: ["photo", "video-editor", "quick-edit"],
};

export const photo: GuideArticle = {
  id: "photo",
  title: "Photo",
  icon: "photoEdit",
  group: "studio",
  summary: "A Photoshop-style editor: layers, masks, selections, adjustments, brushes, filters, AI tools and RAW.",
  open: { module: "studio", target: "photo", label: "Open Photo" },
  needs: "The AI tools (Remove Background, Select Subject, Object Selection, Remove) run on this computer. Each model downloads once, after asking with its size; **Settings → Photo** lists them with **Remove**.",
  topics: [
    {
      title: "The workspace",
      steps: [
        "Menus along the top: **File**, **Edit**, **Image**, **Layer**, **Select**, **Filter** and **View**. The options bar below them changes with the tool.",
        "Tools down the left; press a tool's letter to pick it (below). The two colour squares are the foreground and background colours.",
        "On the right: **Adjustments**, **Layers** and **History** (up to 200 steps).",
        "Zoom with {Ctrl+=}/{Ctrl+-}, {Ctrl+0} to fit and {Ctrl+1} for 100%; hold {Space} or use the Hand ({H}) to pan.",
      ],
      keys: [
        ["V", "Move"],
        ["M", "Marquee (rectangle or ellipse)"],
        ["L", "Lasso (free or polygonal)"],
        ["W", "Magic Wand (Shift+W Object Selection)"],
        ["C", "Crop"],
        ["I", "Eyedropper"],
        ["J", "Healing Brush (Shift+J Remove)"],
        ["B", "Brush"],
        ["S", "Clone Stamp"],
        ["E", "Eraser"],
        ["G", "Gradient or Paint Bucket"],
        ["T", "Type"],
        ["U", "Shape"],
      ],
    },
    {
      title: "Layers and masks",
      steps: [
        "**Layer → New Layer** ({Ctrl+Shift+N}); **Layer via Copy** ({Ctrl+J}) copies the selection to a new layer.",
        "In the Layers panel, set each layer's blend mode (all 27) and opacity, hide it with the eye, and drag to reorder or into a group.",
        "**Layer → Add Mask** hides parts without erasing: paint black on the mask to hide, white to show.",
        "**Group Layers** ({Ctrl+G}), **Create Clipping Mask** ({Ctrl+Alt+G}), **Merge Down** ({Ctrl+E}), **Merge Visible** and **Flatten Image**.",
      ],
    },
    {
      title: "Selections",
      steps: [
        "Pick a marquee, lasso or the Magic Wand and drag or click. Hold Shift to add, Alt to take away.",
        "**Select** menu: **All** ({Ctrl+A}), **Deselect** ({Ctrl+D}), **Inverse** ({Ctrl+Shift+I}), **Color Range…**, **Feather…**, **Expand…**, **Contract…** and **Refine Edge…**.",
        "Brushes, fills, filters and adjustments only change what's selected.",
        "Cut, copy and paste with {Ctrl+X}, {Ctrl+C} and {Ctrl+V}; **Copy Merged** copies what you see.",
      ],
    },
    {
      title: "Adjust, paint and fix",
      steps: [
        "In **Adjustments**, pick Levels, Curves, Hue/Saturation, Colour Balance, Black & White and more. Each becomes an adjustment layer you can change later.",
        "**Image → Auto Tone** balances a photo in one go; **Image Size…**, rotate and flip are there too.",
        "Brush and Eraser have size, hardness, opacity, flow and pen pressure ({[} and {]} change the size).",
        "**Clone Stamp**: Alt-click where to copy from, then paint. **Healing Brush** blends the fix into its surroundings.",
        "**Edit → Free Transform** ({Ctrl+T}) moves, scales, rotates, skews or flips a layer or selection.",
        "**Filter** has Gaussian Blur, Motion Blur, Unsharp Mask and Add Noise; **Last Filter** repeats one ({Ctrl+Alt+F}).",
        "The Type tool ({T}) adds editable text; the Shape tool ({U}) adds shapes.",
      ],
    },
    {
      title: "AI tools",
      steps: [
        "**Layer → Remove Background**: the subject stays and the background is hidden by a mask (nothing is deleted).",
        "**Select → Subject** selects the main subject.",
        "**Object Selection** ({Shift+W}): click an object and it's selected. Shift-click adds another, Alt-click takes a part away.",
        "**Remove** ({Shift+J}): paint over something (a person, a wire, a spot) and it's filled in from around it.",
      ],
      tips: [
        "The first use of a model takes longer while it loads (about 18 seconds for the best subject finder); after that about 5 seconds per photo. **Settings → Photo** offers a faster subject model.",
        "Remove works best on small and medium objects; large holes in busy patterns can smear.",
      ],
    },
    {
      title: "RAW photos",
      steps: [
        "Open a RAW file (CR2, CR3, NEF, ARW, RAF, DNG and more) with **Edit a Photo** or from Files.",
        "The layer's Properties panel becomes **Develop**: white balance (**As Shot**, Daylight, Cloudy, Shade, Tungsten, Fluorescent, Flash or custom Temperature and Tint), Exposure, Highlights and Shadows, and sRGB or Display P3.",
        "Each change is one History step.",
      ],
      tips: ["Developing again throws away anything painted on the RAW layer; paint on a layer above it. Each change takes a few seconds on big files."],
    },
    {
      title: "Save and export",
      steps: [
        "**File → Save** keeps everything (layers, masks, text) as a .coreimage project, or as a Photoshop .psd.",
        "**File → Export As…** makes a JPEG, PNG, WebP, AVIF, TIFF or BMP with the layers merged.",
        "Pictures keep their colour profile.",
      ],
    },
  ],
  related: ["studio", "quick-edit", "gallery"],
};
