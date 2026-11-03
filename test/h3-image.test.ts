import {Readable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {describe,expect,it} from 'vitest';
import {prepareH3Images} from '../server/providers/h3-image';

describe('H3 image preparation',()=>{
 it('converts small wide WebP references without cropping the subject',async()=>{
  const source=await sharp({create:{width:500,height:80,channels:4,background:{r:240,g:40,b:10,alpha:1}}}).webp().toBuffer();
  const result=await prepareH3Images([{role:'reference_image',contentType:'image/webp',bytes:source.length,open:async()=>Readable.from([source])}]);
  expect(result.reference_image.startsWith('data:image/png;base64,')).toBe(true);
  const output=Buffer.from(result.reference_image.split(',')[1],'base64'),meta=await sharp(output).metadata();
  expect(Math.min(meta.width!,meta.height!)).toBeGreaterThanOrEqual(256);
  expect(Math.max(meta.width!/meta.height!,meta.height!/meta.width!)).toBeLessThanOrEqual(2.5);
  const stats=await sharp(output).stats();expect(stats.channels[3].min).toBe(0);
 });
 it('leaves an already compatible image unchanged',async()=>{
  const source=await sharp({create:{width:300,height:300,channels:3,background:'red'}}).jpeg().toBuffer();
  const result=await prepareH3Images([{role:'reference_image',contentType:'image/jpeg',bytes:source.length,open:async()=>Readable.from([source])}]);
  expect(result.reference_image).toBe(`data:image/jpeg;base64,${source.toString('base64')}`);
 });
 it('uses actual image bytes when metadata understates its size',async()=>{
  const source=await sharp(randomBytes(1900*1900*3),{raw:{width:1900,height:1900,channels:3}}).png().toBuffer();
  expect(source.length).toBeGreaterThan(10*1024*1024);
  const result=await prepareH3Images([{role:'reference_image',contentType:'image/png',bytes:1,open:async()=>Readable.from([source])}]);
  const output=Buffer.from(result.reference_image.split(',')[1],'base64');
  expect(output.length).toBeLessThanOrEqual(5*1024*1024);
  expect(output.equals(source)).toBe(false);
 },30000);
 it('applies EXIF orientation even when the original dimensions are compatible',async()=>{
  const source=await sharp({create:{width:320,height:480,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const result=await prepareH3Images([{role:'reference_image',contentType:'image/jpeg',bytes:source.length,open:async()=>Readable.from([source])}]);
  const output=Buffer.from(result.reference_image.split(',')[1],'base64'),meta=await sharp(output).metadata();
  expect(result.reference_image.startsWith('data:image/png;base64,')).toBe(true);
  expect([meta.width,meta.height]).toEqual([480,320]);expect(meta.orientation).toBeUndefined();
 });
});
