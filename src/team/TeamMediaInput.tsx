import {useEffect,useState,type DragEvent} from "react";
import {Button,DropTarget,IconButton,MediaCard,MediaViewer,Meta,UploadSlot,useMediaEditor} from "../ds";
import {assetUrl,type Asset} from "./api";
import {LibraryChoice} from "./LibraryChoice";
import {Maximize2,Pencil,X} from "lucide-react";
/* Library tiles put their asset id on the drag under their own type; the drop target reads plain text. */
const assetDrag="application/x-comfyfield-asset";
/* Saved characters share the Library dialog with files; their values carry this prefix so a pick is routed to the right place. */
const characterPrefix="element:";
export function TeamMediaInput({label,type,representation,hint,accept,uploadLabel,file,selected,element,options,characters=[],uploading,openSignal,disabled,canUpload,onFile,onSelect,onCharacter,onUpload,workspace}:{label:string;type:string;representation?:"image"|"video";hint?:string;accept?:string;uploadLabel?:string;file:File|null;selected:Asset|undefined;/** A port fed by a saved Element shows that asset, so the slot is never blank. */element?:{name:string;src:string};options:Asset[];/** Saved characters, products or styles that can fill this port: they sit in the same Library dialog as the files, so there is one way to choose. */characters?:{value:string;label:string;kind:string;assetId:string}[];/** The words the box shows while a file is on its way into the project (empty when nothing is). */uploading?:string;/** Bumped by a screen to open the Library dialog from outside. */openSignal?:number;disabled:boolean;canUpload:boolean;onFile:(file:File|null)=>void;onSelect:(id:string)=>void;onCharacter?:(value:string)=>void;onUpload:()=>void;workspace:string}){
  const [preview,setPreview]=useState<string|null>(null),[viewerOpen,setViewerOpen]=useState(false);
  useEffect(()=>{if(!file){setPreview(null);return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  const selectedPreview=selected?assetUrl(workspace,selected.id):null,shown=preview??selectedPreview??element?.src??null;
  const editor=useMediaEditor(),physical=representation??(type==="video"?"video":type==="audio"?"audio":"image"),name=file?.name??selected?.name??element?.name??label;
  const allowed=!disabled&&canUpload,clear=()=>{if(!allowed)return;onFile(null);onSelect("");};
  /* A dropped Library asset fills this port, just like picking it in the pill below. */
  const dropAsset=(event:DragEvent)=>{const id=event.dataTransfer.getData(assetDrag);if(!id||!allowed)return;event.preventDefault();clear();onSelect(id);};
  return <div className="cf-form" onDropCapture={dropAsset}>
    {/* One drop zone: a file from this device, or a Library asset dragged onto it. The slot and the card
        below carry the copy and the box, so the target itself says nothing and draws no second frame. */}
    <DropTarget label="" busy={uploading||undefined} onDrop={id=>{if(!allowed)return;clear();onSelect(id);}}>
      {shown&&physical!=="audio"
        ?<MediaCard quiet viewLabel={`View ${label}`} onView={()=>setViewerOpen(true)} media={physical==="video"?<video src={shown} muted loop autoPlay playsInline aria-label={label}/>:<img src={shown} alt={label}/>} actions={<>
          <IconButton label="Full view" onClick={()=>setViewerOpen(true)}><Maximize2 size={14}/></IconButton>
          {editor.onEdit&&<IconButton label={physical==="image"?"Edit image":"Edit video"} onClick={()=>void Promise.resolve(editor.onEdit!({src:shown,name,mediaType:physical==="video"?"video":"image",intent:"edit"})).catch(()=>setViewerOpen(true))}><Pencil size={14}/></IconButton>}
          {allowed&&<IconButton label={`Remove ${label.toLowerCase()}`} onClick={clear}><X size={14}/></IconButton>}
        </>}/>
        :<UploadSlot label={label} hint={hint??"Drop a file or choose from this device"} accept={accept??(physical==="audio"?"audio/*":physical==="image"?"image/png,image/jpeg,image/webp":"video/mp4,video/webm,video/quicktime")} kinds={[physical]} previewKind={physical} preview={shown} disabled={disabled||!canUpload} removeLabel={`Remove ${label.toLowerCase()}`} onFile={f=>{if(!allowed)return;onFile(f);if(!f)onSelect("");}}/>}
    </DropTarget>
    {element&&<Meta>{element.name}</Meta>}
    {canUpload&&file&&<Button variant="secondary" disabled={disabled} onClick={onUpload}>{uploadLabel??"Upload to project"}</Button>}
    {/* One field: drop or choose a file above, or pick from what the project already has. */}<LibraryChoice chosen={!!(selected||element)} value={selected?.id??""} disabled={disabled} openSignal={openSignal} options={[...characters.map(c=>({value:`${characterPrefix}${c.value}`,label:c.label,note:c.kind,preview:{src:assetUrl(workspace,c.assetId),video:false}})),...options.map(a=>({value:a.id,label:a.name,note:a.media_type==="mask"?"Validated mask":a.parent_id?"New version":"Shared",...(a.media_type==="image"||a.media_type==="video"?{preview:{src:assetUrl(workspace,a.id),video:a.media_type==="video"}}:{})}))]} onChange={id=>{onFile(null);if(id.startsWith(characterPrefix)&&onCharacter)onCharacter(id.slice(characterPrefix.length));else onSelect(id);}}/>
    <MediaViewer open={viewerOpen} src={shown??""} name={name} mediaType={physical==="video"?"video":"image"} onClose={()=>setViewerOpen(false)} onCrop={file=>{onFile(file);onSelect("");}}/>
  </div>;
}
