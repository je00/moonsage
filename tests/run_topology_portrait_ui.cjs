"use strict";

// Read-only local fixtures; compare the deployed pre-compaction layout with
// current geometry at identical CSS card sizes, without changing git checkout.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync} = require("node:child_process");
const {createHash} = require("node:crypto");
const {chromium, webkit} = require("playwright");
const {assertFixedCenter, assertFixedControls} = require("./topology_fixed_contract.cjs");
const {orbit} = require("./topology_gestures.cjs");
const {inlineSnapshot, geometryFindings, assertInlinePortContents, assertCardEdges, assertMarkerGeometry} = require("./topology_inline_assertions.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8878/");
assert(base.protocol === "http:" && ["127.0.0.1","localhost"].includes(base.hostname)
  && Number(base.port)>=1024 && !base.username && !base.password && base.pathname==="/" && !base.search && !base.hash);
const root = path.join(__dirname,".."), baselineOption=process.argv.indexOf("--baseline-ref");
const baselineRef=baselineOption<0?null:process.argv[baselineOption+1];
assert(baselineOption<0||baselineRef&&!baselineRef.startsWith("-"),"--baseline-ref requires an explicitly chosen local git revision");
const baseline = Object.fromEntries((baselineRef?["topology.js","topology.css"]:[]).map(file=>{
  const result=spawnSync("git",["show",`${baselineRef}:web/static/${file}`],{cwd:root,encoding:"utf8",maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr);return [file,result.stdout];
}));
const fixture=spawnSync(process.env.TOPOLOGY_TEST_PYTHON||"python3",[path.join(__dirname,"test_topology_permissions_fixture.py"),"--json"],{encoding:"utf8"});
assert.equal(fixture.status,0,fixture.stderr);const packet=JSON.parse(fixture.stdout);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"moonsage-portrait-layout-"));
const measureOnly=process.argv.includes("--measure-only");
const hash = value => createHash("sha256").update(value).digest("hex");
const report={directory,baselineRef,measureOnly,hashes:{baseline:baselineRef?hash(baseline["topology.js"]):null,current:hash(fs.readFileSync(path.join(root,"web/static/topology.js")))},cases:[],screenshots:[],errors:[],external:[],failures:[]};
// Stable synthetic-case limits, independent of private repository history.
// The 41-node fixture reserves two complete TCP/UDP scope rows.
const heightLimits={320:{6:980,12:1900,41:5680},390:{6:740,12:1360,41:3540},768:{6:635,12:1210,41:3850}};
const hook=(page,name)=>page.locator(`[data-topology-${name}]`);
const isJSON=url=>url.origin===base.origin&&url.pathname==="/network/topology/"&&url.searchParams.get("format")==="json";
const settle=async page=>{await page.waitForFunction(()=>!document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
console.log(`Portrait layout QA: ${directory}`);

function dense(selectedId){
  const original=packet.models.hub, source=original.nodes.find(node=>node.kind==="awg"&&node.availability==="enabled");
  const nodes=[original.nodes.find(node=>node.id==="hub"),...Array.from({length:40},(_,i)=>({...source,id:`awg:portrait-${i}`,name:`portrait-device-${i}`,address:`192.0.2.${i+10}`,protected:false}))];
  const selected=nodes.find(node=>node.id===selectedId)||nodes[0];
  const scopes=["TCP · 22, 443", "UDP · 53, 10000-20000"];
  const links=nodes.slice(1).flatMap(from=>nodes.filter(to=>from.id!==to.id).map(to=>({source:from.id,target:to.id,status:"partial",label:"配置授权",scopes})));
  const yes={status:"partial",label:"配置授权",summary:scopes.join("；"),scopes,warnings:[]};
  const unknown={status:"unknown",label:"未检测",summary:"VPS 发起访问未检测",scopes:[],warnings:[]};
  return {...original,nodes,links,selected,selected_id:selected.id,summary:{nodes:40,awg:40,vless:0,enabled:40,disabled:0,pending:0},
    relations:nodes.filter(node=>node.id!==selected.id).map(node=>({node,forward:selected.id==="hub"?unknown:yes,reverse:node.id==="hub"?unknown:yes,
      relation:selected.id==="hub"?"inbound":node.id==="hub"?"outbound":"mutual",label:"配置授权"}))};
}
async function geometry(page){
  await assertFixedCenter(page);
  return hook(page,"graph").evaluate(graph=>{
    const box=graph.getBoundingClientRect();
    const nodes=[...graph.querySelectorAll("[data-topology-node]")].map(node=>{const rect=node.getBoundingClientRect();return {id:node.dataset.topologyNode,
      xyz:[node.dataset.spaceX,node.dataset.spaceY,node.dataset.spaceZ],xy:[node.dataset.worldX,node.dataset.worldY],
      width:rect.width,height:rect.height,font:getComputedStyle(node.querySelector("strong")).fontSize,
      left:rect.left-box.left,right:rect.right-box.left,top:rect.top-box.top,bottom:rect.bottom-box.top};});
    return {width:box.width,height:box.height,camera:[graph.dataset.cameraYaw,graph.dataset.cameraPitch],
      scale:Number(graph.dataset.viewportScale),nodes,occupiedHeight:Math.max(...nodes.map(n=>n.bottom))-Math.min(...nodes.map(n=>n.top))};
  });
}
const xyz=value=>value.nodes.map(({id,xyz})=>({id,xyz}));
async function contained(page,label){
  const value=await geometry(page);
  const outside=value.nodes.filter(node=>node.left < -1||node.top < -1||node.right>value.width+1||node.bottom>value.height+1);
  assert.deepEqual(outside,[],`${label}: every full native-size card remains within the canvas at this camera angle`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  return value;
}
async function capture(page,label){
  await page.evaluate(()=>document.activeElement?.blur());
  await hook(page,"graph").screenshot({path:path.join(directory,label+".png"),style:".skip-link:not(:focus){visibility:hidden!important}"});
  report.screenshots.push(label+".png");
}
async function reset(page){await page.locator('button[data-topology-mode="overview"]').click();await hook(page,"reset").click();await settle(page);}
async function select(page,id){await hook(page,"select").selectOption(id);await page.waitForFunction(id=>document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode===id,id);await settle(page);}

async function inspectCurrent(page,model,label){
  const initial=await geometry(page);
  await assertFixedControls(page);
  assert.deepEqual(geometryFindings(await inlineSnapshot(page)),[],`${label}: default cards have no overlap or cropped text`);
  const source=model.links.find(link=>link.source!=="hub")?.source;assert(source);
  await select(page,source);await page.locator('[data-topology-direction="forward"]').click();await settle(page);
  const inline=await inlineSnapshot(page);
  assertInlinePortContents(inline,model.links,source,"forward");
  assert.deepEqual(geometryFindings(inline),[],`${label}: exact full-scope titles/rows remain inside separated native-size cards`);
  await assertCardEdges(page,true);await assertMarkerGeometry(page,true,true);
  await capture(page,label+"-ports");
  const angles=[];
  for(let i=0;i<28;i++){
    await orbit(page,i<14?"right":"left");
    if(i%2===0)await orbit(page,i<14?"up":"down");
    await settle(page);const value=await contained(page,label);
    assert.deepEqual(xyz(value),xyz(initial),"Changing the view never repacks normalized spatial coordinates");
    angles.push(value.camera);
  }
  const card=page.locator(`[data-topology-node="${source}"]`),before=await geometry(page);
  await card.focus();await page.keyboard.press("Alt+ArrowRight");await settle(page);
  const moved=await geometry(page);assert.notDeepEqual(xyz(moved),xyz(before),"A leaf remains movable in the compact portrait layout");
  await page.locator('[data-topology-direction="reverse"]').click();await settle(page);
  await Promise.all([page.waitForResponse(response=>isJSON(new URL(response.url()))),hook(page,"refresh").click()]);await settle(page);
  assert.deepEqual(xyz(await geometry(page)),xyz(moved),"Permission changes and configuration refresh preserve the user's dragged layout");
  assert.deepEqual((await geometry(page)).camera,moved.camera);
  const viewport=page.viewportSize();await page.setViewportSize({...viewport,width:viewport.width+12});await settle(page);
  assert.deepEqual(xyz(await geometry(page)),xyz(moved),"Responsive reflow preserves manual normalized coordinates");
  await contained(page,label+" resized");await page.setViewportSize(viewport);await settle(page);
  await reset(page);const restored=await geometry(page);
  assert.deepEqual(xyz(restored),xyz(initial),"One auto-arrange restores every default position after dragging/refresh/resize");
  assert.deepEqual(restored.camera,initial.camera,"Auto-arrange restores the default camera");
  assert.equal(restored.height,initial.height,"Rearrangement returns the compact canvas height");
  return {angles:angles.length,initial};
}

async function run(browser,engine,width,theme,version){
  const context=await browser.newContext({viewport:{width,height:1024},deviceScaleFactor:width===390?3:width===320?2:1,reducedMotion:"reduce",isMobile:true,hasTouch:true});
  let count=6,lastModel;
  try{
    await context.addInitScript(value=>localStorage.setItem("server-kit-theme",value),theme);
    await context.route("**/*",route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base.origin){report.external.push(url.href);return route.abort();}
      const file=url.pathname.split("/").pop();
      if(version==="baseline"&&baseline[file])return route.fulfill({status:200,contentType:file.endsWith(".js")?"application/javascript":"text/css",body:baseline[file]});
      if(isJSON(url)&&count!==6){lastModel=count===12?(packet.models[url.searchParams.get("node")]||packet.models[packet.initial_selected]):dense(url.searchParams.get("node"));return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(lastModel)});}
      return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(10000);page.on("pageerror",error=>report.errors.push(error.message));
    await page.goto(new URL("login/",base).href);await page.locator('[name="username"]').fill("preview");await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/",base).href),page.locator('button[type="submit"]').click()]);
    await context.request.get(new URL("__preview__/scenario/rich/",base).href);
    await page.goto(new URL("network/topology/",base).href);await hook(page,"node").first().waitFor();
    lastModel=await page.locator("#topology-data").evaluate(el=>JSON.parse(el.textContent));
    const requests=[];page.on("request",request=>requests.push(request.method()));
    for(const wanted of [6,12,41]){
      count=wanted;if(count!==6){await hook(page,"refresh").click();await page.waitForFunction(count=>document.querySelectorAll("[data-topology-node]").length===count,count);}
      await reset(page);const label=`${engine}-${width}-${theme}-${count}-${version}`,value=await contained(page,label);
      assert.equal(value.nodes.length,count);assert.deepEqual(geometryFindings(await inlineSnapshot(page)),[],label+": default non-overlap");
      const item={engine,width,theme,count,version,height:value.height,graphWidth:value.width,occupiedHeight:value.occupiedHeight,
        cards:value.nodes.map(({id,width,height,font})=>({id,width,height,font}))};
      report.cases.push(item);console.log(JSON.stringify({engine,width,theme,count,version,height:value.height}));
      if(version==="current")assert(value.height<=heightLimits[width][count],`${label}: compact canvas stays within the independently measured native-label height budget`);
      if(width===390&&count!==41)await capture(page,label+"-default");
      if(version==="current"&&!measureOnly){
        const model=count===6?await(await context.request.get(new URL("network/topology/?format=json",base).href)).json():lastModel;
        item.functional=await inspectCurrent(page,model,label);
      }
    }
    assert(requests.every(method=>method==="GET"),"Portrait audit has no management writes");
  }finally{await context.close();}
}
(async()=>{
  try{
    for(const [engine,factory]of measureOnly?[["chromium",chromium]]:[["chromium",chromium],["webkit",webkit]]){
      const browser=await factory.launch();try{for(const width of[320,390,768])for(const theme of measureOnly?["light"]:["light","dark"])for(const version of baselineRef?["baseline","current"]:["current"])await run(browser,engine,width,theme,version);}finally{await browser.close();}
    }
    report.comparisons=report.cases.filter(item=>item.version==="current"&&baselineRef).map(item=>{
      const old=report.cases.find(row=>row.version==="baseline"&&row.engine===item.engine&&row.width===item.width&&row.theme===item.theme&&row.count===item.count);
      assert.deepEqual(item.cards,old.cards,"Compactness never comes from smaller labels/cards or missing nodes");
      const ratio=item.height/old.height;
      assert(ratio<=1.001,"No portrait layout becomes taller than the deployed baseline");
      if(item.width<=390)assert(ratio<.995,"Narrow portrait canvas must actually become shorter");
      if(item.width===390&&item.count===6)assert(ratio<=.76,"Six-node phone layout saves at least 24% of its previous height");
      if(item.width===390&&item.count===12)assert(ratio<=.66,"Twelve-node phone layout saves at least 34% of its previous height");
      return {engine:item.engine,width:item.width,theme:item.theme,count:item.count,before:old.height,after:item.height,reduction:1-ratio};
    });
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);
    assert.equal(hash(fs.readFileSync(path.join(root,"web/static/topology.js"))),report.hashes.current,"Production layout stayed frozen for this test run");
  }catch(error){report.failure=error.stack;process.exitCode=1;console.error(error.stack);}
  finally{fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,cases:report.cases.length,comparisons:report.comparisons,failure:report.failure},null,2));}
})();
