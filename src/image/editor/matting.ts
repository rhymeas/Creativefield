/** A quarter-strength one-pixel feather, only inward: erased pixels never return. */
export function softenEraseAlpha(alpha:Uint8ClampedArray,w:number,h:number):Uint8ClampedArray{
  const out=new Uint8ClampedArray(alpha);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;if(!alpha[i])continue;
    let sum=0,n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const xx=x+dx,yy=y+dy;if(xx<0||xx>=w||yy<0||yy>=h)continue;sum+=alpha[yy*w+xx];n++;
    }
    out[i]=Math.min(alpha[i],Math.round(alpha[i]*.75+sum/n*.25));
  }
  return out;
}

/** Contract the retained matte by whole pixels, then soften only its new inner edge.
 * This mirrors the conservative 1 px Photoshop matting pass used to remove a
 * background-colour fringe without growing already erased pixels back. */
export function contractEraseAlpha(alpha:Uint8ClampedArray,w:number,h:number,pixels=1):Uint8ClampedArray{
  let current=new Uint8ClampedArray(alpha),steps=Math.max(0,Math.min(2,Math.round(pixels)));
  while(steps--){
    const next=new Uint8ClampedArray(current);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let minimum=255;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const xx=x+dx,yy=y+dy;
        if(xx<0||xx>=w||yy<0||yy>=h)continue;
        minimum=Math.min(minimum,current[yy*w+xx]);
      }
      next[y*w+x]=Math.min(current[y*w+x],minimum);
    }
    current=next;
  }
  return softenEraseAlpha(current,w,h);
}

/** Replace a one-pixel fringe's RGB with the nearest more-interior colour.
 * Alpha and fully interior pixels remain exact; no expansion or repeated erosion. */
export function defringeOnePixel(rgba:Uint8ClampedArray,w:number,h:number):Uint8ClampedArray{
  const out=new Uint8ClampedArray(rgba),interior=new Uint8ClampedArray(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let min=rgba[(y*w+x)*4+3];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const xx=x+dx,yy=y+dy;if(xx>=0&&xx<w&&yy>=0&&yy<h)min=Math.min(min,rgba[(yy*w+xx)*4+3]);
    }interior[y*w+x]=min;
  }
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x,a=rgba[i*4+3];if(!a||interior[i]===255)continue;
    let best=i;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const xx=x+dx,yy=y+dy;if(xx<0||xx>=w||yy<0||yy>=h)continue;const j=yy*w+xx;
      if(rgba[j*4+3]>=a&&interior[j]>interior[best])best=j;
    }
    if(best!==i)for(let c=0;c<3;c++)out[i*4+c]=rgba[best*4+c];
  }
  return out;
}
