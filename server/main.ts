import { loadConfig } from "./config";
import { database, migrate } from "./db";
import { buildServer } from "./app";
import {buildNodeEditorServer} from "./node-editor-server";

const config = loadConfig();
const pool = database(config.databaseUrl);
await migrate(pool);
const { app,execution,directExecution,storyboards,videoExtensions,posePreviews,audioProcessing,marketing,workerMonitor } = await buildServer(config,pool);
const nodeEditor=await buildNodeEditorServer(config,pool);
try{await nodeEditor.listen({host:config.host,port:config.nodeEditorPort!});}
catch(error){await app.close();await nodeEditor.close();await pool.end();throw error;}
try{await app.listen({host:config.host,port:config.port});}
catch(error){await Promise.all([app.close(),nodeEditor.close()]);await pool.end();throw error;}
console.log(`ComfyField team API listening on ${config.host}:${config.port}`);
console.log(`ComfyUI editor isolated at ${config.nodeEditorOrigin}`);
void marketing.recover().catch(()=>{});
const tickMs=Math.max(100,Number(process.env.COMFYFIELD_EXECUTION_TICK_MS??2000)||2000);
const timer=setInterval(()=>void execution.tick().catch(()=>{}),tickMs);
const providerTimer=setInterval(()=>void directExecution.tick().catch(()=>{}),2000);
const storyboardTimer=setInterval(()=>void storyboards.tick().catch(()=>{}),2000);
const videoExtensionTimer=setInterval(()=>void videoExtensions.tick().catch(()=>{}),2000);
const posePreviewTimer=setInterval(()=>void posePreviews.tick().catch(()=>{}),2000);
const audioTimer=setInterval(()=>void audioProcessing.tick().catch(()=>{}),2000);
const healthTimer=setInterval(()=>void workerMonitor.tick().catch(()=>{}),30000);
void workerMonitor.tick().catch(()=>{});
let stopping=false;
async function stop() { if(stopping)return;stopping=true;clearInterval(timer);clearInterval(providerTimer);clearInterval(healthTimer);clearInterval(storyboardTimer);clearInterval(videoExtensionTimer);clearInterval(posePreviewTimer);clearInterval(audioTimer); await Promise.all([app.close(),nodeEditor.close()]); await Promise.all([execution.close(),directExecution.close(),storyboards.close(),videoExtensions.close(),posePreviews.close(),audioProcessing.close(),workerMonitor.close()]); await pool.end(); }
process.on("SIGINT",()=>void stop()); process.on("SIGTERM",()=>void stop());
