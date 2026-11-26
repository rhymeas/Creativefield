import {Button} from "../../ds";

/* Quick upscale at the top centre of the picture. Only its own buttons take the pointer, so a selection drag that
   starts on the picture is never swallowed (see editor.css .cf-editor-topstack). Hover or focus shows the two modes. */
export function QuickUpscaleLaunch({busy,detail,onRun}:{busy:boolean;/** The detailed route is installed. */detail:boolean;onRun:(mode:"fast"|"detail")=>void}){
  return <div className="cf-editor-topstack"><div className="cf-editor-quicklaunch">
    <Button variant="secondary" disabled={busy} onClick={()=>onRun("fast")} title="Fast AI upscale of the visible area">Quick upscale</Button>
    <div className="cf-editor-quickchoices" role="group" aria-label="Quick upscale mode">
      <Button variant="surface" disabled={busy} onClick={()=>onRun("fast")} title="Fast: ESRGAN detail and real 2x/4x resolution">Fast</Button>
      <Button variant="surface" disabled={busy||!detail} onClick={()=>onRun("detail")} title="Detailed: a light redraw of textured tiles, flat areas only enlarged, 2x canvas">Detailed</Button>
    </div>
  </div></div>;
}
