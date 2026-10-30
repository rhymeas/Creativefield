import { useEffect, useRef, type RefObject } from "react";

/** Shared by Dialog and MediaViewer so keyboard focus stays in the topmost modal. */
export function useModalFocus(open: boolean, panel: RefObject<HTMLElement>, onClose: () => void) {
  const closing = useRef(onClose);
  closing.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      if (document.querySelector('[data-comfy-menu]') && (event.key === "Escape" ||
        (document.activeElement as Element | null)?.closest('[data-comfy-menu]'))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closing.current();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]',
      )).filter(element => element.tabIndex >= 0 && !element.closest('[inert]') &&
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      const first = items[0], last = items.at(-1), active = document.activeElement;
      if (!first) { event.preventDefault(); panel.current.focus(); }
      else if (event.shiftKey && (active === first || active === panel.current || !panel.current.contains(active))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (active === last || !panel.current.contains(active))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, panel]);
}
