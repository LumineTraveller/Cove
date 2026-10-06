/** Keep the image usable after both side panels have taken their space. */
export const MIN_DOCKED_SHARE_WIDTH = 640;

export function sharedChatNeedsDrawer(shellWidth: number, railWidth: number, chatWidth: number) {
  return shellWidth - railWidth - chatWidth < MIN_DOCKED_SHARE_WIDTH;
}
