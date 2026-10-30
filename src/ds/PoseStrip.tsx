import {useRef} from "react";
import type {PosePreviewFrame} from "../capabilities/pose-preview";
import "./pose-strip.css";
const BODY=[[1,2],[2,3],[3,4],[1,5],[5,6],[6,7],[1,8],[8,9],[9,10],[1,11],[11,12],[12,13],[1,0],[0,14],[14,16],[0,15],[15,17]];
const HAND=Array.from({length:5},(_,finger)=>{const base=finger*4+1;return [[0,base],[base,base+1],[base+1,base+2],[base+2,base+3]];}).flat();
function Bones({points,edges}:{points:number[]|undefined;edges:number[][]}){if(!points)return null;return <>{edges.map(([a,b])=>points[a*3+2]>=.3&&points[b*3+2]>=.3?<line key={`${a}:${b}`} x1={points[a*3]} y1={points[a*3+1]} x2={points[b*3]} y2={points[b*3+1]}/>:null)}</>;}
function Skeleton({frame}:{frame:PosePreviewFrame}){return <>{frame.pose.people.map((person,i)=><g key={i}><Bones points={person.pose_keypoints_2d} edges={BODY}/><Bones points={person.hand_left_keypoints_2d} edges={HAND}/><Bones points={person.hand_right_keypoints_2d} edges={HAND}/></g>)}</>;}
/** Detected joints drawn over the driving clip, aligned by the pose canvas. */
export function PoseOverlay({frame}:{frame:PosePreviewFrame}){return <svg className="ds-pose-overlay" viewBox={`0 0 ${frame.pose.canvas_width} ${frame.pose.canvas_height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true"><Skeleton frame={frame}/></svg>;}
/** Actual detected joints only. The caller owns source-video seeking and selection. */
export function PoseStrip({frames,selected,onSelect}:{frames:PosePreviewFrame[];selected:number;onSelect:(frame:PosePreviewFrame)=>void}){
  const buttons=useRef<(HTMLButtonElement|null)[]>([]);if(!frames.length)return null;
  const active=frames.findIndex(frame=>frame.frameIndex===selected),select=(index:number)=>{onSelect(frames[index]);};
  return <div className="ds-posestrip" role="group" aria-label="Detected pose samples">{frames.map((frame,index)=><button type="button" key={frame.frameIndex} ref={node=>{buttons.current[index]=node;}} className="ds-posestrip__item" tabIndex={index===(active>=0?active:0)?0:-1} aria-current={index===active?"true":undefined} aria-label={`Pose at ${frame.seconds.toFixed(2)} seconds${frame.pose.people.length?"":" · No detected person"}`} title={`Frame ${frame.frameIndex} · ${frame.seconds.toFixed(2)} s${frame.pose.people.length?"":" · No detected person"}`} onClick={()=>select(index)} onKeyDown={e=>{let next:number|undefined;if(e.key==="ArrowRight")next=Math.min(frames.length-1,index+1);if(e.key==="ArrowLeft")next=Math.max(0,index-1);if(e.key==="Home")next=0;if(e.key==="End")next=frames.length-1;if(next!==undefined){e.preventDefault();select(next);buttons.current[next]?.focus();}}}><svg viewBox={`0 0 ${frame.pose.canvas_width} ${frame.pose.canvas_height}`} aria-hidden="true"><Skeleton frame={frame}/></svg></button>)}</div>;
}
