import {createRoot} from "react-dom/client";
import {flushSync} from "react-dom";
import {MediaViewer} from "../../src/ds/components";

/** Real Canvas/File/React lifecycle regression; no network or stored user media. */
export async function runMediaPreviewRaceChecks(){
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
  const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  const image=(color:string)=>{const canvas=document.createElement("canvas");canvas.width=64;canvas.height=48;canvas.getContext("2d")!.fillStyle=color;canvas.getContext("2d")!.fillRect(8,8,48,32);return canvas.toDataURL("image/png");};
  const a=image("red"),b=image("blue");
  let resolveSave:(value:{src:string;name:string}|undefined)=>void=()=>{},rejectSave:(error:Error)=>void=()=>{},requested:()=>void=()=>{};
  const save=()=>{requested();return new Promise<{src:string;name:string}|undefined>((resolve,reject)=>{resolveSave=resolve;rejectSave=reject;});};
  const render=(src:string,name:string,open=true)=>flushSync(()=>root.render(<MediaViewer open={open} src={src} name={name} mediaType="image" onCrop={save} onClose={()=>render(src,name,false)}/>));
  const button=(label:string)=>{const found=Array.from(document.querySelectorAll<HTMLButtonElement>('.ds-viewer button')).find(button=>button.textContent?.trim()===label);if(!found)throw Error(`Missing ${label}`);return found;};
  const beginCrop=async()=>{const started=new Promise<void>(resolve=>{requested=resolve;});button("Quick crop").click();await frame();button("Apply crop").click();await started;};
  const ready=async()=>{const img=document.querySelector<HTMLImageElement>('.ds-viewer__image img');if(img&&!img.complete)await img.decode();await frame();};
  const passed:string[]=[];let unmounted=false;
  try{
    render(a,"First image");await ready();await beginCrop();render(a,"First image",false);render(b,"Second image");await ready();resolveSave({src:a,name:"Late first crop"});await frame();
    check(document.querySelector<HTMLImageElement>('.ds-viewer__image img')?.src===b,"A late crop replaced the newer source.");check(!button("Quick crop").disabled,"The old busy state leaked into the new preview.");passed.push("late crop success cannot replace a reopened image");
    await beginCrop();render(a,"Third image");await ready();rejectSave(Error("Old crop failed"));await frame();
    check(!document.querySelector('.ds-viewer [role="alert"]'),"An old crop error appeared in a newer preview.");passed.push("late crop errors stay with their original preview");
    await beginCrop();let created=0;const original=URL.createObjectURL;URL.createObjectURL=(...args)=>{created++;return original.apply(URL,args);};
    try{flushSync(()=>root.unmount());unmounted=true;resolveSave(undefined);await frame();check(created===0,"An unmounted preview leaked a blob URL.");passed.push("unmounted crop completion creates no orphaned blob URL");}finally{URL.createObjectURL=original;}
    return passed;
  }finally{if(!unmounted)flushSync(()=>root.unmount());host.remove();}
}
