import type {ReactNode} from "react";
import {Pill} from "../ds";
import {TeamChoice,type TeamChoiceOption} from "./TeamChoice";

/** The one "Choose from library" button. Every screen that lets a person pick a file or a saved character from
 *  the project uses this, so its look and its words are defined here and nowhere else: only the words, no box
 *  (the tall quiet pill in the design system), "Change" once something is chosen. */
export function LibraryChoice({chosen=false,value,options,onChange,disabled=false,openSignal,onLoadMore,loadingMore,loadMoreError,hideTrigger,uploadControl}:{chosen?:boolean;value:string;options:TeamChoiceOption[];onChange:(value:string)=>void;disabled?:boolean;openSignal?:number;onLoadMore?:()=>void;loadingMore?:boolean;loadMoreError?:string;hideTrigger?:boolean;uploadControl?:ReactNode}){
  return <TeamChoice hideTrigger={hideTrigger} uploadControl={uploadControl} variant="pill" size="lg" prefix={false} label="Library" display={chosen?"Change":"Choose from library"} value={value} disabled={disabled} options={options} onChange={onChange} openSignal={openSignal} onLoadMore={onLoadMore} loadingMore={loadingMore} loadMoreError={loadMoreError}/>;
}
/** The same button for a screen that opens its own library dialog (several pictures at once, for example). */
export function LibraryButton({chosen=false,disabled=false,onClick}:{chosen?:boolean;disabled?:boolean;onClick:()=>void}){
  return <Pill quiet size="lg" type="button" disabled={disabled} onClick={onClick}>{chosen?"Change":"Choose from library"}</Pill>;
}
