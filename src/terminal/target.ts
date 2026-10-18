/** Keys typed into a terminal belong to the shell: app shortcuts leave them alone. */
export const isTerminalTarget = (target: EventTarget | null) => target instanceof Element && !!target.closest(".xterm");
