import {describe,expect,it} from "vitest";
import {loadConfig} from "../server/config";

const env={DATABASE_URL:"postgres://fixture",STORAGE_ROOT:(process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/fixture",MASTER_KEY:Buffer.alloc(32).toString("base64"),PUBLIC_ORIGIN:"http://127.0.0.1:8787"};
describe("isolated node editor configuration",()=>{
  it("uses a separate port while retaining host-only session cookie routing",()=>{
    expect(loadConfig(env)).toMatchObject({nodeEditorPort:8788,nodeEditorOrigin:"http://127.0.0.1:8788"});
    expect(loadConfig({...env,PORT:"8800"})).toMatchObject({nodeEditorPort:8801,nodeEditorOrigin:"http://127.0.0.1:8801"});
  });
  it.each(["http://127.0.0.1:8787","http://foreign.example:8788","https://127.0.0.1:8788"])("rejects unsafe or incompatible editor origin %s",origin=>{
    expect(()=>loadConfig({...env,NODE_EDITOR_ORIGIN:origin})).toThrow("separate port");
  });
  it("rejects binding the same listening port and allows explicit port mapping",()=>{
    expect(()=>loadConfig({...env,NODE_EDITOR_PORT:"8787"})).toThrow("must differ");
    expect(loadConfig({...env,NODE_EDITOR_PORT:"8799",NODE_EDITOR_ORIGIN:"http://127.0.0.1:9899"})).toMatchObject({nodeEditorPort:8799,nodeEditorOrigin:"http://127.0.0.1:9899"});
  });
});
