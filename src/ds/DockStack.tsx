import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { dockLayout, type DockItem } from "./dock-layout";

type Drag = {
  id: string; pointer: number; startY: number; y: number; x: number;
  scroll: number; items: DockItem[]; gap: number; started: boolean; order: string[];
};

/** Pointer-driven vertical docking. React and storage update only after a completed drop. */
export const DockStack = forwardRef<HTMLDivElement, {
  children: ReactNode; className?: string; onReorder: (order: string[]) => void; inert?:boolean;
}>(function DockStack({ children, className = "", onReorder,inert=false }, forwardedRef) {
  const root = useRef<HTMLDivElement | null>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const finishRef = useRef<(commit: boolean) => void>(() => {});
  const [announcement, announce] = useState("");
  useEffect(()=>{if(root.current)root.current.inert=inert;},[inert]);
  const panels = () => Array.from(root.current?.querySelectorAll<HTMLElement>(":scope > [data-dock-id]") ?? []);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clear() {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    panels().forEach(panel => { panel.getAnimations().forEach(animation => animation.cancel()); panel.style.transition = "none"; panel.style.transform = ""; delete panel.dataset.moving; });
    if (placeholder.current) placeholder.current.hidden = true;
    if (root.current) delete root.current.dataset.sorting;
  }

  function settle(order?: string[]) {
    const before = new Map(panels().map(panel => [panel.dataset.dockId!, panel.getBoundingClientRect().top]));
    clear();
    if (order) flushSync(() => onReorder(order));
    panels().forEach(panel => {
      const delta = (before.get(panel.dataset.dockId!) ?? panel.getBoundingClientRect().top) - panel.getBoundingClientRect().top;
      if (delta && !reduced()) panel.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
      panel.style.transition = "";
    });
  }

  function finish(commit: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (root.current?.hasPointerCapture(current.pointer)) root.current.releasePointerCapture(current.pointer);
    if (!current.started) return;
    const box = root.current!.getBoundingClientRect();
    const accepted = commit && current.x >= box.left - 40 && current.x <= box.right + 40;
    const label = panels().find(panel => panel.dataset.dockId === current.id)?.getAttribute("aria-label") ?? "Panel";
    settle(accepted ? current.order : undefined);
    announce(accepted ? `${label} moved to position ${current.order.indexOf(current.id) + 1} of ${current.order.length}.` : `${label} move canceled.`);
  }
  finishRef.current = finish;

  function draw() {
    const current = drag.current, element = root.current;
    if (!current?.started || !element) return;
    const box = element.getBoundingClientRect();
    const edge = 40;
    if (current.x >= box.left && current.x <= box.right) {
      const direction = current.y < box.top + edge ? -1 : current.y > box.bottom - edge ? 1 : 0;
      element.scrollTop += direction * 8;
    }
    const original = current.items.find(item => item.id === current.id)!;
    const last = current.items[current.items.length - 1];
    const delta = Math.max(current.items[0].top - original.top, Math.min(last.top + last.height - original.height - original.top, current.y - current.startY + element.scrollTop - current.scroll));
    const layout = dockLayout(current.items, current.id, delta, current.gap);
    current.order = layout.map(item => item.id);
    panels().forEach(panel => {
      const id = panel.dataset.dockId!;
      const original = current.items.find(item => item.id === id)!;
      const destination = layout.find(item => item.id === id)!;
      panel.style.transform = `translateY(${id === current.id ? delta : destination.top - original.top}px)`;
    });
    const slot = layout.find(item => item.id === current.id)!;
    if (placeholder.current) {
      placeholder.current.hidden = false;
      placeholder.current.style.top = `${slot.top}px`;
      placeholder.current.style.height = `${slot.height}px`;
    }
    frame.current = requestAnimationFrame(draw);
  }

  useEffect(() => {
    const blur = () => finishRef.current(false);
    addEventListener("blur", blur);
    return () => { removeEventListener("blur", blur); cancelAnimationFrame(frame.current); };
  }, []);

  return <div ref={element => {
    root.current = element;
    if (typeof forwardedRef === "function") forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }} className={`ds-dockstack ${className}`} aria-label="Editor panels"
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      const target = event.target as HTMLElement;
      const header = target.closest(".ds-dock__head");
      if (!header || (target.closest("button,input,select,textarea,[role=tab]") && !target.closest(".ds-dock__grip"))) return;
      const panel = header.closest<HTMLElement>("[data-dock-id]");
      if (!panel) return;
      const list = panels();
      list.forEach(item => item.getAnimations().forEach(animation => animation.cancel()));
      const stackTop = event.currentTarget.getBoundingClientRect().top;
      drag.current = {
        id: panel.dataset.dockId!, pointer: event.pointerId, startY: event.clientY, y: event.clientY, x: event.clientX,
        scroll: event.currentTarget.scrollTop, gap: parseFloat(getComputedStyle(event.currentTarget).rowGap) || 0,
        items: list.map(item => { const bounds = item.getBoundingClientRect(); return { id: item.dataset.dockId!, top: bounds.top - stackTop + event.currentTarget.scrollTop, height: bounds.height }; }),
        started: false, order: list.map(item => item.dataset.dockId!),
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      current.y = event.clientY; current.x = event.clientX;
      if (!current.started && Math.abs(current.y - current.startY) >= 5) {
        current.started = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.sorting = "true";
        const panel = panels().find(item => item.dataset.dockId === current.id)!;
        panel.querySelector<HTMLButtonElement>(".ds-dock__grip")?.focus({ preventScroll: true });
        panel.dataset.moving = "true";
        draw();
      }
    }}
    onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)}
    onKeyDown={event => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); finish(false); return; }
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key) || !(event.target as HTMLElement).closest(".ds-dock__grip")) return;
      event.preventDefault(); event.stopPropagation();
      const panel = (event.target as HTMLElement).closest<HTMLElement>("[data-dock-id]")!;
      const order = panels().map(item => item.dataset.dockId!);
      const index = order.indexOf(panel.dataset.dockId!);
      const next = index + (event.key === "ArrowUp" ? -1 : 1);
      if (next < 0 || next >= order.length) return;
      [order[index], order[next]] = [order[next], order[index]];
      settle(order);
      announce(`${panel.getAttribute("aria-label")} moved to position ${next + 1} of ${order.length}.`);
    }}>
    {children}
    <div ref={placeholder} className="ds-dockstack__slot" hidden aria-hidden="true" />
    <span className="ds-sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
});
