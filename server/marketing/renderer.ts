import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import sharp, { type Metadata, type OverlayOptions } from "sharp";
import * as opentype from "opentype.js";
import { formatSpec, type MarketingFormat } from "./contracts";

const require=createRequire(import.meta.url);
const fontRoot=path.join(path.dirname(require.resolve("@fontsource/space-grotesk/package.json")),"files");
export const MARKETING_RENDERER={id:"comfyfield-local-static-ad",version:"1.1.0",font:"Space Grotesk 600 / 400 (Fontsource 5.1.0)"} as const;
const MAX_INPUT_BYTES=25*1024*1024;
const MAX_INPUT_PIXELS=30_000_000;
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);

type Fonts={regular:opentype.Font;semibold:opentype.Font};
let fontPromise:Promise<Fonts>|undefined;
async function loadFont(file:string):Promise<opentype.Font>{
  const bytes=await readFile(path.join(fontRoot,file));
  const exact=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
  return opentype.parse(exact);
}
export function marketingFonts(){
  return fontPromise??=Promise.all([
    loadFont("space-grotesk-latin-400-normal.woff"),loadFont("space-grotesk-latin-600-normal.woff"),
  ]).then(([regular,semibold])=>({regular,semibold}));
}

export function contrastRatio(a:string,b:string){
  const luminance=(hex:string)=>{
    const channels=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
    return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
  };
  const [bright,dark]=[luminance(a),luminance(b)].sort((x,y)=>y-x);
  return (bright+.05)/(dark+.05);
}
export function readableColor(preferred:string,background:string){
  if(contrastRatio(preferred,background)>=4.5)return {color:preferred,fallback:false};
  const choices=["#000000","#FFFFFF"].map(color=>({color,ratio:contrastRatio(color,background)})).sort((a,b)=>b.ratio-a.ratio);
  if(choices[0].ratio<4.5)throw new Error("Background does not support a readable text color");
  return {color:choices[0].color,fallback:true};
}

function supported(font:opentype.Font,value:string,field:string){
  for(const char of value)if(char!==" "&&font.charToGlyphIndex(char)===0)throw new Error(`${field} contains an unsupported glyph`);
}
function wrap(font:opentype.Font,text:string,size:number,width:number,maxLines:number,field:string){
  supported(font,text,field);
  const words=text.trim().split(/\s+/u),lines:string[]=[];
  for(const word of words){
    if(font.getAdvanceWidth(word,size)>width)throw new Error(`${field} has a word that cannot fit`);
    const candidate=lines.length?`${lines.at(-1)} ${word}`:word;
    if(font.getAdvanceWidth(candidate,size)<=width){
      if(lines.length)lines[lines.length-1]=candidate;else lines.push(candidate);
    }else lines.push(word);
  }
  if(lines.length>maxLines)throw new Error(`${field} does not fit within ${maxLines} lines`);
  return lines;
}
function fit(font:opentype.Font,text:string,width:number,maxLines:number,preferred:number,minimum:number,field:string){
  for(let size=preferred;size>=minimum;size-=2){
    try{return {size,lines:wrap(font,text,size,width,maxLines,field)};}catch(error){
      if((error as Error).message.includes("unsupported glyph"))throw error;
    }
  }
  throw new Error(`${field} does not fit at the minimum readable size`);
}
function paths(font:opentype.Font,lines:string[],x:number,y:number,size:number,color:string,lineHeight=1.16){
  return lines.map((line,index)=>`<path fill="${color}" d="${font.getPath(line,x,y+index*size*lineHeight,size).toPathData(2)}"/>`).join("");
}
export async function validateMarketingRaster(input:Buffer,label:string){
  if(!input.length||input.length>MAX_INPUT_BYTES)throw new Error(`${label} image exceeds the local renderer byte limit`);
  let metadata:Metadata;
  try{metadata=await sharp(input,{failOn:"error",limitInputPixels:MAX_INPUT_PIXELS,animated:false}).metadata();}catch{throw new Error(`${label} is not a valid supported raster image`);}
  if(!metadata.width||!metadata.height||!metadata.format||!['png','jpeg','webp'].includes(metadata.format)||Number(metadata.pages??1)!==1)
    throw new Error(`${label} must be a single-frame PNG, JPEG, or WebP image`);
  if(metadata.width*metadata.height>MAX_INPUT_PIXELS)throw new Error(`${label} image exceeds the decoded pixel limit`);
  return metadata;
}

export type StaticAdRenderInput={format:MarketingFormat;variantIndex:number;headline:string;body:string;cta:string;primaryColor:string;backgroundColor:string;textColor:string;productImage:Buffer;logoImage?:Buffer};
export type StaticAdRenderResult={png:Buffer;width:number;height:number;selectedTextColor:string;usedContrastFallback:boolean};

