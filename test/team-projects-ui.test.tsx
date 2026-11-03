import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {ProjectCreateDialog} from "../src/team/TeamProjects";

describe("project creation",()=>{
  it("uses a small settings modal with name and optional description",()=>{
    const html=renderToStaticMarkup(<ProjectCreateDialog open onClose={()=>{}} onCreate={async()=>true}/>);
    expect(html).toContain("Add project");
    expect(html).toContain("Project name");
    expect(html).toContain("Description");
    expect(html).toContain("Optional");
  });
});
