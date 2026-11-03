import {describe,expect,it,vi} from 'vitest';
import {resolveImageReference} from '../src/image/image-reference';
import type {Asset,Call} from '../src/team/api';

const image:Asset={id:'old',project_id:'project',name:'old.png',media_type:'image',content_type:'image/png',bytes:'1',created_at:'',parent_id:null};
describe('image references',()=>{
  it('resolves an older project image beyond the loaded library page',async()=>{
    const call=vi.fn(async()=>image) as unknown as Call;
    await expect(resolveImageReference('old',[],'workspace','project',call)).resolves.toEqual(image);
    expect(call).toHaveBeenCalledWith('/workspaces/workspace/assets/old');
  });
  it('rejects another project or a disguised video',async()=>{
    for(const asset of [{...image,project_id:'other'},{...image,media_type:'video',content_type:'video/mp4'},{...image,content_type:'image/gif'}])
      await expect(resolveImageReference('old',[asset],'workspace','project')).rejects.toThrow('PNG, JPEG or WebP');
  });
  it('does not accept missing or mismatched assets',async()=>{
    await expect(resolveImageReference('old',[],'workspace','project')).rejects.toThrow();
    const call=vi.fn(async()=>({...image,id:'other'})) as unknown as Call;
    await expect(resolveImageReference('old',[],'workspace','project',call)).rejects.toThrow();
  });
});
