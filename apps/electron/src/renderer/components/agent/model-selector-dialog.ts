export function openModelSelectorAfterPopoverClose(
  closePopover: () => void,
  openModelSelector: () => void,
  schedule: (callback: () => void) => unknown = callback => setTimeout(callback, 0),
): void {
  closePopover()
  schedule(openModelSelector)
}
