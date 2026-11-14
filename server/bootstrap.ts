import { z } from "zod";
import { loadConfig } from "./config";
import { database,migrate } from "./db";
import { bootstrap } from "./auth";

const config=loadConfig();
const input=z.object({email:z.email(),password:z.string().min(12),workspace:z.string().trim().min(1).max(120)}).parse({email:process.env.BOOTSTRAP_EMAIL,password:process.env.BOOTSTRAP_PASSWORD,workspace:process.env.BOOTSTRAP_WORKSPACE});
const pool=database(config.databaseUrl);
try { await migrate(pool); await bootstrap(pool,input.email,input.password,input.workspace); console.log("First workspace and administrator created. Sign in using the configured credentials."); }
finally { await pool.end(); }
