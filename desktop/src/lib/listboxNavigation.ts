export interface NavigableItem {
  disabled?: boolean;
}

/** Returns the first non-disabled item index, or -1 if all items are disabled. */
export function firstEnabledIndex(items: readonly NavigableItem[]): number {
  return items.findIndex((item) => !item.disabled);
}

/** Returns the last non-disabled item index, or -1 if all items are disabled. */
export function lastEnabledIndex(items: readonly NavigableItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

/**
 * Picks the initial focused option index when opening a listbox: the selected
 * option if enabled, otherwise the first enabled option (or last when opened
 * with ArrowUp).
 */
export function initialListboxIndex(
  items: readonly NavigableItem[],
  selectedIndex: number,
  edge: "start" | "end" = "start",
): number {
  if (selectedIndex >= 0 && selectedIndex < items.length && !items[selectedIndex]?.disabled) {
    return selectedIndex;
  }
  return edge === "end" ? lastEnabledIndex(items) : firstEnabledIndex(items);
}

/**
 * Steps forward or backward to the next enabled item. When `wrap` is false,
 * stops at the first/last enabled item instead of wrapping around.
 */
export function nextEnabledIndex(
  items: readonly NavigableItem[],
  currentIndex: number,
  direction: -1 | 1,
  options: { wrap?: boolean } = {},
): number {
  const count = items.length;
  if (count === 0) return -1;

  if (options.wrap) {
    const start = currentIndex >= 0 && currentIndex < count ? currentIndex : direction === 1 ? -1 : 0;
    for (let step = 1; step <= count; step++) {
      const idx = (start + direction * step + count * 2) % count;
      if (!items[idx]?.disabled) return idx;
    }
    return -1;
  }

  let idx = currentIndex + direction;
  while (idx >= 0 && idx < count) {
    if (!items[idx]?.disabled) return idx;
    idx += direction;
  }
  return currentIndex >= 0 && currentIndex < count && !items[currentIndex]?.disabled
    ? currentIndex
    : firstEnabledIndex(items);
}
