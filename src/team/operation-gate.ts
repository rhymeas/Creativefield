export type OperationGate={epoch:number;busy:string};

export function operationGate():OperationGate{return {epoch:0,busy:""};}

export function beginOperation(gate:OperationGate,busy:string){gate.epoch+=1;gate.busy=busy;return gate.epoch;}

export function invalidateOperation(gate:OperationGate){gate.epoch+=1;gate.busy="";}

export function finishOperation(gate:OperationGate,epoch:number){if(gate.epoch!==epoch)return false;gate.busy="";return true;}

export function ownsOperation(gate:OperationGate,epoch:number){return gate.epoch===epoch;}
