import type {AiTextSettings} from "./api";

/** Who reads the reference images: the same choice the server makes (server/ai-text.ts imageTextProvider). */
export function imageReaderName(settings?:AiTextSettings){
  const reads=(id?:string)=>!!id&&id!=="local-comfy"&&!!settings?.providers.some(p=>p.id===id&&p.state==="ready");
  const id=reads(settings?.active)?settings!.active:settings?.providers.find(p=>reads(p.id))?.id;
  return id==="chatgpt"?"ChatGPT":id?"your text API":"";
}

/** The one word the busy button shows. The server answers in a single reply, so the steps follow the
 *  usual timing of that reply (upload about 2 s, reading about 10 s, then writing) rather than live events. */
export function promptStep(elapsedMs:number,reader:string){
  return !reader?"Sending your images…":elapsedMs<2000?`Sending to ${reader}…`:elapsedMs<12000?`${reader} is looking at your images…`:"Writing the prompt…";
}
