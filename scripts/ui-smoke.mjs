// Read-only click-through of the running app: opens every top-level screen and its tabs and
// cards, checks the full view and the dropdown rows, and reports what breaks. Every request
// that is not GET or HEAD is aborted, so nothing is written and no run is queued.
// Needs playwright-core + Chromium.
// Usage: node scripts/ui-smoke.mjs [baseUrl]

import {chromium} from "playwright-core";
import {existsSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {classifyScreen,isForbiddenAction} from "./ui-smoke-lib.mjs";

const BASE=process.argv[2]??"http://127.0.0.1:8787";
const OUT=join(process.cwd(),".comfyfield","qa");
const CANDIDATES=[
  process.env.CHROME_PATH,
].filter(Boolean);
const executablePath=CANDIDATES.find(path=>existsSync(path));
if(!executablePath){console.error("no Chromium found; set CHROME_PATH");process.exit(1);}
mkdirSync(OUT,{recursive:true});

const screens=[],skipped=[];
let current=null,step="open",page=null,fullViewDone=false;

function startScreen(name){
  current={name,steps:[],raw:{screen:name,consoleErrors:[],pageErrors:[],responses:[],notices:[],overflows:[],blocked:[],checks:[],emptyBody:null}};
  screens.push(current);step="open";
}
function setStep(name){
  const text=String(name??"").replace(/\s+/g," ").trim()||"open";
  step=text;
  if(current&&!current.steps.includes(text))current.steps.push(text);
}
function note(kind,value){current?.raw[kind].push({step,...value});}
function check(name,ok,message){current?.raw.checks.push({step,name,ok,message});}
function skip(what){skipped.push(`${current?.name??"?"} · ${what}`);}

/* The screen's own text: the body without the top navigation, which is always there. */
async function screenText(){
  return page.evaluate(()=>{
    const bar=document.querySelector(".ds-topbar");
    const text=document.body.innerText??"";
    return (bar?.innerText?text.replace(bar.innerText,""):text).trim();
  }).catch(()=>"");
}
async function waitForContent(seconds=5){
  const end=Date.now()+seconds*1000;
  while(Date.now()<end){
    if((await screenText()).length>=20)return true;
    await page.waitForTimeout(250);
  }
  return false;
}
async function settle(ms=1000){await page.waitForTimeout(ms);}

/* Panels and blocks wider than the space they have, plus a page that scrolls sideways. */
async function overflows(){
  return page.evaluate(()=>{
    const out=[];
    const name=element=>{
      const raw=typeof element.className==="string"?element.className.trim().split(/\s+/).slice(0,3).join("."):"";
      return `${element.tagName.toLowerCase()}${raw?`.${raw}`:""}`;
    };
    const roots=".ds-panel,.ds-block,.ds-split,.ds-wsbar,.ds-mediacard,.ds-notice,.ds-sectionhead,.ds-page,.cf-change-cards";
    for(const element of document.querySelectorAll(roots)){
      if(!element.clientWidth||element.scrollWidth<=element.clientWidth+24)continue;
      const style=getComputedStyle(element);
      if(style.visibility==="hidden"||style.display==="none")continue;
      // A scrolling box reports its scrollbar width as extra room; that is not an overflow.
      if(/auto|scroll/.test(style.overflowX)||/auto|scroll/.test(style.overflowY))continue;
      out.push({selector:name(element),scroll:element.scrollWidth,client:element.clientWidth});
      if(out.length>=5)break;
    }
    if(document.documentElement.scrollWidth>window.innerWidth+2)out.push({selector:"body",scroll:document.documentElement.scrollWidth,client:window.innerWidth});
    return out;
  }).catch(()=>[]);
}
/* Notice texts and overflows belong to the screen that is open when they are read. */
async function collect(){
  if(!current)return;
  const notices=await page.locator(".ds-notice:visible").evaluateAll(nodes=>nodes.map(node=>(node.textContent??"").trim())).catch(()=>[]);
  for(const text of notices)note("notices",{text});
  for(const item of await overflows())note("overflows",item);
}
/* After a click that changes the screen: wait for content, then read the screen. */
async function landed(){
  if(!(await waitForContent(5)))current.raw.emptyBody={step,waitedSeconds:5};
  await settle(600);
  await collect();
}

async function clickControl(locator,label,allow=false){
  const text=(await locator.innerText().catch(()=>"")).trim();
  if(!allow&&isForbiddenAction(text)){skip(`did not click "${text.split("\n")[0].slice(0,40)}"`);return false;}
  await locator.click({timeout:8000});
  return true;
}

/* A top-bar section: click its name, then the menu entry it opens (if any). */
async function navTo(label,pick){
  const items=page.locator(".ds-topbar__nav .ds-navlink");
  const count=await items.count();
  for(let index=0;index<count;index++){
    const item=items.nth(index);
    const text=(await item.innerText().catch(()=>"")).trim();
    if(!text.startsWith(label))continue;
    setStep(label);
    if(!(await clickControl(item,label,true)))return false;
    await settle(500);
    const menu=page.locator(".ds-mega:visible .ds-mega__item, .ds-navdrop:visible .ds-menu__item");
    const entries=await menu.count();
    if(!entries)return true;
    let choice=0;
    if(pick){
      const names=await menu.evaluateAll(nodes=>nodes.map(node=>(node.textContent??"").trim()));
      const found=names.findIndex(name=>pick.test(name));
      if(found<0){await page.keyboard.press("Escape");skip(`no menu entry for ${label} matches ${pick}`);return false;}
      choice=found;
    }
    const picked=(await menu.nth(choice).innerText().catch(()=>"")).trim();
    setStep(picked.split("\n")[0]||label);
    await menu.nth(choice).click({timeout:8000});
    return true;
  }
  skip(`${label} is not in the top bar`);
  return false;
}

async function openSection(name,label,pick){
  // A blocked request can leave the app waiting; a fresh load puts the next screen back in its ready state.
  const previous=screens.at(-1);
  if(previous?.raw.blocked.length){
    await page.goto(BASE,{waitUntil:"domcontentloaded",timeout:30000}).catch(()=>{});
    await page.waitForSelector(".ds-topbar",{timeout:20000}).catch(()=>{});
    await settle(2000);
    skip("reloaded the page after a blocked request, so the next screen starts ready");
  }
  startScreen(name);
  let opened=false;
  for(let attempt=1;attempt<=2&&!opened;attempt++){
    opened=await navTo(label,pick);
    if(!opened&&attempt<2){await page.keyboard.press("Escape");await settle(1500);}
  }
  if(!opened)check(`${name} opens`,false,`${name} could not be opened from the top bar.`);
  await landed();
  return opened;
}

async function clickTab(name){
  // Mode tabs sit in the workspace bar; a screen may also carry its switch beside its title (Library).
  for(const scope of ['.ds-wsbar [role="tab"]:visible','[role="tab"]:visible']){
    const tabs=page.locator(scope);
    const names=await tabs.evaluateAll(nodes=>nodes.map(node=>(node.textContent??"").trim()));
    const index=names.indexOf(name);
    if(index<0)continue;
    setStep(name);
    await tabs.nth(index).click({timeout:8000});
    await settle(800);
    return true;
  }
  skip(`tab "${name}" is not there`);
  return false;
}

async function rowWithLabel(label){
  const rows=page.locator(".ds-row:visible");
  const labels=await rows.evaluateAll(nodes=>nodes.map(node=>(node.querySelector(".ds-row__label")?.textContent??"").trim()));
  const index=labels.indexOf(label);
  return index<0?null:rows.nth(index);
}

/* One dropdown row: it must open its list and close again, without choosing anything. */
async function dropdownRow(label,locator){
  setStep(`${label} dropdown`);
  if(!locator){skip(`no ${label} row on this screen`);return;}
  const before=await page.locator(".ds-dialog:visible").count();
  await locator.click({timeout:8000});
  await settle(700);
  const open=await page.locator(".ds-dialog:visible").count();
  check(`${label} opens its list`,open>before,`${label} opened no list.`);
  await page.keyboard.press("Escape");
  await settle(500);
  check(`${label} closes again`,await page.locator(".ds-dialog:visible").count()===before,`${label} did not close with Escape.`);
}

/* The first media tile: full view, its actions panel, "Open in", then close it all again. */
async function fullViewCheck(){
  if(fullViewDone)return false;
  let tile=page.locator(".ds-mediacard__view:visible").first();
  if(!(await tile.count()))tile=page.locator(".ds-media:visible").first();
  if(!(await tile.count()))return false;
  fullViewDone=true;
  setStep("Full view");
  await tile.click({timeout:8000});
  await settle(900);
  let open=await page.locator(".ds-viewer").count()>0;
  if(!open){
    const button=page.locator("button[aria-label='Full view']:visible").first();
    if(await button.count()){await button.click({timeout:8000});await settle(900);open=await page.locator(".ds-viewer").count()>0;}
  }
  check("the full view opens",open,"The full view did not open from the first media tile.");
  if(!open){await page.keyboard.press("Escape");await settle(400);return true;}
  const actions=await page.locator(".ds-viewer__panel button, .ds-viewer__panel a").evaluateAll(nodes=>nodes.map(node=>(node.textContent??node.getAttribute("aria-label")??"").trim()));
  for(const needed of ["Edit","Open in","Download"]){
    check(`actions panel has ${needed}`,actions.some(text=>text===needed||text.startsWith(`${needed} `)),`The full view's actions panel has no ${needed} action.`);
  }
  if(actions.some(text=>text==="Open in")){
    setStep("Open in");
    await page.locator(".ds-viewer__panel button:visible").filter({hasText:"Open in"}).first().click({timeout:8000});
    await settle(700);
    check("Open in opens its list",await page.locator(".ds-dialog").count()>0,"Open in opened no list.");
    await page.keyboard.press("Escape");
    await settle(600);
    check("Open in closes again",await page.locator(".ds-dialog").count()===0,"The Open in list did not close with Escape.");
  }else skip('the actions panel has no "Open in"');
  setStep("Close full view");
  await page.keyboard.press("Escape");
  await settle(600);
  if(await page.locator(".ds-viewer").count()){
    const close=page.locator(".ds-viewer button[aria-label='Close']:visible").first();
    if(await close.count()){await close.click({timeout:8000});await settle(500);}
  }
  check("the full view closes",await page.locator(".ds-viewer").count()===0,"The full view did not close with Escape or its Close button.");
  return true;
}

const browser=await chromium.launch({executablePath,headless:true,args:["--disable-gpu","--no-sandbox"]});
try{
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10000);
  // Read only: only GET and HEAD reach the server. Anything else is counted against the click that caused it.
  await page.route("**/*",async route=>{
    const request=route.request();
    if(request.method()==="GET"||request.method()==="HEAD"){await route.continue().catch(()=>{});return;}
    note("blocked",{method:request.method(),url:request.url()});
    await route.abort().catch(()=>{});
  });
  page.on("console",message=>{if(message.type()==="error")note("consoleErrors",{text:message.text()});});
  page.on("pageerror",error=>note("pageErrors",{text:error.message}));
  page.on("response",response=>{if(response.status()>=400)note("responses",{url:response.url(),status:response.status()});});

  await page.goto(BASE,{waitUntil:"domcontentloaded",timeout:30000});
  await page.waitForSelector(".ds-topbar",{timeout:20000});
  await settle(2000);

  /* Video: every mode tab, and the four cards inside Change. A tab that is not here is
     left out by design when its workflow cannot run on this computer, so it is not a finding. */
  await openSection("Video · Storyboard","Video",/storyboard/i);
  for(const tab of ["Create","Change","Edit","Effects","Trim"]){
    startScreen(`Video · ${tab}`);
    try{
      if(!(await clickTab(tab)))skip(`no ${tab} tab on this computer`);
      await landed();
      await fullViewCheck();
      if(tab==="Create"){
        await dropdownRow("Model",await rowWithLabel("Model"));
        await dropdownRow("Quality",await rowWithLabel("Quality"));
        const runOn=page.locator(".ds-pill[aria-label='Run on']:visible").first();
        await dropdownRow("Run on",(await runOn.count())?runOn:null);
      }
      if(tab==="Change"){
        const labels=await page.locator(".cf-change-cards .ds-preset:visible").evaluateAll(nodes=>nodes.map(node=>(node.querySelector(".ds-preset__label")?.textContent??"").trim()));
        if(!labels.length)skip("no Change cards");
        for(const label of labels){
          setStep(`Card: ${label}`);
          const card=page.locator(".cf-change-cards .ds-preset:visible").filter({hasText:label}).first();
          if(!(await card.count()))continue;
          if(!(await clickControl(card,label)))continue;
          await settle(900);
        }
      }
    }catch(cause){check(`${tab} walk`,false,`${tab} could not be walked: ${String(cause).split("\n")[0]}`);}
  }

  /* Image: its own tabs, whatever this computer can do. */
  await openSection("Image","Image",/create image/i);
  const imageTabs=await page.locator('.ds-wsbar [role="tab"]:visible').evaluateAll(nodes=>nodes.map(node=>(node.textContent??"").trim()));
  if(!imageTabs.length)skip("no Image tabs");
  for(const tab of imageTabs){
    startScreen(`Image · ${tab}`);
    try{
      if(!(await clickTab(tab)))skip(`no ${tab} tab on this computer`);
      await landed();
      await fullViewCheck();
    }catch(cause){check(`${tab} walk`,false,`${tab} could not be walked: ${String(cause).split("\n")[0]}`);}
  }

  /* 3D, All tools, Models, Nodes, Library, Projects. */
  await openSection("3D","3D");
  await fullViewCheck();
  await openSection("All tools","All tools");
  {
    const labels=await page.locator(".cf-start .ds-preset:visible").evaluateAll(nodes=>nodes.map(node=>(node.querySelector(".ds-preset__label")?.textContent??"").trim()).slice(0,3));
    if(!labels.length)skip("no All tools cards");
    for(const label of labels){
      startScreen(`All tools · ${label}`);
      try{
        setStep(label);
        const card=page.locator(".cf-start .ds-preset:visible").filter({hasText:label}).first();
        if(!(await card.count()))continue;
        if(!(await clickControl(card,label)))continue;
        await landed();
        await navTo("All tools");
        await settle(700);
      }catch(cause){check(`${label} walk`,false,`${label} could not be opened: ${String(cause).split("\n")[0]}`);}
    }
  }
  await openSection("Models","Models");
  await openSection("Nodes","Nodes");
  await openSection("Library · Assets","Library");
  try{
    if(!(await clickTab("Assets")))skip("no Assets tab");
    await landed();
  }catch(cause){check("Assets walk",false,`Assets could not be walked: ${String(cause).split("\n")[0]}`);}
  await fullViewCheck();
  startScreen("Library · Runs");
  try{
    if(!(await clickTab("Runs")))skip("no Runs tab");
    await landed();
  }catch(cause){check("Runs walk",false,`Runs could not be walked: ${String(cause).split("\n")[0]}`);}
  await openSection("Projects","Projects",/all projects/i);
}finally{
  await browser.close().catch(()=>{});
}

