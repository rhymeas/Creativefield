import type {Port} from "../capabilities/types";

/** A specific workflow/port mapping wins over shared port and media defaults. */
export function nativeFixtureFor(fixtures:Record<string,string>, capabilityId:string, port:Port):string|undefined {
  return fixtures[`${capabilityId}:${port.id}`] ?? fixtures[port.id] ??
    (port.representation ? fixtures[port.representation] : undefined) ?? fixtures[port.type];
}

/** Supply available optional fixtures too; missing required fixtures are reported separately. */
export function nativeFixtureInputs(fixtures:Record<string,string>, capabilityId:string, ports:Port[]):Record<string,string> {
  const inputs:Record<string,string> = {};
  for (const port of ports) {
    const fixture = nativeFixtureFor(fixtures, capabilityId, port);
    if (fixture) inputs[port.id] = fixture;
  }
  return inputs;
}

/** Validate every available optional-input combination, including gaps between ports. */
export function nativeFixtureVariants(fixtures:Record<string,string>, capabilityId:string, ports:Port[]):Array<{id:string;inputs:Record<string,string>}> {
  const all=nativeFixtureInputs(fixtures,capabilityId,ports);
  const required=Object.fromEntries(ports.filter(port=>port.required && all[port.id]).map(port=>[port.id,all[port.id]]));
  const variants=[{id:capabilityId,inputs:required}];
  const optional=ports.filter(port=>!port.required && all[port.id]);
  // Avoid silently claiming coverage if a future workflow would require an
  // impractically large power set; the caller reports this as a partial check.
  if(optional.length>8)throw new Error('Too many optional inputs for exhaustive native validation.');
  for(let mask=1;mask<2**optional.length;mask++){
    const selected=optional.filter((_,index)=>mask & (1<<index));
    variants.push({id:`${capabilityId}#optional-${selected.map(port=>port.id).join('+')}`,inputs:{...required,...Object.fromEntries(selected.map(port=>[port.id,all[port.id]]))}});
  }
  return variants;
}