export async function renderStaticAd(input:StaticAdRenderInput):Promise<StaticAdRenderResult>{
  const spec=formatSpec[input.format];
  if(!spec)throw new Error("Unsupported marketing format");
  if(!Number.isInteger(input.variantIndex)||input.variantIndex<0||input.variantIndex>5)throw new Error("Variant index is out of range");
  await validateMarketingRaster(input.productImage,"Product");
  if(input.logoImage)await validateMarketingRaster(input.logoImage,"Logo");
  const fonts=await marketingFonts(),readable=readableColor(input.textColor,input.backgroundColor);
  const margin=64,layout=input.variantIndex%3,story=input.format==="story_1080x1920",stacked=story||input.format==="portrait_1080x1350";
  const productShare=story?.52:.47,textShare=story?.58:.52;
  const product={
    left:stacked?margin:layout===1?Math.round(spec.width*.54):margin,
    top:margin,
    width:stacked?spec.width-margin*2:Math.round(spec.width*.42)-margin,
    height:stacked?Math.round(spec.height*productShare)-margin:spec.height-margin*2,
  };
  const text={
    left:stacked?margin:layout===1?margin:Math.round(spec.width*.48),
    top:stacked?Math.round(spec.height*textShare):margin+72,
    width:stacked?spec.width-margin*2:Math.round(spec.width*.46)-margin,
  };
  const headline=fit(fonts.semibold,input.headline,text.width,spec.headlineLines,stacked?76:input.format==="landscape_1920x1080"?86:72,40,"Headline");
  const body=fit(fonts.regular,input.body,text.width,4,stacked?36:34,28,"Body");
  const cta=fit(fonts.semibold,input.cta,Math.min(text.width-80,520),1,36,32,"CTA");
  const headlineHeight=headline.size+(headline.lines.length-1)*headline.size*1.16;
  const bodyHeight=body.size+(body.lines.length-1)*body.size*1.36;
  const ctaHeight=Math.max(72,cta.size+32),ctaWidth=Math.min(text.width,fonts.semibold.getAdvanceWidth(input.cta,cta.size)+80);
  const copyHeight=headlineHeight+body.size*.9+bodyHeight+52+ctaHeight;
  // Stacked formats put the product above the copy; a story centres that copy in the space below the product.
  const textTop=stacked?(story?Math.max(text.top,Math.round((product.top+product.height+spec.height-margin-copyHeight)/2)):text.top):Math.max(margin,Math.round((spec.height-copyHeight)/2));
  const headlineY=textTop+headline.size;
  const headlineBottom=headlineY+(headline.lines.length-1)*headline.size*1.16;
  const bodyY=headlineBottom+body.size*1.9;
  const bodyBottom=bodyY+(body.lines.length-1)*body.size*1.36;
  const ctaTop=bodyBottom+52;
  if(ctaTop+ctaHeight>spec.height-margin)throw new Error("Copy does not fit in the selected format");
  const accent=readableColor(readable.color,input.primaryColor).color;
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}">
    ${layout===2?`<rect x="0" y="0" width="${stacked?18:24}" height="${spec.height}" fill="${input.primaryColor}"/>`:""}
    ${paths(fonts.semibold,headline.lines,text.left,headlineY,headline.size,readable.color)}
    ${paths(fonts.regular,body.lines,text.left,bodyY,body.size,readable.color,1.36)}
    <rect x="${text.left}" y="${ctaTop}" width="${ctaWidth}" height="${ctaHeight}" rx="12" fill="${input.primaryColor}"/>
    ${paths(fonts.semibold,cta.lines,text.left+40,ctaTop+cta.size+14,cta.size,accent)}
  </svg>`,"utf8");
  const productBuffer=await sharp(input.productImage,{failOn:"error",limitInputPixels:MAX_INPUT_PIXELS}).rotate().resize(product.width,product.height,{fit:"contain",background:{r:0,g:0,b:0,alpha:0}}).png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  const composites:OverlayOptions[]=[{input:productBuffer,left:product.left,top:product.top},{input:svg,left:0,top:0}];
  if(input.logoImage){
    const logo=await sharp(input.logoImage,{failOn:"error",limitInputPixels:MAX_INPUT_PIXELS}).rotate().resize(180,90,{fit:"contain",background:{r:0,g:0,b:0,alpha:0},withoutEnlargement:true}).png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
    composites.push({input:logo,left:spec.width-margin-180,top:margin});
  }
  const png=await sharp({create:{width:spec.width,height:spec.height,channels:4,background:input.backgroundColor}}).composite(composites).png({compressionLevel:9,adaptiveFiltering:false,palette:false}).toBuffer();
  const verified=await sharp(png,{failOn:"error"}).metadata();
  if(!png.subarray(0,8).equals(PNG_SIGNATURE)||verified.format!=="png"||verified.width!==spec.width||verified.height!==spec.height)throw new Error("Rendered PNG verification failed");
  return {png,width:spec.width,height:spec.height,selectedTextColor:readable.color,usedContrastFallback:readable.fallback};
}

export async function checkMarketingRenderer(){
  try{
    await marketingFonts();
    const fixture=await sharp({create:{width:2,height:2,channels:4,background:"#FFFFFF"}}).png().toBuffer();
    const result=await renderStaticAd({format:"square_1080",variantIndex:0,headline:"Ready",body:"Local renderer check",cta:"Review",primaryColor:"#2FA8FF",backgroundColor:"#FFFFFF",textColor:"#000000",productImage:fixture});
    return result.png.length>8?{ready:true as const}:{ready:false as const,error:"Renderer produced no output"};
  }catch(error){return {ready:false as const,error:(error as Error).message};}
}
