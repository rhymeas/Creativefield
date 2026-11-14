export type DockItem = { id: string; top: number; height: number };

/** Layout preview only; the controlled order is committed on drop. */
export function dockLayout(items: DockItem[], active: string, delta: number, gap: number) {
  const moving = items.find(item => item.id === active);
  if (!moving) return items;
  let index = items.indexOf(moving);
  if (delta > 0) {
    while (index < items.length - 1 && moving.top + moving.height + delta > items[index + 1].top + items[index + 1].height / 2) index++;
  } else if (delta < 0) {
    while (index > 0 && moving.top + delta < items[index - 1].top + items[index - 1].height / 2) index--;
  }
  const rest = items.filter(item => item.id !== active);
  rest.splice(index, 0, moving);
  let top = items[0]?.top ?? 0;
  return rest.map(item => {
    const placed = { ...item, top };
    top += item.height + gap;
    return placed;
  });
}

/** Hidden, unavailable panels keep their saved slots. */
export function reorderVisible<T extends string>(order: T[], visible: string[]): T[] {
  const next = visible.filter((id): id is T => order.includes(id as T));
  if (new Set(next).size !== next.length) return order;
  let index = 0;
  return order.map(id => next.includes(id) ? next[index++] : id);
}
