import {ASSET_DRAG,Thumb,ThumbGrid,SectionHeader} from '../ds';
import {assetUrl,type Asset} from './api';

/** Project pictures stay available beside the editor so they can be dragged into shots. */
export function StoryboardLibrary({workspace,assets,onSelect,disabled}:{workspace:string;assets:Asset[];onSelect:(id:string)=>void;disabled?:boolean}){
 const images=assets.filter(asset=>asset.media_type==='image').slice(0,8);
 if(!images.length)return null;
 return <section aria-label="Project images"><SectionHeader title="Project images"/><ThumbGrid compact label="Project images">{images.map(image=>{
  const url=assetUrl(workspace,image.id);
  return <Thumb key={image.id} src={url} label={image.name} disabled={disabled} onActivate={()=>onSelect(image.id)} dragData={{type:ASSET_DRAG,value:image.id}}/>;
 })}</ThumbGrid></section>;
}
