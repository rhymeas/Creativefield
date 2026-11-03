import {PassThrough} from "node:stream";
import type {Pool} from "pg";
import {describe,expect,it} from "vitest";
import type {AiTextRequest} from "../server/ai-text";
import {CodexAppServer,chatGptCodexProvider,codexCommand,turnInput,type CodexChild} from "../server/ai-text/chatgpt-codex";

type Message={id?:number;method?:string;params?:any;result?:any;error?:{code?:number;message?:string}};
type Turn={id:string;status:string;items:unknown[];error?:{message:string}|null};
type Send=(message:Message)=>void;

const request:AiTextRequest={workspaceId:"w1",system:"Rules.",prompt:"Premise: A fox runs.",maxTokens:900};
const pool={} as Pool;
const status=(error:unknown)=>(error as {statusCode?:number}).statusCode;

/** A fake `codex app-server`: reads newline-delimited JSON and answers through the given script. */
function fakeServer(script:(message:Message,send:Send)=>void){
  const toServer=new PassThrough(),fromServer=new PassThrough();
  const sent:Message[]=[];
  const send:Send=message=>fromServer.write(`${JSON.stringify(message)}\n`);
  let buffer="";
  toServer.on("data",(chunk:Buffer)=>{
    buffer+=chunk.toString();
    for(let index=buffer.indexOf("\n");index>=0;index=buffer.indexOf("\n")){
      const line=buffer.slice(0,index).trim();
      buffer=buffer.slice(index+1);
      if(!line)continue;
      const message=JSON.parse(line) as Message;
      sent.push(message);
      script(message,send);
    }
  });
  const child={stdin:toServer,stdout:fromServer,on:()=>undefined,kill:()=>true} as unknown as CodexChild;
  return {child,sent};
}

const sentMethod=(sent:Message[],method:string)=>sent.find(message=>message.method===method)!;

/** A signed-in app-server that answers with one agent message. */
function signedIn(answer:string,onTurn?:()=>Turn):(message:Message,send:Send)=>void{
  return (message,send)=>{
    if(message.method==="initialize")return send({id:message.id,result:{userAgent:"codex/0.0",codexHome:"/tmp/codex"}});
    if(message.method==="initialized")return;
    if(message.method==="account/read")return send({id:message.id,result:{account:{type:"chatgpt",email:"user@example.com",planType:"plus"},requiresOpenaiAuth:true}});
    if(message.method==="thread/start")return send({id:message.id,result:{thread:{id:"thr_1",model:"gpt-5.1-codex"}}});
    if(message.method!=="turn/start")return;
    send({id:message.id,result:{turn:{id:"turn_1",status:"inProgress",items:[],error:null}}});
    send({method:"item/agentMessage/delta",params:{threadId:"thr_1",itemId:"item_1",delta:"Three shots "}});
    send({method:"item/agentMessage/delta",params:{threadId:"thr_1",itemId:"item_1",delta:"ready."}});
    send({method:"item/completed",params:{threadId:"thr_1",item:{type:"agentMessage",id:"item_1",text:answer}}});
    send({method:"turn/completed",params:{threadId:"thr_1",turn:onTurn?.()??{id:"turn_1",status:"completed",items:[],error:null}}});
  };
}

/** A child that never answers, so a test can report how it stopped. */
function silentChild(){
  const handlers=new Map<string,Array<(value?:any)=>void>>();
  const child={
    stdin:new PassThrough(),
    stdout:new PassThrough(),
    on(event:string,listener:(value?:any)=>void){
      handlers.set(event,[...(handlers.get(event)??[]),listener]);
      return child;
    },
    kill:()=>true,
  };
  const emit=(event:string)=>handlers.get(event)?.forEach(listener=>listener());
  return {child:child as unknown as CodexChild,emit};
}

