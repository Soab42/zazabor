import "./styles.css";
import { forwardLogsToTerminal } from "./api";
import { loadConfig } from "./config";
import { Shell } from "./shell/shell";

forwardLogsToTerminal();

loadConfig()
  .then((config) => new Shell(config).start())
  .catch((err) => console.error("CorePro failed to start:", err));
