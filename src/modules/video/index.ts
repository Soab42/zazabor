import type { ModuleFactory } from "../../shell/module";
import { VideoModule } from "./module";
import "./video.css";

/** Creates the Video module. */
export const createVideoModule: ModuleFactory = (shell) => new VideoModule(shell);