describe("AI text through the user's ChatGPT plan",()=>{
  it("answers through the Codex sign-in and names the model it used",async()=>{
    const fake=fakeServer(signedIn("Three shots ready."));
    const server=new CodexAppServer(fake.child);
    const answer=await server.ask(request);
    server.close();
    expect(answer).toEqual({provider:"chatgpt",model:"gpt-5.1-codex",text:"Three shots ready."});
    expect(fake.sent.map(message=>message.method)).toEqual(["initialize","initialized","account/read","thread/start","turn/start"]);
    expect(sentMethod(fake.sent,"initialize").params.clientInfo.name).toBe("comfyfield");
  });

  it("opens the turn with the system instruction and sends no system-role item",async()=>{
    const fake=fakeServer(signedIn("Three shots ready."));
    await new CodexAppServer(fake.child).ask(request);
    expect(sentMethod(fake.sent,"turn/start").params.input).toEqual([{type:"text",text:"Rules.\n\nPremise: A fox runs."}]);
    const wire=JSON.stringify(fake.sent);
    for(const field of ["\"role\":\"system\"","store","temperature","max_output_tokens","previous_response_id","image_generation"]){
      expect(wire).not.toContain(field);
    }
  });

  it("keeps the thread in memory and away from the user's files",async()=>{
    const fake=fakeServer(signedIn("Three shots ready."));
    await new CodexAppServer(fake.child).ask(request);
    expect(sentMethod(fake.sent,"thread/start").params).toMatchObject({ephemeral:true,approvalPolicy:"never",sandbox:"readOnly"});
    expect(sentMethod(fake.sent,"thread/start").params.permissions).toBeUndefined();
  });

  it("sends an image as a data URL beside the prompt",()=>{
    const input=turnInput({...request,images:[{mediaType:"image/png",bytes:new Uint8Array([1,2,3])}]});
    expect(input[0]).toEqual({type:"text",text:"Rules.\n\nPremise: A fox runs."});
    expect(input[1]).toEqual({type:"image",url:`data:image/png;base64,${Buffer.from([1,2,3]).toString("base64")}`});
    expect(turnInput(request)).toHaveLength(1);
  });

  it("says to sign in when Codex has no ChatGPT account",async()=>{
    const fake=fakeServer((message,send)=>{
      if(message.method==="initialize")return send({id:message.id,result:{}});
      if(message.method==="account/read")return send({id:message.id,result:{account:null,requiresOpenaiAuth:true}});
    });
    const error=await new CodexAppServer(fake.child).ask(request).catch(found=>found);
    expect((error as Error).message).toBe("Sign in to ChatGPT with Codex first: run `codex login`.");
    expect(status(error)).toBe(503);
  });

  it("still answers on an app-server that has no account/read",async()=>{
    const base=signedIn("Three shots ready.");
    const fake=fakeServer((message,send)=>{
      if(message.method==="account/read")return send({id:message.id,error:{code:-32601,message:"Method not found"}});
      base(message,send);
    });
    const answer=await new CodexAppServer(fake.child).ask(request);
    expect(answer.text).toBe("Three shots ready.");
  });

  it("says plainly when the plan is at its limit",async()=>{
    const fake=fakeServer(signedIn("",()=>({id:"turn_1",status:"failed",items:[],error:{message:"You have hit your usage limit."}})));
    const error=await new CodexAppServer(fake.child).ask(request).catch(found=>found);
    expect((error as Error).message).toBe("The ChatGPT plan is at its limit. Try again later.");
    expect(status(error)).toBe(503);
  });

  it("asks for an install when the codex command is missing",async()=>{
    const {child,emit}=silentChild();
    const ask=new CodexAppServer(child).ask(request).catch(found=>found);
    emit("exit");
    const error=await ask;
    expect((error as Error).message).toContain("npm install -g @openai/codex");
    expect(status(error)).toBe(503);
  });

  it("refuses image generation with a plain sentence",async()=>{
    const error=await chatGptCodexProvider.generate({...request,kind:"image"}, {pool}).catch(found=>found);
    expect((error as Error).message).toBe("The ChatGPT plan writes text only. It cannot make pictures.");
    expect(status(error)).toBe(503);
  });
});

describe("starting the Codex app-server",()=>{
  it("starts codex directly, and through a shell on Windows where npm installs a .cmd shim",()=>{
    expect(codexCommand("linux",{})).toEqual({command:"codex",args:["app-server"],shell:false});
    expect(codexCommand("win32",{})).toEqual({command:"\"codex\" app-server",args:[],shell:true});
    expect(codexCommand("linux",{COMFYFIELD_CODEX_BIN:"/opt/codex"})).toEqual({command:"/opt/codex",args:["app-server"],shell:false});
  });
});
