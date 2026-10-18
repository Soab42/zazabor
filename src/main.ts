import "./styles.css";
import { forwardLogsToTerminal } from "./api";
import { loadConfig } from "./config";
import { Shell } from "./shell/shell";
import { windowStart } from "./shell/windows";

forwardLogsToTerminal();

loadConfig()
  .then(async (config) => {
    // A file opened in its own window gets the viewer (and the editor, loaded with it) instead of the app.
    if (windowStart?.module === "viewer") return (await import("./viewer/viewer")).startViewer(config, windowStart.path);
    return new Shell(config).start();
  })
  .catch((err) => console.error("CorePro failed to start:", err));
