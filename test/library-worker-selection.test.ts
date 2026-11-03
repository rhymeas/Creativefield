import {describe,expect,it} from "vitest";
import {libraryWorkerId} from "../src/team/ComfyLibrary";
import type {Worker} from "../src/team/api";
const worker=(id:string,cloud:boolean,online:boolean,enabled=true):Worker=>({id,name:id,origin:cloud?"https://cloud.comfy.org":"http://127.0.0.1:8188",enabled,checked_at:null,inventory:{online,nodes:[],models:[],credentials:[]}});
describe("Models library worker selection",()=>{
 it("prefers an online local worker even when cloud comes first",()=>{expect(libraryWorkerId([worker("cloud",true,false),worker("local",false,true)])).toBe("local");});
 it("preserves an explicitly selected cloud worker",()=>{expect(libraryWorkerId([worker("cloud",true,false),worker("local",false,true)],"cloud")).toBe("cloud");});
 it("chooses an online provider when local is offline",()=>{expect(libraryWorkerId([worker("local",false,false),worker("cloud",true,true)])).toBe("cloud");});
 it("replaces a disabled choice and handles no enabled workers",()=>{expect(libraryWorkerId([worker("old",false,true,false),worker("local",false,true)],"old")).toBe("local");expect(libraryWorkerId([])).toBe("");});
});
