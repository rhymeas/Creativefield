import {describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {AudioProcessingService} from "../server/audio-processing-execution";

describe("audio candidate cleanup safety",()=>{
  const op=()=>({workspace_id:randomUUID(),id:randomUUID(),output_asset_id:randomUUID()});

  it("retains bytes when publication state cannot be read",async()=>{
    const pool={query:vi.fn().mockRejectedValue(new Error("database unavailable"))};
    const store={remove:vi.fn()};
    const service=new AudioProcessingService(pool as never,store as never);
    await (service as any).cleanupCandidate(op(),`${randomUUID()}/${randomUUID()}`);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("retains committed bytes and removes only a proven unpublished candidate",async()=>{
    const key=`${randomUUID()}/${randomUUID()}`,store={remove:vi.fn().mockResolvedValue(undefined)};
    const succeededPool={query:vi.fn().mockResolvedValueOnce({rows:[{storage_key:key}]}).mockResolvedValueOnce({rows:[{state:"succeeded"}]})};
    await (new AudioProcessingService(succeededPool as never,store as never) as any).cleanupCandidate(op(),key);
    expect(store.remove).not.toHaveBeenCalled();

    const active=op(),activePool={query:vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{state:"processing"}]})};
    await (new AudioProcessingService(activePool as never,store as never) as any).cleanupCandidate(active,key);
    expect(store.remove).toHaveBeenCalledWith(active.workspace_id,key);
  });
});
