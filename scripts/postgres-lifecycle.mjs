import {spawn} from "node:child_process";
import {readFile,realpath} from "node:fs/promises";
import path from "node:path";

function control(file,args,options){
  return new Promise((resolve,reject)=>{
    // A separate process group keeps console Ctrl+C away from the postmaster.
    const child=spawn(file,args,{windowsHide:true,detached:true,stdio:"ignore"});
    let settled=false;
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>{child.kill();finish(new Error("PostgreSQL control command timed out; inspect this cluster before continuing."));},options.timeout);
    child.on("error",finish);child.on("exit",code=>finish(code===0?null:new Error(`PostgreSQL control exited ${code}; inspect ${path.join(args[1],"launcher.log")}.`)));
  });
}

/** Persistent launcher clusters use pg_ctl, not the library's Windows force-kill. */
export async function createPersistentPostgres(options,dependencies={}){
  if(options.persistent===false)throw new Error("This launcher preserves persistent database files.");
  const Base=dependencies.Base??(await import("embedded-postgres")).default;
  const read=dependencies.readFile??readFile,canonical=dependencies.realpath??realpath,execute=dependencies.execute??control;
  const binaries=dependencies.binaries??(()=>import(`@embedded-postgres/${process.platform==="win32"?"windows":process.platform}-${process.arch}`));
  const probe=dependencies.probe??(async()=>{
    const {Client}=await import("pg"),client=new Client({host:"127.0.0.1",port:options.port,user:options.user,password:options.password,database:"postgres",connectionTimeoutMillis:5000});
    try{await client.connect();return (await client.query("SELECT current_setting('data_directory') AS directory,current_setting('port') AS port")).rows[0];}finally{await client.end();}
  });
  let directory=path.resolve(options.databaseDir);
  const key=p=>process.platform==="win32"?p.toLowerCase():p;
  const identity=async()=>{
    const lines=(await read(path.join(directory,"postmaster.pid"),"utf8")).trim().split(/\r?\n/);
    const record={pid:Number(lines[0]),directory:await canonical(lines[1]),startedAt:lines[2],port:Number(lines[3])};
    if(!Number.isInteger(record.pid)||record.pid<=0||!/^\d+$/.test(record.startedAt)||record.port!==options.port||key(record.directory)!==key(directory))throw new Error("PostgreSQL cluster ownership does not match this launcher.");
    return record;
  };
  const instance=new Base({...options,persistent:true});
  let owned=null,borrowed=null,starting=false,stopping=null;
  instance.start=async()=>{
    if(owned||borrowed||starting||stopping)throw new Error("This PostgreSQL launcher already has an active lifecycle.");
    if(options.postgresFlags?.length)throw new Error("Custom PostgreSQL launch flags are not supported by this persistent launcher.");
    starting=true;
    try{
      directory=await canonical(directory);
      let existing;
      try{existing=await identity();}catch(error){if(error.code!=="ENOENT")throw error;}
      if(existing){
        const facts=await probe(),after=await identity();
        if(key(await canonical(facts.directory))!==key(directory)||Number(facts.port)!==options.port||after.pid!==existing.pid||after.startedAt!==existing.startedAt)throw new Error("Existing PostgreSQL does not match this data directory and port.");
        borrowed=after;return;
      }
      const {pg_ctl}=await binaries();
      await execute(pg_ctl,["-D",directory,"-l",path.join(directory,"launcher.log"),"-o",`-p ${options.port}`,"-w","-t","30","start"],{windowsHide:true,detached:true,timeout:35000,maxBuffer:262144});
      owned=await identity();
    }finally{starting=false;}
  };
  instance.createDatabase=async name=>{
    if(!owned&&!borrowed)throw new Error("Start this launcher's PostgreSQL cluster first.");
    const {Client}=await import("pg"),client=new Client({host:"127.0.0.1",port:options.port,user:options.user,password:options.password,database:"postgres"});
    try{await client.connect();await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);}finally{await client.end();}
  };
  instance.stop=()=>{
    if(stopping)return stopping;
    if(borrowed){borrowed=null;return Promise.resolve();}
    if(!owned)return Promise.resolve();
    // Retain a failed attempt; exit hooks must not silently retry or force-kill.
    stopping=(async()=>{
      let current;
      try{current=await identity();}catch(error){if(error.code==="ENOENT"){owned=null;return;}throw error;}
      if(current.pid!==owned.pid||current.startedAt!==owned.startedAt)throw new Error("PostgreSQL ownership changed; refusing to stop a different process.");
      const {pg_ctl}=await binaries();
      try{
        await execute(pg_ctl,["-D",directory,"-m","fast","-w","-t","30","stop"],{windowsHide:true,detached:true,timeout:35000,maxBuffer:262144});
      }catch(error){
        // Console Ctrl+C can also reach PostgreSQL directly before pg_ctl does.
        try{await read(path.join(directory,"postmaster.pid"),"utf8");}catch(lookup){if(lookup.code==="ENOENT"){owned=null;return;}throw lookup;}
        throw error;
      }
      try{await read(path.join(directory,"postmaster.pid"),"utf8");throw new Error("PostgreSQL stop returned but its identity file remains.");}catch(error){if(error.code!=="ENOENT")throw error;}
      owned=null;
    })();
    const attempt=stopping;
    void attempt.then(()=>{stopping=null;},()=>{});
    return attempt;
  };
  return instance;
}
