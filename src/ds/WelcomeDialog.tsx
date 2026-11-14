import {useId,useRef,type ReactNode} from "react";
import {createPortal} from "react-dom";
import {X} from "lucide-react";
import {useModalFocus} from "./useModalFocus";
import "./welcome-dialog.css";

/** The first-visit greeting: the logo on a living stage (the start screen's reel, aurora and veil), a title that
    rises word by word, a few places to start (`PresetCard size="tool"`), and one primary action.
    `picks` must only hold tools that run here (rule 26); leave it out when none do. */
export function WelcomeDialog({open,onClose,logo,title,text,media,picks,note,action}:{
  open:boolean;
  onClose:()=>void;
  /** The CreativeField logo image source; it is the only brand-yellow element. */
  logo:string;
  title:string;
  text?:string;
  /** A decorative loop behind the stage, usually `RotatingVideo`. */
  media?:ReactNode;
  /** Up to four `PresetCard size="tool"` entries. */
  picks?:ReactNode;
  /** One L3 `Meta` fact next to the action. */
  note?:ReactNode;
  /** The single primary `Button`. */
  action:ReactNode;
}){
  const titleId=useId(),panel=useRef<HTMLDivElement>(null);
  useModalFocus(open,panel,onClose);
  if(!open)return null;
  const content=(
    <div className="ds-dialog__scrim ds-welcome__scrim" onMouseDown={e=>e.target===e.currentTarget&&onClose()}>
      <div className="ds-welcome" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
        <section className="ds-welcome__stage">
          <div className="ds-hero__bg" aria-hidden>
            {media}
            <span className="ds-hero__aurora"/><span className="ds-hero__aurora"/>
            <span className="ds-welcome__veil"/>
          </div>
          <button type="button" className="ds-welcome__close" aria-label="Close" onClick={onClose}><X size={16}/></button>
          <img className="ds-welcome__logo" src={logo} alt="CreativeField"/>
          <h2 id={titleId} className="ds-welcome__title">
            {title.split(" ").map((word,i)=><span key={i} className="ds-hero__word" style={{animationDelay:`${240+i*90}ms`}}>{word}</span>)}
          </h2>
          {text&&<p className="ds-welcome__text">{text}</p>}
        </section>
        {picks&&<div className="ds-welcome__picks">{picks}</div>}
        <footer className="ds-welcome__foot">
          <span className="ds-welcome__note">{note}</span>
          {action}
        </footer>
      </div>
    </div>
  );
  return typeof document==="undefined"?content:createPortal(content,document.body);
}
