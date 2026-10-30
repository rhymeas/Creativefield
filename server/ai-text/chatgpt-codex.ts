import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {HttpError} from "../auth";
import type {AiTextImage,AiTextProvider,AiTextRequest,AiTextResult} from "../ai-text";

/** How the app introduces itself in the app-server handshake. Codex uses the name to attribute requests. */
const CLIENT_INFO={name:"comfyfield",title:"ComfyField",version:"0.1.0"};
const TIMEOUT_MS=180000;
const SIGN_IN="Sign in to ChatGPT with Codex first: run `codex login`.";
const NOT_INSTALLED="Codex is not installed. Install it with `npm install -g @openai/codex`, then run `codex login`.";

/** The stdio ends of `codex app-server`. Tests hand in their own pair instead of a real process. */
export type CodexChild={
  stdin:NodeJS.WritableStream;
  stdout:NodeJS.ReadableStream;
  on(event:string,listener:(value?:any)=>void):unknown;
  kill?():unknown;
};

export type CodexCommand={command:string;args:string[];shell:boolean};

/** Windows installs `codex` as a .cmd shim, which only a shell can start; elsewhere the binary starts directly. */
export function codexCommand(platform=process.platform,env:Record<string,string|undefined>=process.env):CodexCommand{
  const bin=env.COMFYFIELD_CODEX_BIN?.trim()||"codex";
  return platform==="win32"?{command:`"${bin}" app-server`,args:[],shell:true}:{command:bin,args:["app-server"],shell:false};
}

export type AiInputItem={type:"text";text:string}|{type:"image";url:string};

