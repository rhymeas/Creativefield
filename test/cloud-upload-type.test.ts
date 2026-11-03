import {describe,expect,it} from 'vitest';
import {cloudUploadType} from '../src/team/cloud-upload-type';

describe('cloud upload MIME detection',()=>{
 it('fills missing or generic types for supported file extensions',()=>{
  for(const [name,expected] of [['clip.MOV','video/quicktime'],['clip.webm','video/webm'],['photo.JPG','image/jpeg'],['image.png','image/png']] as const){
   const file=new File(['bytes'],name,{lastModified:123});const result=cloudUploadType(file);
   expect(result.type).toBe(expected);expect(result.lastModified).toBe(123);expect(result.size).toBe(file.size);
  }
  expect(cloudUploadType(new File(['x'],'clip.mp4',{type:'application/octet-stream'})).type).toBe('video/mp4');
 });
 it('preserves declared types and leaves unknown extensions alone',()=>{
  const declared=new File(['x'],'file.mov',{type:'video/mp4'});expect(cloudUploadType(declared)).toBe(declared);
  const unknown=new File(['x'],'file.unknown');expect(cloudUploadType(unknown)).toBe(unknown);
 });
});
