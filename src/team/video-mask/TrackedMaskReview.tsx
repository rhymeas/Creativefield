import {useCallback,useEffect,useRef,useState} from "react";
import {Button,InfoButton,MaskOverlay,Meta,Notice,SliderField,Toolbar,TrackSticker} from "../../ds";
import {assetUrl,type Asset} from "../api";
import "./tracked-mask-review.css";
import {validatedMaskCoverage} from "../../capabilities/mask-coverage";
import {MaskCoverageStrip} from "./MaskCoverageStrip";

export function maskFrameBounds(rgba:Uint8ClampedArray,width:number,height:number){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||rgba.length!==width*height*4)throw new Error("Aligned mask pixels required");
  let minX=width,minY=height,maxX=-1,maxY=-1,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(rgba[(y*width+x)*4]>=128){count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  return {coverage:count/(width*height),box:count?{left:minX/width*100,top:minY/height*100,width:(maxX-minX+1)/width*100,height:(maxY-minY+1)/height*100}:null};
}
export function trackedReviewGeometry(source:Asset,mask:Asset){
  const s=(mask.metadata?.sourceLinkedMask??mask.metadata?.maskSequence) as {sourceAssetId?:string;sourceSha256?:string;width?:number;height?:number;fps?:number;frames?:number}|undefined;
  if(!s||s.sourceAssetId!==source.id||s.sourceSha256!==source.sha256||mask.parent_id!==source.id||mask.project_id!==source.project_id||mask.media_type!=="mask"||!mask.content_type.startsWith("video/")||s.fps!==16||!Number.isInteger(s.width)||!Number.isInteger(s.height)||!Number.isInteger(s.frames)||s.width!<=0||s.height!<=0||s.width!*s.height!>399360||s.frames!<17||s.frames!>81)return null;
  const n=mask.metadata?.maskNormalization as {originalSourceAssetId?:string;originalSourceSha256?:string;normalizedSourceAssetId?:string;normalizedMaskAssetId?:string;normalizedMaskSha256?:string}|undefined;
  if(n&&(n.originalSourceAssetId!==source.id||n.originalSourceSha256!==source.sha256||n.normalizedMaskAssetId!==mask.id||n.normalizedMaskSha256!==mask.sha256||!n.normalizedSourceAssetId))return null;
  return {width:s.width!,height:s.height!,frames:s.frames!,reviewSourceId:n?.normalizedSourceAssetId??source.id};
}

