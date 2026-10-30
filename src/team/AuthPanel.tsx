import {useRef,useState} from "react";
import {Button,Meta,Notice,Panel,SectionHeader,TextField} from "../ds";
import {request} from "./api";
import logo from "../assets/creativefield-logo-trim.png";
export function AuthPanel({onSignedIn,embedded=false}:{onSignedIn:()=>Promise<void>;embedded?:boolean}){
  const [invite,setInvite]=useState(false),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[token,setToken]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const first=useRef<HTMLInputElement>(null);
  async function submit(e:React.FormEvent){
    e.preventDefault();setBusy(true);setError("");
    try {
      if(invite){await request("/invitations/accept","POST",{token,password});setInvite(false);setToken("");setPassword("");setError("Invitation accepted. Sign in with the email your administrator invited.");}
      else {await request("/auth/login","POST",{email,password});setPassword("");await onSignedIn();}
    }catch(e){setError((e as Error).message);first.current?.focus();}finally{setBusy(false);}
  }
  return <div className={embedded?"cf-auth cf-auth--embedded":"cf-auth"}>
    {!embedded&&<span className="ds-topbar__brand"><img className="ds-topbar__brand-image" src={logo} alt="CreativeField"/></span>}
    <Panel><form onSubmit={submit} className="cf-form">
      <SectionHeader title={invite?"Join your workspace":"Sign in to CreativeField"}/><Meta>Accounts are created by a workspace admin.</Meta>
      {invite?<TextField label="Invitation code" inputRef={first} required value={token} onChange={setToken} autoComplete="off"/>:<TextField label="Email" inputRef={first} required type="email" value={email} onChange={setEmail} autoComplete="username"/>}
      <TextField label="Password" required type="password" minLength={invite?12:undefined} hint={invite?"At least 12 characters":undefined} value={password} onChange={setPassword} autoComplete={invite?"new-password":"current-password"}/>
      {/* Accepting an invitation succeeds into the same state, so that message is a hint, not a failure. */}
      {error&&(/^Invitation accepted/.test(error)
        ?<Notice tone="info" title="Invitation accepted">{error.replace(/^Invitation accepted\.\s*/,"")}</Notice>
        :<Notice inline priority={60} title="Sign-in failed">{error}</Notice>)}
      <Button variant="primary" disabled={busy} type="submit">{busy?"Please wait…":invite?"Accept invitation":"Sign in"}</Button>
      <Button variant="ghost" type="button" disabled={busy} onClick={()=>{setInvite(!invite);setError("");setPassword("");}}>{invite?"Back to sign in":"Have an invitation?"}</Button>
    </form></Panel>
  </div>;
}
