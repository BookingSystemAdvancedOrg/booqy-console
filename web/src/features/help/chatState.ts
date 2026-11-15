/** Open the assistant from outside (the command palette) and know whether it is on. */

export const OPEN_EVENT = "booqy:help-chat";
let enabledNow = false;

export function openHelpChat() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Is the assistant on right now? (the palette then shows its action) */
export function helpChatEnabled(): boolean {
  return enabledNow;
}

export function setHelpChatEnabled(on: boolean) {
  enabledNow = on;
}
