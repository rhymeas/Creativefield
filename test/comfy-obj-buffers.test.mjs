import {describe,it,expect} from "vitest";
import {isolateObjBuffers} from "../server/comfy-3d.mjs";

function fixture(){
  class OBJLoader2Parallel {
    initWorkerParse(){}
    parse(data){return structuredClone(data,{transfer:[data]});}
  }
  class Adapter {objLoader=new OBJLoader2Parallel();}
  return {Adapter,OBJLoader2Parallel};
}
describe("isolated native OBJ worker input ownership",()=>{
  it("reproduces cached-buffer detachment and lets independent viewers transfer their own copies",()=>{
    const plain=fixture(),buffer=new Uint8Array([1,2,3,4]).buffer;
    new plain.Adapter().objLoader.parse(buffer);
    expect(buffer.byteLength).toBe(0);
    expect(()=>new plain.Adapter().objLoader.parse(buffer)).toThrow();
    const {Adapter}=fixture(),shared=new Uint8Array([5,6,7,8]).buffer;
    expect(isolateObjBuffers(Adapter)).toBe(true);
    const inline=new Adapter(),modal=new Adapter();
    expect(Array.from(new Uint8Array(inline.objLoader.parse(shared)))).toEqual([5,6,7,8]);
    expect(Array.from(new Uint8Array(modal.objLoader.parse(shared)))).toEqual([5,6,7,8]);
    expect(shared.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(shared))).toEqual([5,6,7,8]);
  });
  it("copies only a typed view's range and installs once without touching other loaders",()=>{
    const {Adapter,OBJLoader2Parallel}=fixture(),original=OBJLoader2Parallel.prototype.parse;
    isolateObjBuffers(Adapter);const wrapped=OBJLoader2Parallel.prototype.parse;
    expect(wrapped).not.toBe(original);isolateObjBuffers(Adapter);
    expect(OBJLoader2Parallel.prototype.parse).toBe(wrapped);
    const input=new Uint8Array([10,20,30,40]),result=new Adapter().objLoader.parse(input.subarray(1,3));
    expect(Array.from(new Uint8Array(result))).toEqual([20,30]);expect(input.byteLength).toBe(4);
    class Other {parse(){return "original";}}
    class OtherAdapter {objLoader=new Other();}
    const other=Other.prototype.parse;expect(isolateObjBuffers(OtherAdapter)).toBe(false);
    expect(Other.prototype.parse).toBe(other);expect(isolateObjBuffers(undefined)).toBe(false);
  });
  it("isolates parser state across repeated and overlapping model loads",async()=>{
    class OBJLoader2Parallel {
      meshes=[];terminated=false;
      initWorkerParse(){}
      setTerminateWorkerOnLoad(value){this.terminated=value;}
      parse(data){this.meshes.push(data);return this.meshes;}
    }
    class Adapter {
      objLoader=new OBJLoader2Parallel();
      async loadOBJ(context,filename){await Promise.resolve();const meshes=this.objLoader.parse(filename);return {context,meshes:[...meshes],terminated:this.objLoader.terminated};}
    }
    isolateObjBuffers(Adapter);const adapter=new Adapter(),context={materialMode:"original"};
    const first=await adapter.loadOBJ(context,"first.obj");
    const [second,third]=await Promise.all([adapter.loadOBJ(context,"second.obj"),adapter.loadOBJ(context,"third.obj")]);
    expect([first.meshes,second.meshes,third.meshes]).toEqual([["first.obj"],["second.obj"],["third.obj"]]);
    for(const result of [first,second,third]){expect(result.context).toBe(context);expect(result.terminated).toBe(true);}
    expect(adapter.objLoader.meshes).toHaveLength(0);
  });
});
