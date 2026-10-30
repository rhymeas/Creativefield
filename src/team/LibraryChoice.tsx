import {TeamChoice,type TeamChoiceOption} from "./TeamChoice";

/** The one "Choose from library" button. Every screen that lets a person pick a file or a saved character from
 *  the project uses this, so its look and its words are defined here and nowhere else: only the words, no box
 *  (the tall quiet pill in the design system), "Change" once something is chosen. */
export function LibraryChoice({chosen=false,value,options,onChange,disabled=false,openSignal}:{chosen?:boolean;value:string;options:TeamChoiceOption[];onChange:(value:string)=>void;disabled?:boolean;openSignal?:number}){
  return <TeamChoice variant="pill" size="lg" prefix={false} label="Library" display={chosen?"Change":"Choose from library"} value={value} disabled={disabled} options={options} onChange={onChange} openSignal={openSignal}/>;
}
