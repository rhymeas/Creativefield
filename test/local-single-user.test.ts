import {describe,expect,it} from "vitest";
import {loadConfig} from "../server/config";

const base={
  DATABASE_URL:"postgresql://comfyfield:secret@127.0.0.1:5432/comfyfield",
  STORAGE_ROOT:(process.cwd() + "/public-fixtures/4536acb6"),
  MASTER_KEY:Buffer.alloc(32,7).toString("base64"),
  PUBLIC_ORIGIN:"http://127.0.0.1:8787",
};

describe("local single-user mode",()=>{
  it("is off unless LOCAL_SINGLE_USER=1",()=>{
    expect(loadConfig({...base}).localSingleUser).toBe(false);
    expect(loadConfig({...base,LOCAL_SINGLE_USER:"1"}).localSingleUser).toBe(true);
    expect(loadConfig({...base,LOCAL_SINGLE_USER:"true"}).localSingleUser).toBe(false);
  });
});