export function dataUrl(image:AiTextImage){
  return `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

/** This route rejects system-role items, so the instruction opens the single user turn instead. */
export function turnInput(request:AiTextRequest):AiInputItem[]{
  const text=request.system?`${request.system}\n\n${request.prompt}`:request.prompt;
  return [{type:"text",text},...(request.images??[]).map(image=>({type:"image" as const,url:dataUrl(image)}))];
}

/**
 * A text answer must not touch the user's files: read-only, never asks for approval, and the thread is
 * kept in memory so the user's own Codex history stays clean. The preview limits are app-server's job —
 * it sends `store: false` and `stream: true` itself, and no Responses field is ever set from here.
 */
export function threadParams(){
  return {ephemeral:true,cwd:tmpdir(),approvalPolicy:"never",sandbox:"readOnly"};
}

/** One plain sentence for the app's Notice. A refused request and a failed turn both land here. */
function failure(message:string){
  if(/login|log in|sign in|unauthor|not authenticated|401|403/i.test(message))return new HttpError(503,SIGN_IN);
  if(/usage limit|rate limit|quota|too many/i.test(message))return new HttpError(503,"The ChatGPT plan is at its limit. Try again later.");
  return new HttpError(502,`Codex app-server: ${message}`);
}

type RpcMessage={id?:number;method?:string;params?:any;result?:any;error?:{code?:number;message?:string}};

class RpcError extends Error{
  constructor(readonly code:number,message:string){super(message);}
}

/** Newline-delimited JSON-RPC over the child's stdio, plus the one turn this provider needs. */
export class CodexAppServer{
  private nextId=1;
  private readonly waiting=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  private readonly listeners=new Set<(message:RpcMessage)=>void>();
  private readonly aborters=new Set<(error:Error)=>void>();
  private buffer="";
  private started=false;
  private stopped:Error|undefined;

  constructor(private readonly child:CodexChild){
    child.stdout.on("data",(chunk:Buffer|string)=>this.read(chunk.toString()));
    // A child that never starts reports here; one that dies mid-answer reports on exit.
    child.on("error",()=>this.stop(new HttpError(503,NOT_INSTALLED)));
    child.on("exit",()=>this.stop(this.started?new HttpError(503,"Codex app-server stopped. Try again."):new HttpError(503,NOT_INSTALLED)));
    child.stdin.on("error",()=>{}); // A dead child refuses writes; the exit path above reports why.
  }

  /** One question, one answer, through the user's own Codex sign-in. Nothing is stored on this route. */
  async ask(request:AiTextRequest):Promise<AiTextResult>{
    const timeout=setTimeout(()=>this.stop(new HttpError(503,"ChatGPT took too long. Try again.")),TIMEOUT_MS);
    timeout.unref?.();
    try{
      await this.request("initialize",{clientInfo:CLIENT_INFO});
      this.started=true;
      this.notify("initialized",{});
      await this.requireAccount();
      const thread=(await this.request("thread/start",threadParams())).thread;
      const threadId=String(thread?.id??"");
      if(!threadId)throw new HttpError(502,"Codex did not open a conversation.");
      // Listen first: a short answer can finish before the turn/start response reaches us.
      const answered=this.answer(threadId);
      await this.request("turn/start",{threadId,input:turnInput(request)});
      const text=await answered;
      return {provider:"chatgpt",model:typeof thread?.model==="string"?thread.model:"ChatGPT plan",text};
    }catch(error){
      throw error instanceof RpcError?failure(error.message):error;
    }finally{
      clearTimeout(timeout);
    }
  }

  /** The sign-in stays in the user's Codex home; this only asks whether it is there. */
  private async requireAccount(){
    let found;
    try{found=await this.request("account/read",{});}
    catch(error){
      if(error instanceof RpcError&&error.code===-32601)return; // Older app-server: the turn reports its own sign-in error.
      throw error;
    }
    if(found?.account?.type!=="chatgpt")throw new HttpError(503,SIGN_IN);
  }

  /** Collects the agent message for this turn and settles when `turn/completed` names it. */
  private answer(threadId:string):Promise<string>{
    return new Promise((resolve,reject)=>{
      const deltas=new Map<string,string>();
      let complete="";
      const settle=(error?:Error,text?:string)=>{
        this.listeners.delete(onMessage);
        this.aborters.delete(abort);
        if(error)reject(error);
        else resolve(text??"");
      };
      const onMessage=(message:RpcMessage)=>{
        const params=message.params??{};
        if(params.threadId&&params.threadId!==threadId)return;
        if(message.method==="item/agentMessage/delta"&&typeof params.delta==="string"){
          const item=String(params.itemId??"");
          deltas.set(item,(deltas.get(item)??"")+params.delta);
          return;
        }
        if(message.method==="item/completed"&&params.item?.type==="agentMessage"&&typeof params.item.text==="string"){
          complete=params.item.text;
          return;
        }
        if(message.method!=="turn/completed")return;
        const turn=params.turn??{};
        if(turn.status!=="completed"){
          settle(turn.status==="interrupted"?new HttpError(503,"The ChatGPT turn was stopped. Try again."):failure(String(turn.error?.message??"The ChatGPT turn failed.")));
          return;
        }
        const text=(complete||[...deltas.values()].join("")).trim();
        if(text)settle(undefined,text);
        else settle(new HttpError(502,"ChatGPT returned no text."));
      };
      const abort=(error:Error)=>settle(error);
      this.listeners.add(onMessage);
      this.aborters.add(abort);
    });
  }

  private read(chunk:string){
    this.buffer+=chunk;
    for(let index=this.buffer.indexOf("\n");index>=0;index=this.buffer.indexOf("\n")){
      const line=this.buffer.slice(0,index).trim();
      this.buffer=this.buffer.slice(index+1);
      if(!line)continue;
      let message:RpcMessage;
      try{message=JSON.parse(line) as RpcMessage;}
      catch{continue;} // Anything that is not a message is noise, not an answer.
      const waiting=message.id===undefined?undefined:this.waiting.get(message.id);
      if(waiting&&message.id!==undefined){
        this.waiting.delete(message.id);
        if(message.error)waiting.reject(new RpcError(message.error.code??-32000,message.error.message??"Codex refused the request."));
        else waiting.resolve(message.result);
        continue;
      }
      for(const listener of [...this.listeners])listener(message);
    }
  }

  private send(message:RpcMessage){
    if(this.stopped)throw this.stopped;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method:string,params:unknown):Promise<any>{
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      this.waiting.set(id,{resolve,reject});
      try{this.send({method,id,params});}
      catch(error){this.waiting.delete(id);reject(error);}
    });
  }

  private notify(method:string,params:unknown){
    this.send({method,params});
  }

  private stop(error:Error){
    if(this.stopped)return;
    this.stopped=error;
    for(const {reject} of this.waiting.values())reject(error);
    this.waiting.clear();
    for(const abort of [...this.aborters])abort(error);
    this.listeners.clear();
  }

  /** End the child the way the protocol expects: close stdin, then make sure it is gone. */
  close(){
    try{this.child.stdin.end();}
    catch{/* already gone */}
    this.child.kill?.();
  }
}

/**
 * Text and images in, text out, billed to the user's ChatGPT plan through the Codex they already signed in.
 * Image generation is not supported on this route, so an image request is refused instead of faked.
 */
export const chatGptCodexProvider:AiTextProvider={
  id:"chatgpt",
  async generate(request):Promise<AiTextResult>{
    if(request.kind==="image")throw new HttpError(503,"The ChatGPT plan writes text only. It cannot make pictures.");
    const command=codexCommand();
    let child;
    try{
      child=spawn(command.command,command.args,{stdio:["pipe","pipe","ignore"],shell:command.shell,windowsHide:true});
    }catch{
      throw new HttpError(503,NOT_INSTALLED);
    }
    const server=new CodexAppServer(child as unknown as CodexChild);
    try{return await server.ask(request);}
    finally{server.close();}
  },
};
