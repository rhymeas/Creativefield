import {Play} from "lucide-react";
import "./drop-stack.css";

/* A box that receives dragged images: a fanned stack of white cards with a play marker, filling the slot underneath.
   It never takes the pointer, so the drop still reaches the slot's own drop target. */
export function DropStack({ label }: { label: string }) {
  return (
    <div className="ds-dropstack" role="status" aria-label={`Drop images for ${label}`}>
      <span className="ds-dropstack__card" aria-hidden />
      <span className="ds-dropstack__card" aria-hidden />
      <span className="ds-dropstack__card" aria-hidden />
      <span className="ds-dropstack__play" aria-hidden><Play size={14} /></span>
    </div>
  );
}
