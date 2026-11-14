import {workspacePath,type Call} from '../api';
import {saveOutcome,type Board,type SaveIntent} from '../storyboard-state';

export type PersonaPending={kind:'creating'}|{kind:'saving';board:Board;intent:SaveIntent};

/** A saved marker is kept until its board can be reconciled or the user explicitly clears it. */
export function readPersonaPending(storage:Storage,key:string):PersonaPending|null{
  const raw=storage.getItem(key);if(raw===null)return null;
  try{
    const value=JSON.parse(raw);
    if(value?.kind==='creating')return {kind:'creating'};
    if(value?.kind==='saving'&&typeof value.board?.id==='string'&&typeof value.board?.project_id==='string'&&Number.isInteger(value.intent?.revision)&&Array.isArray(value.intent?.shots))return value;
  }catch{/* An unreadable marker must not permit a duplicate creation. */}
  return {kind:'creating'};
}

/** Inspect the authoritative board before writing; a changed revision is never overwritten. */
export async function savePersonaShots(call:Call,workspace:string,project:string,pending:Extract<PersonaPending,{kind:'saving'}>):Promise<Board>{
  const path=workspacePath(workspace,`storyboards/${encodeURIComponent(pending.board.id)}`);
  async function read(){const board=await call<Board>(path);if(board.project_id!==project)throw new Error('Storyboard is not in this project.');return board;}
  const current=await read(),outcome=saveOutcome(pending.intent,current);
  if(outcome==='saved')return current;
  if(outcome==='conflict')throw new Error('The storyboard changed. Open it before making further changes.');
  try{const result=await call<{revision:number}>(`${path}/shots`,'PUT',pending.intent);return {...pending.board,revision:result.revision};}
  catch(error){
    const latest=await read().catch(()=>null);
    if(latest&&saveOutcome(pending.intent,latest)==='saved')return latest;
    throw error;
  }
}
