import {useEffect,useState} from "react";
import {Button,Dialog,EmptyState,LinkButton,Notice,ShimmerText,Thumb,ThumbGrid} from "../../ds";
import type {CapabilityManifestV2} from "../../capabilities/types";
import {assetUrl,type Call,type CharacterRecord} from "../../team/api";
import {characterPath} from "../../team/characters/state";
import {characterEditBindings} from "./character-references";

export function CharacterReferencePicker({open,onClose,onPick,workspaceId,projectId,manifest,call,authorized}:{open:boolean;onClose:()=>void;onPick:(record:CharacterRecord)=>void;workspaceId:string;projectId:string;manifest:CapabilityManifestV2;call:Call;authorized:boolean}){
  const [records,setRecords]=useState<CharacterRecord[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(""),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!open||!authorized)return;
    const abort=new AbortController();setRecords([]);setLoading(true);setError("");
    void call<CharacterRecord[]>(characterPath(workspaceId,projectId),"GET",undefined,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setRecords(value.filter(record=>record.projectId===projectId));}).catch(cause=>{if(!abort.signal.aborted)setError((cause as Error).message);}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[open,authorized,workspaceId,projectId,call,attempt]);
  return <Dialog open={open&&authorized} title="Choose a character" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
    {loading?<ShimmerText>Loading characters…</ShimmerText>:error?<Notice title="Characters unavailable" actions={<Button onClick={()=>setAttempt(value=>value+1)}>Retry</Button>}>{error}</Notice>:records.length?<ThumbGrid label="Saved characters">{records.map(record=>{
      let reason="";try{characterEditBindings(record,manifest,projectId);}catch(cause){reason=(cause as Error).message;}
      const portrait=[...record.referencePack.references].sort((a,b)=>a.ordinal-b.ordinal)[0];
      const thumb=<Thumb src={portrait?assetUrl(workspaceId,portrait.assetId):undefined} label={record.name} onSelect={reason?undefined:()=>{onPick(record);onClose();}} info={reason||record.name}/>;
      return <span key={record.id} title={reason||record.name}>{thumb}</span>;
    })}</ThumbGrid>:<EmptyState title="No saved characters" text="A character is a saved set of reference pictures. Creating one takes a name and at least one picture, and it then appears here." action={<LinkButton variant="secondary" href="#characters">Open Characters</LinkButton>}/>}
  </Dialog>;
}
