import {describe,expect,it,vi} from "vitest";
import path from "node:path";
// @ts-expect-error plain-JS launcher helper
import {createPersistentPostgres} from "../scripts/postgres-lifecycle.mjs";

function fixture(){
  const directory=path.resolve("public-fixtures", "database"),port=55434,forcedStop=vi.fn();
  const record=`1234\n${directory}\n1792600000\n${port}\n`;
  let current:string|null=null;
  class Base{constructor(_options:unknown){}async start(){}stop=forcedStop;}
  const readFile=vi.fn(async()=>{if(current===null)throw Object.assign(new Error("absent"),{code:"ENOENT"});return current;});
  const execute=vi.fn(async(_command:string,args:string[],_options?:unknown)=>{if(args.at(-1)==="stop")current=null;else if(args.at(-1)==="start")current=record;return {stdout:"ready",stderr:""};});
  return {directory,port,record,forcedStop,execute,setIdentity:(value:string|null)=>current=value,deps:{Base,readFile,realpath:async(p:string)=>path.resolve(p),execute,binaries:async()=>({pg_ctl:"fixture-pg-ctl"})}};
}
describe("persistent PostgreSQL launcher ownership",()=>{
  it("uses one graceful fast shutdown for concurrent/exit-hook calls",async()=>{
    const f=fixture(),pg=await createPersistentPostgres({databaseDir:f.directory,port:f.port,persistent:true},f.deps);await pg.start();await Promise.all([pg.stop(),pg.stop()]);await pg.stop();
    expect(f.execute).toHaveBeenCalledTimes(2);expect(f.execute.mock.calls[0][2]).toMatchObject({detached:true});expect(f.execute.mock.calls[1]).toMatchObject(["fixture-pg-ctl",["-D",f.directory,"-m","fast","-w","-t","30","stop"],{windowsHide:true,timeout:35000}]);expect(f.forcedStop).not.toHaveBeenCalled();
  });
  it("refuses a changed postmaster generation instead of stopping another process",async()=>{
    const f=fixture(),pg=await createPersistentPostgres({databaseDir:f.directory,port:f.port,persistent:true},f.deps);await pg.start();f.setIdentity(`9876\n${f.directory}\n1792600040\n${f.port}\n`);await expect(pg.stop()).rejects.toThrow(/ownership changed/);await expect(pg.stop()).rejects.toThrow();expect(f.execute).toHaveBeenCalledOnce();expect(f.forcedStop).not.toHaveBeenCalled();
  });
  it("reports a control-command failure without falling back to a force kill",async()=>{
    const f=fixture(),pg=await createPersistentPostgres({databaseDir:f.directory,port:f.port,persistent:true},f.deps);await pg.start();f.execute.mockImplementation(async()=>{throw new Error("control failed")});await expect(pg.stop()).rejects.toThrow("control failed");await expect(pg.stop()).rejects.toThrow("control failed");expect(f.execute).toHaveBeenCalledTimes(2);expect(f.forcedStop).not.toHaveBeenCalled();
  });
  it("accepts a concurrent console shutdown only after its identity file is gone",async()=>{
    const f=fixture(),pg=await createPersistentPostgres({databaseDir:f.directory,port:f.port,persistent:true},f.deps);await pg.start();f.execute.mockImplementation(async()=>{f.setIdentity(null);throw new Error("already stopped")});await expect(pg.stop()).resolves.toBeUndefined();expect(f.execute).toHaveBeenCalledTimes(2);expect(f.forcedStop).not.toHaveBeenCalled();
  });
  it("reuses a matching pre-existing cluster without taking shutdown ownership",async()=>{
    const f=fixture();f.setIdentity(f.record);const probe=vi.fn(async()=>({directory:f.directory,port:f.port}));const pg=await createPersistentPostgres({databaseDir:f.directory,port:f.port,persistent:true},{...f.deps,probe});await pg.start();await pg.stop();expect(probe).toHaveBeenCalledOnce();expect(f.execute).not.toHaveBeenCalled();expect(f.forcedStop).not.toHaveBeenCalled();
  });
  it("refuses a live cluster reporting a different directory",async()=>{
    const f=fixture();f.setIdentity(f.record);const pg=await createPersistentPostgres({databaseDir:f.directory,port:f.port,persistent:true},{...f.deps,probe:async()=>({directory:path.resolve("public-fixtures", "different-database"),port:f.port})});await expect(pg.start()).rejects.toThrow(/does not match/);await pg.stop();expect(f.execute).not.toHaveBeenCalled();expect(f.forcedStop).not.toHaveBeenCalled();
  });

});
