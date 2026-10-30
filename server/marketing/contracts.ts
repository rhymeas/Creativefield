import { z } from "zod";

export const marketingFormats = ["square_1080", "portrait_1080x1350", "landscape_1920x1080", "story_1080x1920"] as const;
export type MarketingFormat = typeof marketingFormats[number];
export const formatSpec: Record<MarketingFormat,{width:number;height:number;headlineMax:number;headlineLines:number;bodyMax:number;ctaMax:number}> = {
  square_1080:{width:1080,height:1080,headlineMax:40,headlineLines:2,bodyMax:90,ctaMax:20},
  portrait_1080x1350:{width:1080,height:1350,headlineMax:48,headlineLines:3,bodyMax:120,ctaMax:20},
  landscape_1920x1080:{width:1920,height:1080,headlineMax:52,headlineLines:2,bodyMax:110,ctaMax:24},
  story_1080x1920:{width:1080,height:1920,headlineMax:44,headlineLines:3,bodyMax:110,ctaMax:24},
};
export const colorSchema=z.string().regex(/^#[0-9a-fA-F]{6}$/).transform(value=>value.toUpperCase());
export const optionalAssetId=z.uuid().nullable().optional();
const plainText=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!/[\p{Cc}]/u.test(value),"Control characters are not supported");

export const brandInput=z.object({
  name:plainText(120),primaryColor:colorSchema,backgroundColor:colorSchema,textColor:colorSchema,logoAssetId:optionalAssetId,
}).strict();
export const brandPatch=brandInput.extend({revision:z.number().int().positive()});
const productFields={
  name:plainText(120),description:z.string().trim().max(2000),imageAssetId:z.uuid(),
  additionalAssetIds:z.array(z.uuid()).max(8).default([]),
};
const uniqueAssets=<T extends {imageAssetId:string;additionalAssetIds:string[]}>(schema:z.ZodType<T>)=>schema.refine(value=>new Set([value.imageAssetId,...value.additionalAssetIds]).size===value.additionalAssetIds.length+1,{path:["additionalAssetIds"],message:"Asset references must be unique"});
export const productInput=uniqueAssets(z.object({projectId:z.uuid(),...productFields}).strict());
export const productPatch=uniqueAssets(z.object({...productFields,revision:z.number().int().positive()}).strict());
const briefFields={
  brandKitId:z.uuid(),productId:z.uuid(),objective:plainText(1000),format:z.enum(marketingFormats),
  headline:plainText(52),body:plainText(120),cta:plainText(24),variantCount:z.number().int().min(1).max(6),
};
const enforceBriefLimits=<T extends {format:MarketingFormat;headline:string;body:string;cta:string}>(schema:z.ZodType<T>)=>schema.superRefine((value,ctx)=>{
  const spec=formatSpec[value.format];
  for(const [field,max] of [["headline",spec.headlineMax],["body",spec.bodyMax],["cta",spec.ctaMax]] as const)
    if(value[field].length>max)ctx.addIssue({code:"too_big",origin:"string",maximum:max,inclusive:true,path:[field],message:`${field} exceeds the ${value.format} limit`});
});
export const briefInput=enforceBriefLimits(z.object({projectId:z.uuid(),...briefFields}).strict());
export const briefPatch=enforceBriefLimits(z.object({revision:z.number().int().positive(),...briefFields}).strict());
export const renderInput=z.object({projectId:z.uuid(),briefId:z.uuid(),idempotencyKey:z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)}).strict();
