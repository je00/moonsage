"use strict";

// Read-only local fixtures: native Chromium touch, WebKit lifecycle/CSS checks.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {spawnSync}=require("node:child_process"),{chromium,webkit}=require("playwright");
const {assertFixedControls,assertFixedCenter}=require("./topology_fixed_contract.cjs");
const {assertInlinePorts,assertCardEdges,assertMarkerGeometry}=require("./topology_inline_assertions.cjs");
const base=new URL(process.argv[2]||"http://127.0.0.1:8877/");
assert(base.protocol==="http:"&&["localhost","127.0.0.1"].includes(base.hostname)&&Number(base.port)>=1024&&!base.username&&!base.password&&base.pathname==="/"&&!base.search&&!base.hash);
const fixture=spawnSync(process.env.TOPOLOGY_TEST_PYTHON||"python3",[path.join(__dirname,"test_topology_permissions_fixture.py"),"--json"],{encoding:"utf8"});
assert.equal(fixture.status,0,fixture.stderr);const packet=JSON.parse(fixture.stdout);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"moonsage-topology-touch-")),report={directory,cases:[],desktop:[],screenshots:[],errors:[],external:[]};
const hook=(page,name)=>page.locator(`[data-topology-${name}]`),camera=s=>s.camera;
const settle=async page=>{await page.waitForFunction(()=>!document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await assertFixedCenter(page);};
const state=page=>hook(page,"graph").evaluate(graph=>({camera:[Number(graph.dataset.cameraYaw),Number(graph.dataset.cameraPitch)],inertia:graph.dataset.inertia,dragging:graph.dataset.dragging,
  editing:graph.dataset.layoutEditing,scroll:scrollY,selection:document.querySelector("[data-topology-select]").value,url:location.href,
  nodes:[...graph.querySelectorAll("[data-topology-node]")].map(n=>({id:n.dataset.topologyNode,xyz:[n.dataset.spaceX,n.dataset.spaceY,n.dataset.spaceZ],xy:[Number(n.dataset.worldX),Number(n.dataset.worldY)]}))}));
async function edit(page,on){if((await hook(page,"layout-edit").getAttribute("aria-pressed")==="true")!==on)await hook(page,"layout-edit").click();await settle(page);}
async function controls(page,on){
  await assertFixedControls(page);
  const value=await page.evaluate(()=>{const g=document.querySelector("[data-topology-graph]"),bar=document.querySelector("[data-topology-orbit-controls]");
    const info=el=>{const b=el.getBoundingClientRect();return {text:el.textContent.trim(),width:b.width,height:b.height,top:b.top,bottom:b.bottom,left:b.left,right:b.right,action:getComputedStyle(el).touchAction};};
    return {graph:getComputedStyle(g).touchAction,bar:{position:getComputedStyle(bar).position,...info(bar)},
      buttons:[...bar.querySelectorAll("button")].map(info),nodes:[...g.querySelectorAll("[data-topology-node]")].map(n=>({id:n.dataset.topologyNode,action:getComputedStyle(n).touchAction})),
      overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.equal(value.graph,"pan-y pinch-zoom");assert.equal(value.bar.position,"sticky");assert(!value.overflow);
  assert.equal(value.buttons.length,2,"Touch toolbar retains only reset and node-edit controls");
  assert(value.bar.text.includes("左右旋转")&&value.bar.text.includes("上下滚动"),"The compact toolbar explains the two distinct gesture directions");
  for(const item of value.buttons){assert(item.width>=44&&item.height>=44&&item.text);assert(item.left>=0&&item.right<=page.viewportSize().width);}
  for(const node of value.nodes){if(on&&node.id!=="hub")assert.equal(node.action,"pinch-zoom");
    else assert(node.action==="auto"||node.action==="pan-y pinch-zoom","Non-editable cards retain native scroll; the graph ancestor still limits horizontal pan");}
  assert.equal(await hook(page,"layout-edit").innerText(),on?"完成移动":"移动节点");return value;
}
async function position(page,target){
  if(target!=="blank")await page.locator(`[data-topology-node="${target}"]`).scrollIntoViewIfNeeded();
  else await hook(page,"graph").evaluate(g=>scrollTo(0,Math.min(scrollY+g.getBoundingClientRect().top+100,document.documentElement.scrollHeight-innerHeight-300)));
  await settle(page);
  return page.evaluate(target=>{const graph=document.querySelector("[data-topology-graph]"),b=graph.getBoundingClientRect();
    if(target!=="blank"){const el=graph.querySelector(`[data-topology-node="${target}"]`),r=el.getBoundingClientRect();
      for(const fy of [.5,.2,.8])for(const fx of [.5,.2,.8]){const p={x:r.left+r.width*fx,y:r.top+r.height*fy},hit=document.elementFromPoint(p.x,p.y);if(hit&&el.contains(hit))return p;}return null;}
    const low=Math.max(100,b.top+30),high=Math.min(innerHeight-60,b.bottom-30);
    for(const fraction of[.5,.65,.8,.35,.2])for(const x of[b.left+15,b.right-15,b.left+40,b.right-40]){
      const y=low+(high-low)*fraction,hit=document.elementFromPoint(x,y);
      if(high>low&&hit?.closest("[data-topology-graph]")===graph&&!hit.closest("[data-topology-node]"))return{x,y};}return null;
  },target);
}
async function gesture(page,context,engine,start,delta,{pause=120,cancel=false}={}){
  assert(start,"Gesture starts at an actual visible hit-testable surface");
  await page.evaluate(()=>{window.__touchTrace=[];if(window.__touchTraceInstalled)return;window.__touchTraceInstalled=true;
    for(const type of["pointerdown","pointermove","pointerup","pointercancel","gotpointercapture","lostpointercapture"])window.addEventListener(type,event=>{
      if(event.pointerType!=="touch")return;const graph=document.querySelector("[data-topology-graph]");window.__touchTrace.push({type,id:event.pointerId,
        target:event.target===graph?"graph":event.target.closest?.("[data-topology-node]")?.dataset.topologyNode||event.target.tagName,
        graphCapture:graph.hasPointerCapture(event.pointerId),yaw:Number(graph.dataset.cameraYaw),pitch:Number(graph.dataset.cameraPitch)});
    });});
  if(engine==="chromium"){
    const cdp=await context.newCDPSession(page);try{await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{id:1,...start}]});
      for(let i=1;i<=8;i++){await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{id:1,x:start.x+delta.x*i/8,y:start.y+delta.y*i/8}]});await page.waitForTimeout(16);}
      if(pause)await page.waitForTimeout(pause);await cdp.send("Input.dispatchTouchEvent",{type:cancel?"touchCancel":"touchEnd",touchPoints:[]});
    }finally{await cdp.detach();}
  }else await page.evaluate(async({start,delta,pause,cancel})=>{
    const graph=document.querySelector("[data-topology-graph]"),down=document.elementFromPoint(start.x,start.y);
    const send=(type,i)=>(type==="pointerdown"?down:graph).dispatchEvent(new PointerEvent(type,{pointerId:761,pointerType:"touch",isPrimary:true,bubbles:true,cancelable:true,
      clientX:start.x+delta.x*i/8,clientY:start.y+delta.y*i/8}));
    send("pointerdown",0);for(let i=1;i<=8;i++){send("pointermove",i);await new Promise(r=>setTimeout(r,16));}if(pause)await new Promise(r=>setTimeout(r,pause));send(cancel?"pointercancel":"pointerup",8);
  },{start,delta,pause,cancel});
  await settle(page);
}
async function swipe(page,context,engine,target,on,diagonal=false){
  await edit(page,on);const start=await position(page,target),before=await state(page);
  await gesture(page,context,engine,start,{x:diagonal?70:0,y:-150});await page.waitForTimeout(150);const after=await state(page);
  if(engine==="chromium")assert(after.scroll>before.scroll+65,`${on?"editing":"reading"}/${target}: native touch scrolls the document`);
  assert.deepEqual(camera(after),camera(before),"Page scroll cannot become camera rotation");assert.deepEqual(after.nodes,before.nodes);
  assert.equal(after.selection,before.selection);assert.equal(after.url,before.url);assert.notEqual(after.dragging,"true");
  return {mode:on?"editing":"reading",target,diagonal,scrollDelta:after.scroll-before.scroll,native:engine==="chromium"};
}
async function horizontal(page,context,engine,on,target="blank"){
  await edit(page,on);const start=await position(page,target),before=await state(page);
  await gesture(page,context,engine,start,{x:48,y:6});const after=await state(page);
  const change=Math.atan2(Math.sin(after.camera[0]-before.camera[0]),Math.cos(after.camera[0]-before.camera[0]));
  if(Math.abs(change-.288)>=.015)report.horizontalFailure={engine,on,target,start,before,after,change,trace:await page.evaluate(()=>window.__touchTrace)};
  assert(Math.abs(change-.288)<.015,`${engine}/${on?"editing":"reading"}/${target}: the entire 48px horizontal swipe rotates yaw, including after implicit capture transfers (${change})`);
  assert.equal(after.camera[1],before.camera[1],"Touch horizontal rotation never changes pitch");
  assert(Math.abs(after.scroll-before.scroll)<2,"Horizontal canvas rotation does not scroll the page");
  assert.deepEqual(after.nodes.map(n=>n.xyz),before.nodes.map(n=>n.xyz));assert.equal(after.selection,before.selection);assert.equal(after.url,before.url);
  return {editing:on,target,before:before.camera,after:after.camera,native:engine==="chromium"};
}
async function cancellation(page){
  const start=await position(page,"blank"),before=await state(page);
  const result=await page.evaluate(start=>{const graph=document.querySelector("[data-topology-graph]");
    const send=(target,type,id,x)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId:id,isPrimary:id===781,clientX:start.x+x,clientY:start.y}));
    const camera=()=>[graph.dataset.cameraYaw,graph.dataset.cameraPitch];send(graph,"pointerdown",781,0);send(graph,"pointermove",781,30);
    // A second finger outside the entire widget still cancels manipulation.
    send(document.body,"pointerdown",782,60);const stopped=camera();send(graph,"pointermove",781,65);send(document.body,"pointerup",782,60);send(graph,"pointermove",781,80);
    const surviving=camera();send(graph,"pointerup",781,80);return {stopped,surviving,dragging:graph.dataset.dragging,inertia:graph.dataset.inertia};
  },start);assert.deepEqual(result.surviving,result.stopped);assert.notEqual(result.dragging,"true");assert.equal(result.inertia,"idle");
  assert.equal((await state(page)).selection,before.selection);await settle(page);
  return result;
}
async function intentBoundary(page){
  await edit(page,false);const start=await position(page,"blank");
  const result=await page.evaluate(start=>{
    const graph=document.querySelector("[data-topology-graph]"),capture=graph.setPointerCapture,calls=[],events=[];
    graph.setPointerCapture=function(id){calls.push(id);return capture.call(this,id);};
    const camera=()=>[Number(graph.dataset.cameraYaw),Number(graph.dataset.cameraPitch)];
    const send=(target,type,id,x,y)=>{const event=new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId:id,isPrimary:true,clientX:start.x+x,clientY:start.y+y});target.dispatchEvent(event);events.push({type,id,prevented:event.defaultPrevented});};
    try{const before=camera(),focus=document.activeElement;send(graph,"pointerdown",791,0,0);send(graph,"pointermove",791,5,1);
      const pending={camera:camera(),captures:calls.length,focusUnchanged:document.activeElement===focus,prevented:events.some(e=>e.prevented)};
      send(graph,"pointermove",791,14,14);send(graph,"pointermove",791,80,15);
      const diagonal={camera:camera(),captures:calls.length,prevented:events.some(e=>e.prevented)};
      send(window,"pointerup",791,80,15);
      send(graph,"pointerdown",792,0,0);send(graph,"pointermove",792,30,1);const fresh={camera:camera(),captures:calls.length};send(graph,"pointercancel",792,30,1);
      send(graph,"pointerdown",793,0,0);send(window,"pointercancel",793,0,0);
      send(graph,"pointerdown",794,0,0);send(graph,"pointermove",794,30,1);const recovered=camera();send(graph,"pointercancel",794,30,1);
      return{before,pending,diagonal,fresh,recovered};
    }finally{graph.setPointerCapture=capture;}
  },start);
  assert.deepEqual(result.pending.camera,result.before);assert.equal(result.pending.captures,0);assert(result.pending.focusUnchanged);assert(!result.pending.prevented);
  assert.deepEqual(result.diagonal.camera,result.before,"An ambiguous diagonal gesture never turns into rotation later");assert.equal(result.diagonal.captures,0);assert(!result.diagonal.prevented);
  assert(result.fresh.camera[0]>result.before[0]+.1&&result.fresh.captures===1,"A fresh horizontal gesture works after pending pointerup outside canvas");
  assert.equal(result.fresh.camera[1],result.before[1]);assert(result.recovered[0]>result.fresh.camera[0]+.1,"Pending pointercancel outside canvas leaves no stale gesture");
  await settle(page);return result;
}
async function tapSelection(page){
  await edit(page,false);await page.locator('[data-topology-orbit="reset"]').click();
  for(const id of["awg:media-server","hub"]){await position(page,id);const point=await position(page,id);assert(point);await page.touchscreen.tap(point.x,point.y);
    await page.waitForFunction(id=>document.querySelector(`[data-topology-node="${id}"]`).getAttribute("aria-pressed")==="true",id);await settle(page);}
  await hook(page,"select").selectOption("vless:phone-all");await page.waitForFunction(()=>document.querySelector('[data-topology-node="vless:phone-all"]').getAttribute("aria-pressed")==="true");await settle(page);
}
async function leafDrag(page,context,engine){
  await page.locator('[data-topology-orbit="reset"]').click();await edit(page,true);
  const id="awg:media-server",start=await position(page,id),before=await state(page),node=before.nodes.find(n=>n.id===id);
  const fraction=Math.min(16/Math.max(1,Math.abs(node.xy[0])),18/Math.max(1,Math.abs(node.xy[1]))),delta={x:-node.xy[0]*fraction,y:-node.xy[1]*fraction};
  assert(Math.hypot(delta.x,delta.y)>6);await gesture(page,context,engine,start,delta);const after=await state(page),moved=after.nodes.find(n=>n.id===id);
  assert.notDeepEqual(moved.xyz,node.xyz);assert(Math.abs(moved.xy[0]-node.xy[0]-delta.x)<1.5&&Math.abs(moved.xy[1]-node.xy[1]-delta.y)<1.5);
  assert.deepEqual(camera(after),camera(before));assert(Math.abs(after.scroll-before.scroll)<2);assert.equal(after.selection,before.selection);
  assert.deepEqual(after.nodes.filter(n=>n.id!==id).map(n=>n.xyz),before.nodes.filter(n=>n.id!==id).map(n=>n.xyz));
  await edit(page,false);return {id,delta};
}
async function inertia(page,context,engine){
  await edit(page,false);await page.emulateMedia({reducedMotion:"no-preference"});
  const start=await position(page,"blank"),before=await state(page);
  await gesture(page,context,engine,start,{x:56,y:5},{pause:0});const released=await state(page);assert.equal(released.inertia,"running","Recent horizontal canvas drag starts bounded inertia");
  await page.waitForTimeout(90);const coasting=await state(page);assert(coasting.camera[0]>released.camera[0]);assert.equal(coasting.camera[1],before.camera[1],"Touch release inertia is yaw-only");
  await page.emulateMedia({reducedMotion:"reduce"});
  // WebKit delivers the media-query change event after emulateMedia resolves.
  await page.waitForFunction(()=>matchMedia("(prefers-reduced-motion: reduce)").matches&&document.querySelector("[data-topology-graph]").dataset.inertia==="idle",null,{timeout:750});
  const stopped=await state(page);assert.equal(stopped.inertia,"idle");
  await page.waitForTimeout(100);assert.deepEqual((await state(page)).camera,stopped.camera);assert.deepEqual(stopped.nodes.map(n=>n.xyz),before.nodes.map(n=>n.xyz));
  return {released:released.camera,stopped:stopped.camera};
}
async function defaultDark(page){
  const value=await page.evaluate(async()=>{const root=document.documentElement,original=root.getAttribute("data-theme"),wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const snapshot=()=>{const graph=document.querySelector("[data-topology-graph]"),moon=graph.querySelector('[data-topology-node="hub"]'),leaf=graph.querySelector('[data-topology-node]:not(.is-hub)');
      const colors=el=>{const s=getComputedStyle(el);return {color:s.color,background:s.backgroundColor,border:s.borderTopColor};};return {graph:colors(graph),moon:colors(moon),leaf:colors(leaf)};};
    try{root.setAttribute("data-theme","dark");await wait();const dark=snapshot();root.removeAttribute("data-theme");await wait();return {dark,missing:snapshot()};}
    finally{if(original===null)root.removeAttribute("data-theme");else root.setAttribute("data-theme",original);await wait();}
  });assert.deepEqual(value.missing,value.dark,"A missing theme attribute uses the exact dark graph/card tokens");return value;
}
async function run(browser,engine,width,theme){
  const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,reducedMotion:"reduce"});let page;
  try{await context.addInitScript(theme=>localStorage.setItem("server-kit-theme",theme),theme);
    await context.route("**/*",r=>{const u=new URL(r.request().url());if(u.origin!==base.origin){report.external.push(u.href);return r.abort();}
      if(u.pathname==="/network/topology/"&&u.searchParams.get("format")==="json")return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(packet.models[u.searchParams.get("node")]||packet.models[packet.initial_selected])});return r.continue();});
    page=await context.newPage();page.setDefaultTimeout(10000);page.on("pageerror",e=>report.errors.push(e.message));
    await page.goto(new URL("login/",base).href);await page.locator('[name="username"]').fill("preview");await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/",base).href),page.locator('button[type="submit"]').click()]);
    const requests=[];page.on("request",r=>requests.push({method:r.method(),url:r.url()}));await page.goto(new URL("network/topology/",base).href);await hook(page,"node").first().waitFor();await settle(page);
    assert.equal(await hook(page,"rotate-pad").count(),0,"The separate rotation pad is removed, not hidden");
    await hook(page,"refresh").click();await page.waitForFunction(()=>document.querySelectorAll("[data-topology-node]").length===12);await hook(page,"reset").click();
    await hook(page,"select").selectOption("vless:phone-all");await page.waitForFunction(()=>document.querySelector('[data-topology-node="vless:phone-all"]').getAttribute("aria-pressed")==="true");await settle(page);
    await assertInlinePorts(page,packet.models["vless:phone-all"].links,"vless:phone-all","forward");await assertCardEdges(page);await assertMarkerGeometry(page);
    const reading=await controls(page,false),swipes=[];for(const [on,target]of[[false,"blank"],[false,"awg:media-server"],[false,"hub"],[true,"blank"],[true,"hub"]])swipes.push(await swipe(page,context,engine,target,on));
    swipes.push(await swipe(page,context,engine,"blank",false,true));
    await edit(page,true);const editing=await controls(page,true);const shots=[];for(const on of[false,true]){await edit(page,on);await position(page,"blank");const filename=`${engine}-${width}-${theme}-${on?"editing":"reading"}.png`;
      await page.screenshot({path:path.join(directory,filename)});report.screenshots.push(filename);shots.push(filename);}
    const rotations=[];for(const[on,target]of[[false,"blank"],[false,"awg:media-server"],[false,"hub"],[true,"blank"],[true,"hub"]])rotations.push(await horizontal(page,context,engine,on,target));
    const intent=await intentBoundary(page),canceled=await cancellation(page);await horizontal(page,context,engine,false);await tapSelection(page);const dragged=await leafDrag(page,context,engine);
    const motion=width===390&&theme==="light"?await inertia(page,context,engine):null,themeFallback=await defaultDark(page);
    await edit(page,true);await page.keyboard.press("Escape");assert.equal((await state(page)).editing,"false");
    await edit(page,true);await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true})));assert.equal((await state(page)).editing,"false");
    assert(requests.every(r=>r.method==="GET"&&!r.url.includes("/__preview__/")));report.cases.push({engine,width,theme,reading,editing,swipes,rotations,intent,canceled,dragged,motion,themeFallback,screenshots:shots});
  }catch(error){if(page)await page.screenshot({path:path.join(directory,`${engine}-${width}-${theme}-failure.png`)}).catch(()=>{});throw error;}finally{await context.close();}
}
async function desktop(browser,engine){
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:"reduce"});
  try{await context.route("**/*",r=>new URL(r.request().url()).origin===base.origin?r.continue():r.abort());const page=await context.newPage();page.on("pageerror",e=>report.errors.push(e.message));
    await page.goto(new URL("login/",base).href);await page.locator('[name="username"]').fill("preview");await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/",base).href),page.locator('button[type="submit"]').click()]);await page.goto(new URL("network/topology/",base).href);await hook(page,"node").first().waitFor();await settle(page);await assertFixedControls(page);
    const start=await position(page,"blank"),before=await state(page);assert(start);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+48,start.y+20,{steps:6});await page.mouse.up();await settle(page);const after=await state(page);
    assert(Math.abs(after.camera[0]-before.camera[0]-.288)<.015&&Math.abs(after.camera[1]-before.camera[1]+.12)<.015,"Trusted desktop blank drag still rotates both axes");
    assert.deepEqual(after.nodes.map(n=>n.xyz),before.nodes.map(n=>n.xyz));assert.equal(after.scroll,before.scroll);report.desktop.push({engine,before:before.camera,after:after.camera});
  }finally{await context.close();}
}
console.log(`Topology touch QA: ${directory}`);
(async()=>{try{for(const[engine,factory]of[["chromium",chromium],["webkit",webkit]]){const browser=await factory.launch();try{for(const width of[390,320])for(const theme of["light","dark"])await run(browser,engine,width,theme);await desktop(browser,engine);}finally{await browser.close();}}
  assert.equal(report.cases.length,8);assert.equal(report.desktop.length,2);assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);
}catch(error){report.failure=error.stack;console.error(error.stack);process.exitCode=1;}finally{fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,cases:report.cases.length,screenshots:report.screenshots.length,failure:report.failure},null,2));}})();
