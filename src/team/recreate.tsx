import {createContext,useContext,type ReactNode} from "react";
import type {Run} from "./api";

/** Gives a finished run the way back into the tool it was made in, or nothing where that cannot work.
 *  The app provides it once; every list of runs asks it, so no screen decides on its own. */
export type RecreateRun=(run:Run)=>(()=>void)|undefined;
const RecreateContext=createContext<RecreateRun>(()=>undefined);
export function RecreateProvider({value,children}:{value:RecreateRun;children:ReactNode}){return <RecreateContext.Provider value={value}>{children}</RecreateContext.Provider>;}
export const useRecreate=()=>useContext(RecreateContext);
