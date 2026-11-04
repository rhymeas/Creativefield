import {useEffect,useRef,useState,type DragEvent} from "react";
import {ASSET_DRAG,Button,DropTarget,IconButton,MediaCard,MediaViewer,Meta,UploadSlot,acceptsFile,useMediaEditor} from "../ds";
import {assetUrl,request,workspacePath,type Asset} from "./api";
import {LibraryChoice} from "./LibraryChoice";
import {Maximize2,Pencil,Scissors} from "lucide-react";
import {EXAMPLE_DRAG,acceptsMediaType,readExampleFile} from "../ds/example-media";
import {LIBRARY_EXAMPLE_VIDEOS} from "./reels";
import "../ds/media-input-paste.css";
/* Saved characters share the Library dialog with files; their values carry this prefix so a pick is routed to the right place. */
const characterPrefix="element:";
export function TeamMediaInput({label,type,representation,accept,uploadLabel,file,selected,element,options,characters=[],uploading,openSignal,disabled,canUpload,onFile,onSelect,onCharacter,onUpload,onTrim,onLoadMore,loadingMore,loadMoreError,onReferenceClick,workspace,projectId}:{label:string;type:string;representation?:"image"|"video";/** Kept for callers; the empty box shows only its short name (rule 65). */hint?:string;accept?:string;uploadLabel?:string;file:File|null;selected:Asset|undefined;/** A port fed by a saved Element shows that asset, so the slot is never blank. */element?:{name:string;src:string};options:Asset[];/** Saved characters, products or styles that can fill this port: they sit in the same Library dialog as the files, so there is one way to choose. */characters?:{value:string;label:string;kind:string;assetId:string}[];/** The words the box shows while a file is on its way into the project (empty when nothing is). */uploading?:string;/** Bumped by a screen to open the Library dialog from outside. */openSignal?:number;disabled:boolean;canUpload:boolean;onFile:(file:File|null)=>void;onSelect:(id:string)=>void;onCharacter?:(value:string)=>void;onUpload:()=>void;onTrim?:()=>void;onLoadMore?:()=>void;loadingMore?:boolean;loadMoreError?:string;onReferenceClick?:()=>void;workspace:string;projectId?:string}){
  const exampleRequest=useRef(0);
  const pasteBox=useRef<HTMLDivElement>(null),pasteHovered=useRef(false);
  useEffect(()=>()=>{exampleRequest.current++;},[]);
  useEffect(()=>{exampleRequest.current++;},[file,selected?.id,element?.src,disabled,canUpload,workspace,projectId]);
  const [preview,setPreview]=useState<string|null>(null),[viewerOpen,setViewerOpen]=useState(false),[dropError,setDropError]=useState("");
  useEffect(()=>{if(!file){setPreview(null);return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  const selectedPreview=selected?assetUrl(workspace,selected.id):null,shown=preview??selectedPreview??element?.src??null;
  const editor=useMediaEditor(),physical=representation??(type==="video"?"video":type==="audio"?"audio":"image"),name=file?.name??selected?.name??element?.name??label;
  const allowed=!disabled&&canUpload,clear=()=>{if(!allowed)return;exampleRequest.current++;onFile(null);onSelect("");};
  const accepted=accept??`${physical}/*`;
  function pasteFile(next:File){if(!allowed)return;exampleRequest.current++;setDropError("");onFile(next);}
  useEffect(()=>{
    if(!shown||!allowed||physical==="audio")return;
    const handle=(event:ClipboardEvent)=>{
      const target=event.target as HTMLElement|null;
      if(event.defaultPrevented||target?.isContentEditable||target?.tagName==="TEXTAREA"||(target?.tagName==="INPUT"&&!['file','checkbox','radio','range','button'].includes((target as HTMLInputElement).type)))return;
      if(!pasteHovered.current&&!pasteBox.current?.contains(document.activeElement))return;
      const next=Array.from(event.clipboardData?.files??[]).find(f=>acceptsFile(accepted,f));
      if(next){event.preventDefault();pasteFile(next);}
    };
    document.addEventListener("paste",handle,true);
    return()=>document.removeEventListener("paste",handle,true);
  },[shown,allowed,accepted,onFile,physical]);
  /* A dropped Library asset fills this port, just like picking it in the pill below. */
  const useExample=(path:string)=>{if(!allowed)return;const request=++exampleRequest.current;setDropError("");void readExampleFile(path,accept??`${physical}/*`).then(file=>{if(request===exampleRequest.current)onFile(file);}).catch(error=>{if(request===exampleRequest.current)setDropError((error as Error).message);});};
  const dropAsset=(event:DragEvent)=>{if(!allowed)return;const example=event.dataTransfer.getData(EXAMPLE_DRAG);if(example){event.preventDefault();event.stopPropagation();useExample(example);return;}const id=event.dataTransfer.getData(ASSET_DRAG);if(id){event.preventDefault();event.stopPropagation();const current=++exampleRequest.current,asset=options.find(item=>item.id===id),accepted=accept??`${physical}/*`;setDropError("");const choose=(actual:Asset)=>{if(current!==exampleRequest.current)return;if(projectId&&actual.project_id!==projectId){setDropError("Choose media from this project.");return;}if(!acceptsMediaType(accepted,actual.content_type)){setDropError("This media does not match the input. Choose a compatible file.");return;}if(file)onFile(null);onSelect(id);};if(asset)choose(asset);else void request<Asset>(workspacePath(workspace,`assets/${encodeURIComponent(id)}`)).then(choose).catch(()=>{if(current===exampleRequest.current)setDropError("Could not load this media. Try again.");});return;}const files=Array.from(event.dataTransfer.files);if(shown&&physical!=="audio"&&files.length){event.preventDefault();event.stopPropagation();const accepted=accept??(physical==="image"?"image/png,image/jpeg,image/webp":"video/mp4,video/webm,video/quicktime");if(files.length!==1||!acceptsFile(accepted,files[0])){setDropError("This media does not match the input. Choose a compatible file.");return;}setDropError("");exampleRequest.current++;onFile(files[0]);}};
  return <div className="cf-form" onDropCapture={dropAsset}>
    {/* One drop zone: a file from this device, or a Library asset dragged onto it. The slot and the card
        below carry the copy and the box, so the target itself says nothing and draws no second frame. */}
    <div className="ds-media-input__box" ref={pasteBox} onPointerEnter={()=>{pasteHovered.current=true;}} onPointerLeave={()=>{pasteHovered.current=false;}}><DropTarget label="" busy={uploading||undefined} onDrop={id=>{if(!allowed)return;clear();onSelect(id);}}>
      {shown&&physical!=="audio"
        ?<MediaCard quiet onRemove={allowed?clear:undefined} removeLabel={`Remove ${label.toLowerCase()}`} viewLabel={onReferenceClick?`Insert ${label} in prompt`:`View ${label}`} onView={onReferenceClick??(()=>setViewerOpen(true))} media={physical==="video"?<video src={shown} muted loop autoPlay playsInline aria-label={label}/>:<img src={shown} alt={label}/>} actions={<>
          <IconButton label="Full view" onClick={()=>setViewerOpen(true)}><Maximize2 size={14}/></IconButton>
          {physical==="video"&&selected&&onTrim&&allowed&&<IconButton label="Trim video" onClick={onTrim}><Scissors size={14}/></IconButton>}
          {editor.onEdit&&<IconButton label={physical==="image"?"Edit image":"Edit video"} onClick={()=>void Promise.resolve(editor.onEdit!({src:shown,name,mediaType:physical==="video"?"video":"image",intent:"edit"})).catch(()=>setViewerOpen(true))}><Pencil size={14}/></IconButton>}
        </>}/>
        :<UploadSlot label={label.replace(/\s*\(optional\)$/i,"")} hint="" accept={accept??(physical==="audio"?"audio/*":physical==="image"?"image/png,image/jpeg,image/webp":"video/mp4,video/webm,video/quicktime")} kinds={[physical]} previewKind={physical} preview={shown} disabled={disabled||!canUpload} removeLabel={`Remove ${label.toLowerCase()}`} onFile={f=>{if(!allowed)return;exampleRequest.current++;setDropError("");onFile(f);if(!f)onSelect("");}}/>}
    </DropTarget></div>
    {dropError&&<Meta>{dropError}</Meta>}
    {element&&<Meta>{element.name}</Meta>}
    {canUpload&&file&&<Button variant="secondary" disabled={disabled} onClick={onUpload}>{uploadLabel??"Upload to project"}</Button>}
    {/* One field: drop or choose a file above, or pick from what the project already has. */}<LibraryChoice chosen={!!(selected||element)} value={selected?.id??""} disabled={disabled} openSignal={openSignal} onLoadMore={onLoadMore} loadingMore={loadingMore} loadMoreError={loadMoreError} options={[...characters.map(c=>({value:`${characterPrefix}${c.value}`,label:c.label,note:c.kind,preview:{src:assetUrl(workspace,c.assetId),video:false}})),...options.map(a=>({value:a.id,label:a.name,note:a.media_type==="mask"?"Validated mask":a.parent_id?"New version":"Shared",...(a.media_type==="image"||a.media_type==="video"?{preview:{src:assetUrl(workspace,a.id),video:a.media_type==="video"}}:{})})),...(canUpload&&acceptsMediaType(accept??`${physical}/*`,"video/mp4")?LIBRARY_EXAMPLE_VIDEOS.map((src,index)=>({value:`example:${src}`,label:`Example ${index+1}`,note:"Example",preview:{src,video:true}})):[])]} onChange={id=>{if(id.startsWith("example:")){useExample(id.slice(8));return;}exampleRequest.current++;setDropError("");onFile(null);if(id.startsWith(characterPrefix)&&onCharacter)onCharacter(id.slice(characterPrefix.length));else onSelect(id);}}/>
    <MediaViewer open={viewerOpen} src={shown??""} name={name} mediaType={physical==="video"?"video":"image"} onClose={()=>setViewerOpen(false)} onCrop={file=>{exampleRequest.current++;onFile(file);onSelect("");}}/>
  </div>;
}
