import type {ReactNode} from "react";

/** The shared right-hand column for every production workspace.
 *  It keeps guidance, current results, history and examples in one continuous area.
 */
export function ProductionContent({children}:{children:ReactNode}){
  return <div className="cf-production__content">{children}</div>;
}

