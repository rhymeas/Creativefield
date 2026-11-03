import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {TeamMediaInput} from '../src/team/TeamMediaInput';
import type {Asset} from '../src/team/api';

describe('quick trim on media inputs',()=>{
 const selected={id:'video-id',name:'clip.mp4',media_type:'video',content_type:'video/mp4'} as Asset;
 const render=(disabled:boolean,onTrim?:()=>void)=>renderToStaticMarkup(<TeamMediaInput workspace="workspace" label="Source video" type="video" file={null} selected={selected} options={[selected]} disabled={disabled} canUpload onFile={()=>{}} onSelect={()=>{}} onUpload={()=>{}} onTrim={onTrim}/>);
 it('offers trim for an editable selected video when the workspace supports it',()=>{
  expect(render(false,()=>{})).toContain('aria-label="Trim video"');
  expect(render(true,()=>{})).not.toContain('aria-label="Trim video"');
  expect(render(false)).not.toContain('aria-label="Trim video"');
 });
});
