import type { GuideArticle } from "../types";
import { clipboard } from "./clipboard";
import { docs } from "./docs";
import { codeEditor, files } from "./files";
import { gallery, quickEdit, slideshows } from "./gallery";
import { gettingStarted } from "./getting-started";
import { motionTemplates, screenRecorder } from "./motion";
import { notes } from "./notes";
import { office } from "./office";
import { pdf } from "./pdf";
import { photo, studio } from "./photo";
import { sheets } from "./sheets";
import { backgroundQuit, install, privacyLock, settings, shortcuts, windows } from "./system";
import { terminal } from "./terminal";
import { time } from "./time";
import { videoEditor } from "./video-editor";
import { videoPlayer } from "./video-player";
import { wallet, walletStatements } from "./wallet";
import { whatsNew } from "./whats-new";

/** Every article, in the order the contents list them within each group. */
export const ARTICLES: GuideArticle[] = [
  gettingStarted,
  files, gallery, quickEdit, slideshows, videoPlayer, terminal, codeEditor,
  notes, time, wallet, walletStatements, clipboard,
  office, docs, sheets, pdf,
  studio, photo, videoEditor, motionTemplates, screenRecorder,
  settings, privacyLock, windows, backgroundQuit, install, shortcuts,
  whatsNew,
];
