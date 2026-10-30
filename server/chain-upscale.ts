import type {CapabilityBundle} from "../src/capabilities/types";

/** The last step of a video result: one upscale pass on the pack the workspace already has, chained
 *  into the same request. The run's final output becomes the upscaled file and the file the tool
 *  made is kept as an extra output. `test/chain-upscale.test.ts` pins the numbers below. */

/** The pack this chain prefers, and the mode it runs in: super resolution, not denoise. */
export const UPSCALE_PACK="nvidia-vfx-upscale";
export const UPSCALE_MODE="ULTRA";
/** The size a result must reach, in pixels of height. */
export const UPSCALE_FLOOR=720,UPSCALE_PREFERRED=1080;
/** A result this tall already is what the chain is for. */
const UPSCALE_SKIP=1080;
/** The height a result has to reach before the bigger size is worth asking for. */
const PREFERRED_SINCE=480;
/** A pass may add about a third of the run's own time, no more. */
export const UPSCALE_EXTRA_SHARE_LIMIT=0.3;
/** What each of the pack's two scales is expected to add, as a share of the run's own time.
 *  These are estimates from the pass's own work (a 2x pass decodes and encodes twice the pixels
 *  and the 4x pass four times); docs/TRANSFORM-VIDEO.md records the real GPU timing as open. */
export const UPSCALE_PASS_SHARE:{2:number;4:number}={2:0.15,4:0.4};

export type UpscalePlan={scale:2|4;width:number;height:number;reason:"720p"|"1080p"};

/**
 * The upscale a finished video result takes, or nothing when it is tall enough already.
 * The floor is 720p: the smaller of the pack's two scales that gets there. A result at least
 * 480p tall is asked for 1080p instead, but only when that pass stays under the extra-time
 * limit; the floor is used whether or not it does.
 */
export function planUpscale(source:{width:number;height:number},share:Partial<Record<2|4,number>>=UPSCALE_PASS_SHARE):UpscalePlan|undefined{
  const {width,height}=source;
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1)return undefined;
  if(height>=UPSCALE_SKIP)return undefined;
  const floor:[2|4,number]|undefined=([2,4] as const).map(scale=>[scale,height*scale] as [2|4,number]).find(([,tall])=>tall>=UPSCALE_FLOOR);
  if(!floor)return undefined;
  const [floorScale,floorHeight]=floor,wanted=height>=PREFERRED_SINCE?UPSCALE_PREFERRED:UPSCALE_FLOOR;
  const [scale,tall]=([2,4] as const).map(candidate=>[candidate,height*candidate] as [2|4,number])
    .find(([candidate,target])=>candidate>=floorScale&&target>=wanted&&(share[candidate]??1)<=UPSCALE_EXTRA_SHARE_LIMIT)??[floorScale,floorHeight];
  return {scale,width:width*scale,height:tall,reason:tall>=UPSCALE_PREFERRED?"1080p":"720p"};
}

/** The local upscaler this run chains: the NVIDIA VFX pack first, then any local pack whose title
 *  says upscale and whose one video input has a scale choice. A pack that is not ready on the
 *  worker is still returned here; admission rejects it and the chain stays off. */
export function upscaleBundle(catalogue:CapabilityBundle[]):CapabilityBundle|undefined{
  const candidates=catalogue.filter(bundle=>{
    const {manifest}=bundle;
    return !!bundle.template&&!!manifest.inputs.some(port=>port.id==="source_video"&&port.type==="video")&&
      manifest.inputs.filter(port=>port.type==="video").length===1&&manifest.outputs.some(port=>port.type==="video")&&
      manifest.controls.some(control=>control.id==="scale")&&
      (manifest.id===UPSCALE_PACK||/upscal/i.test(manifest.title))&&
      manifest.routes.some(route=>route.execution==="local_comfy"&&route.implementation==="implemented");
  });
  return candidates.find(bundle=>bundle.manifest.id===UPSCALE_PACK)??candidates[0];
}

/** The request that chains the upscale: one video in, one scale out, sound kept. */
export function upscaleControls(plan:UpscalePlan):Record<string,unknown>{
  return {scale:plan.scale,mode:UPSCALE_MODE};
}
