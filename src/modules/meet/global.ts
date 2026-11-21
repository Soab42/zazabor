import type { ShellContext } from "../../shell/module";
import { isMainWindow } from "../../shell/windows";
import { showToast } from "../files/ops/toast";
import { errorText, meetApi, onMeet } from "./api";

/**
 * Meet in the main window, whatever section is open: a guest waiting in the lobby of a meeting
 * whose host window isn't open shows a toast with "Open meeting". Started by the shell.
 */

let started = false;

export function startMeetService(shell: ShellContext) {
  if (started || !isMainWindow) return;
  started = true;
  void onMeet("meet-knock", ({ meetingId, title, name }) => {
    if (!shell.config.features.meet) return;
    showToast(`${name} is waiting to join ${title}`, {
      label: "Open meeting",
      run: () => void meetApi.open(meetingId).catch((err) => showToast(`Couldn't open the meeting: ${errorText(err)}`)),
    }, 15_000);
  });
}
