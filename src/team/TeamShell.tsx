import {useCallback,useEffect,useRef,useState} from "react";
import {Button,Dialog,EmptyState,Notice,ProblemHost,ShimmerText,ToastHost} from "../ds";
import {ApiError,request,type Call,type RequestOptions,type User,type Workspace} from "./api";
import {AuthPanel} from "./AuthPanel";
import {finishAccountRedirect} from "./AccountDialog";
import {enableBrowserLibrary} from "./browser-library";
import {TeamWorkspace} from "./TeamApp";
import {audienceOf,noWorkspaceText} from "./audience";

/* The signed-in shell: who is signed in, their workspaces, and the session-expired dialog around TeamWorkspace. */
export default function TeamApp(){
  const [user,setUser]=useState<User|null>(null),[workspaces,setWorkspaces]=useState<Workspace[]>([]),[workspaceId,setWorkspaceId]=useState("");
  const [authRequired,setAuthRequired]=useState(false),[offline,setOffline]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState("");
  /* A hosted guest whose session changed under this tab (another tab, or the old shared demo) is resynced, never asked for a password. */
  const guestTab=useRef(false),resync=useRef<()=>Promise<void>>(async()=>{});
  const call:Call=useCallback(async<T,>(path:string,method?:string,body?:unknown,options?:RequestOptions)=>{
    try {const value=await request<T>(path,method,body,options);setOffline(false);return value;}
    catch(e){if(e instanceof ApiError){if(guestTab.current&&(e.status===401||e.status===403))void resync.current().catch(()=>undefined);else if(e.status===401)setAuthRequired(true);if(e.status===0)setOffline(true);}throw e;}
  },[]);
  const signIn=useCallback(async()=>{
    await finishAccountRedirect().catch(e=>setError((e as Error).message));
    const account=await request<User>("/auth/me"),memberships=await request<Workspace[]>("/workspaces");
    if(account.guest)await enableBrowserLibrary();
    guestTab.current=!!account.guest;setUser(account);setWorkspaces(memberships);setWorkspaceId(id=>memberships.some(w=>w.id===id)?id:memberships[0]?.id??"");setAuthRequired(false);setOffline(false);setError("");setLoading(false);
  },[]);
  resync.current=signIn;
  useEffect(()=>{let active=true;void signIn().catch(e=>{if(active){if(!(e instanceof ApiError)||e.status!==401)setError((e as Error).message);setLoading(false);}});return()=>{active=false;};},[signIn]);
  const signOut=useCallback(async()=>{await call("/auth/logout","POST");/* A hosted account signs out to a fresh guest. */if(guestTab.current){await signIn();return;}setUser(null);setWorkspaces([]);setWorkspaceId("");setAuthRequired(false);},[call,signIn]);
  const closeReauth=useCallback(()=>{},[]);
  const workspace=workspaces.find(w=>w.id===workspaceId);
  if(loading)return <div className="cf-auth"><ShimmerText>CreativeField</ShimmerText></div>;
  if(!user)return <AuthPanel onSignedIn={signIn} serverError={error||undefined} onRetry={()=>void signIn().catch(e=>setError((e as Error).message))}/>;
  return <ToastHost><ProblemHost>
    {workspace?<TeamWorkspace key={`${user.id}:${workspace.id}`} user={user} workspace={workspace} workspaces={workspaces} onWorkspace={setWorkspaceId} call={call} authorized={!authRequired} offline={offline} onSignOut={signOut} onAccount={signIn} onReconnect={()=>void signIn().catch(e=>setError((e as Error).message))}/>:<div className="cf-auth"><EmptyState title="No workspace access" text={noWorkspaceText(audienceOf(user))} action={<Button variant="secondary" onClick={()=>void signOut()}>Sign out</Button>}/></div>}
    <Dialog open={authRequired&&!user.localSingleUser} title="Sign in to continue" onClose={closeReauth}><Notice inline title="Your session has expired">Your draft is preserved. Signing in below keeps it, and you queue explicitly when ready.</Notice><AuthPanel embedded onSignedIn={signIn}/></Dialog>
  </ProblemHost></ToastHost>;
}
