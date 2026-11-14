/** The recovery node's output describes gaps in the original tracker, even if
 * a fallback mask was synthesized. A recovered frame is not proof of identity. */
export type OpenJutsuTracking = {state:"continuous"|"lost"|"unknown"; lostFrames:number[]; recoveredFrames:number[]};

export function readOpenJutsuTracking(graph:Record<string,{class_type:string}>,outputs:Record<string,Record<string,unknown>>):OpenJutsuTracking {
  const nodes=Object.entries(graph).filter(([,node])=>node.class_type==="H3CharacterSwapRecoverMasks");
  const unknown:OpenJutsuTracking={state:"unknown",lostFrames:[],recoveredFrames:[]};
  if(nodes.length!==1)return unknown;
  const text=outputs[nodes[0][0]]?.text;
  if(!Array.isArray(text)||text.length!==1||typeof text[0]!=="string"||text[0].length>200000)return unknown;
  try {
    const report=JSON.parse(text[0]);
    const valid=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=100000&&v.every(n=>Number.isSafeInteger(n)&&n>=0);
    if(!valid(report.empty_tracking_frames)||!valid(report.recovered_frames))return unknown;
    const lostFrames=[...new Set(report.empty_tracking_frames as number[])].sort((a,b)=>a-b);
    const recoveredFrames=[...new Set(report.recovered_frames as number[])].sort((a,b)=>a-b);
    if(recoveredFrames.some(frame=>!lostFrames.includes(frame)))return unknown;
    return {state:lostFrames.length?"lost":"continuous",lostFrames,recoveredFrames};
  } catch{return unknown;}
}