const findings=[];
for(const screen of screens)findings.push(...classifyScreen(screen.raw));
const report={
  base:BASE,
  ranAt:new Date().toISOString(),
  readOnly:"every request that was not GET or HEAD was aborted before it reached the server",
  screens:screens.map(screen=>({screen:screen.name,steps:screen.steps,findings:findings.filter(finding=>finding.screen===screen.name).length})),
  findings,
  skipped,
};
writeFileSync(join(OUT,"smoke.json"),JSON.stringify(report,null,2));

/* A short table: screen, step, kind, message. */
const rows=[["screen","step","kind","message"],...findings.map(finding=>[finding.screen,finding.step,finding.kind,finding.message])];
const widths=[0,1,2,3].map(column=>Math.min(column===3?84:30,Math.max(...rows.map(row=>row[column].length))));
for(const [index,row] of rows.entries()){
  const line=row.map((cell,column)=>cell.length>widths[column]?`${cell.slice(0,widths[column]-1)}…`:cell.padEnd(widths[column])).join("  ");
  console.log(line);
  if(index===0)console.log(widths.map(width=>"-".repeat(width)).join("  "));
}
console.log(`\n${findings.length} finding${findings.length===1?"":"s"} on ${screens.length} screens · wrote ${join(OUT,"smoke.json")}`);
for(const item of skipped)console.log(`skipped: ${item}`);
process.exitCode=findings.length?1:0;