/** Paused, frame-indexed review of the actual source and mask videos. No simulated tracking geometry. */
export function TrackedMaskReview({workspace,source,mask}:{workspace:string;source:Asset;mask:Asset}){
  const geometry=trackedReviewGeometry(source,mask),sourceVideo=useRef<HTMLVideoElement>(null),maskVideo=useRef<HTMLVideoElement>(null),canvas=useRef<HTMLCanvasElement>(null),scratch=useRef<HTMLCanvasElement|null>(null);
  const [frame,setFrame]=useState(0),[drawn,setDrawn]=useState<number|null>(null),[overlay,setOverlay]=useState(""),[bounds,setBounds]=useState<ReturnType<typeof maskFrameBounds>|null>(null),[error,setError]=useState("");
  const paint=useCallback(()=>{
    const sourceEl=sourceVideo.current,maskEl=maskVideo.current,out=canvas.current;if(!geometry||!sourceEl||!maskEl||!out||sourceEl.readyState<2||maskEl.readyState<2||Math.abs(sourceEl.currentTime-frame/16)>.002||Math.abs(maskEl.currentTime-frame/16)>.002)return;
    try{
      out.width=geometry.width;out.height=geometry.height;out.getContext("2d")!.drawImage(sourceEl,0,0,out.width,out.height);
      const m=scratch.current??document.createElement("canvas");scratch.current=m;m.width=out.width;m.height=out.height;
      const ctx=m.getContext("2d",{willReadFrequently:true})!;ctx.drawImage(maskEl,0,0,m.width,m.height);setBounds(maskFrameBounds(ctx.getImageData(0,0,m.width,m.height).data,m.width,m.height));setOverlay(m.toDataURL("image/png"));setDrawn(frame);setError("");
    }catch{setError("The source and mask frame could not be decoded together.");}
  },[frame,geometry?.width,geometry?.height,geometry?.frames]);
  const seek=useCallback(()=>{for(const video of [sourceVideo.current,maskVideo.current])if(video&&video.readyState>=1&&Math.abs(video.currentTime-frame/16)>.002)video.currentTime=frame/16;paint();},[frame,paint]);
  useEffect(()=>{setOverlay("");setBounds(null);seek();},[seek]);
  if(!geometry)return <Notice inline priority={40} title="This mask can't be reviewed here">The saved mask belongs to a different clip or its geometry is missing. Reject and adjust below creates an area for this clip.</Notice>;
  const coverage=validatedMaskCoverage(mask.metadata?.maskCoverage,geometry,mask.sha256);
  return <div className="cf-form">
    <video hidden muted playsInline preload="auto" ref={sourceVideo} src={assetUrl(workspace,geometry.reviewSourceId)} onLoadedMetadata={seek} onLoadedData={seek} onSeeked={paint} onError={()=>setError("The source video could not be decoded for review.")}/>
    <video hidden muted playsInline preload="auto" ref={maskVideo} src={assetUrl(workspace,mask.id)} onLoadedMetadata={seek} onLoadedData={seek} onSeeked={paint} onError={()=>setError("The mask video could not be decoded for review.")}/>
    <div className="cf-tracked-review__stage" data-frame={drawn??undefined}><canvas ref={canvas} role="img" aria-label={`Source review frame ${drawn??"loading"}`}/>{overlay&&<MaskOverlay src={overlay} label={`Tracked mask frame ${drawn}`} onError={()=>setError("The mask overlay could not be displayed.")}/>} {bounds?.box&&<TrackSticker {...bounds.box} label="Mask extent"/>}</div>
    <SliderField label="Review frame" value={frame} min={0} max={geometry.frames-1} step={1} onChange={setFrame}/>
    {coverage&&<MaskCoverageStrip report={coverage} value={frame} onChange={setFrame}/>}
    <Toolbar><Button variant="ghost" disabled={frame===0} onClick={()=>setFrame(f=>Math.max(0,f-1))}>Previous frame</Button><Meta>{drawn===frame?`Frame ${frame+1}/${geometry.frames} · ${((bounds?.coverage??0)*100).toFixed(1)}% selected`:`Reading frame ${frame+1}…`}</Meta><Button variant="ghost" disabled={frame===geometry.frames-1} onClick={()=>setFrame(f=>Math.min(geometry.frames-1,f+1))}>Next frame</Button></Toolbar>
    {!coverage&&<InfoButton title="Review tracked area">The tint and extent come from this decoded mask frame. Check occlusions and edges before approving; manual mask upload remains available for corrections. Older masks may not have a saved coverage scan.</InfoButton>}
    {drawn===frame&&bounds?.coverage===0&&<Notice inline priority={30} title="Mask has no selected pixels">Nothing is selected on this frame. Move to another frame, or reject and adjust below before using the mask.</Notice>}
    {drawn===frame&&bounds?.coverage===1&&<Notice inline priority={30} title={(mask.metadata?.sourceLinkedMask as {workflowId?:string}|undefined)?.workflowId==="sam31-video-background-mask"?"Subject is not protected":"Whole frame selected"}>Every pixel on this frame is selected. Reject and adjust below if that is not what you meant.</Notice>}
    {error&&<Notice inline priority={60} title="This frame could not be reviewed" details={error}>Nothing was approved. Another frame can be checked, or reject and adjust below.</Notice>}
  </div>;
}
