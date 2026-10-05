"use strict";

// Bounded, local-only badge regression. The twelve-node models come from the
// real Python projector; page-scoped JSON interception never resets the preview.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync} = require("node:child_process");
const {chromium, webkit} = require("playwright");
const {inlineSnapshot, geometryFindings, assertInlinePorts, assertCardEdges, assertMarkerGeometry} = require("./topology_inline_assertions.cjs");
const {assertFixedCenter, assertDepthOcclusion} = require("./topology_fixed_contract.cjs");
const {orbit, measureOrbitStep} = require("./topology_gestures.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8877/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash);
const fixture = spawnSync(process.env.TOPOLOGY_TEST_PYTHON || "python3", [path.join(__dirname, "test_topology_permissions_fixture.py"), "--json"], {encoding:"utf8"});
assert.equal(fixture.status, 0, fixture.stderr);
const packet = JSON.parse(fixture.stdout);
assert.equal(packet.generated_by, "dashboard.topology.build_topology");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-topology-badges-"));
const caseFilter=process.argv.find(value=>value.startsWith("--case="))?.slice(7)||null;
if(caseFilter)assert(/^(chromium|webkit)-(1440|390|320)-(light|dark)$/.test(caseFilter));
const report = {directory, caseFilter, expectedCaseCount:caseFilter?1:12, projector:packet.generated_by, cases:[], screenshots:[], errors:[], external:[], requests:[]};
const hook = (page, name) => page.locator(`[data-topology-${name}]`);
const isJSON = url => url.origin === base.origin && url.pathname === "/network/topology/" && url.searchParams.get("format") === "json";
const settle = async page => {
  await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertFixedCenter(page);
};
const media = "awg:media-server";
console.log(`Topology badge QA: ${directory}`);

async function select(page, id, direction) {
  await hook(page,"select").selectOption(id);
  await page.waitForFunction(id => document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode === id, id);
  await page.locator(`[data-topology-direction="${direction}"]`).click();
  await settle(page);
}

async function metrics(page) {
  return hook(page,"graph").evaluate(graph => {
    const rect = el => {const b=el.getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};
    const visible = el => !el.hidden && getComputedStyle(el).display !== "none";
    return {graph:rect(graph), nodes:[...graph.querySelectorAll("[data-topology-node]")].map(node => {
      const name=node.querySelector("strong"), state=node.querySelector(".topology-node-state"), rates=node.querySelector(".topology-node-rates");
      const roles=[...node.querySelectorAll(".topology-node-selected, .topology-node-peer")].filter(visible);
      const before={width:name.clientWidth,height:node.offsetHeight}, badgeBoxes=roles.map(el=>({text:el.textContent,box:rect(el),position:getComputedStyle(el).position,font:parseFloat(getComputedStyle(el).fontSize)}));
      roles.forEach(el=>{el.hidden=true;});
      const removed={width:name.clientWidth,height:node.offsetHeight};
      roles.forEach(el=>{el.hidden=false;});
      return {id:node.dataset.topologyNode, shape:node.dataset.topologyShape, box:rect(node), name:rect(name), state:rect(state),rates:rates?rect(rates):null,
        nameText:name.textContent, nameClient:name.clientWidth,nameScroll:name.scrollWidth,font:parseFloat(getComputedStyle(name).fontSize),
        gridStart:getComputedStyle(name).gridColumnStart,gridEnd:getComputedStyle(name).gridColumnEnd,
        stateFont:parseFloat(getComputedStyle(state).fontSize),rateFont:rates?parseFloat(getComputedStyle(rates).fontSize):null,
        before,removed,badges:badgeBoxes,depth:Number(node.dataset.cameraDepth),rank:Number(getComputedStyle(node).getPropertyValue("--topology-depth-index")),z:Number(getComputedStyle(node).zIndex)};
    })};
  });
}

function checkMetrics(value, baseline, label) {
  const overlaps=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.2 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.2;
  const inside=(a,b)=>a.left>=b.left-.25&&a.right<=b.right+.25&&a.top>=b.top-.25&&a.bottom<=b.bottom+.25;
  for(const node of value.nodes) {
    assert.equal(node.z,20+node.rank,`${label}/${node.id}: badges cannot elevate a node above its actual depth`);
    for(const other of value.nodes) if(node.depth>other.depth+.000001) assert(node.z>other.z);
    assert.deepEqual(node.before,node.removed,`${label}/${node.id}: removing either visible role badge changes neither card height nor title width`);
    if(node.id!=="hub") {
      assert.equal(node.gridStart,"1");assert.equal(node.gridEnd,"-1","Leaf titles keep the complete row");
      assert(node.font>=13&&node.stateFont>=10&&node.rateFont>=11,"Badge space is never purchased by reducing readable type");
      if(baseline) {
        const initial=baseline.nodes.find(item=>item.id===node.id);
        assert(Math.abs(node.nameClient-initial.nameClient)<=2,`${label}/${node.id}: role changes do not steal title width (${initial.nameClient} → ${node.nameClient})`);
        assert.equal(node.font,initial.font);assert.equal(node.stateFont,initial.stateFont);assert.equal(node.rateFont,initial.rateFont);
      }
      if(node.id===media) assert(node.nameScroll<=node.nameClient,`${label}: medium-length media-server stays completely visible`);
    }
    for(const badge of node.badges) {
      assert.equal(badge.position,"absolute");assert(badge.font>=11);
      assert(inside(badge.box,value.graph),`${label}/${node.id}: entire ${badge.text} badge stays within the canvas`);
      if(node.id==="hub") assert(inside(badge.box,node.box),"The lunar role stays inside the moon");
      else {
        assert(badge.box.top<node.box.top,"Leaf roles sit across the upper edge instead of occupying the title row");
        assert(node.box.top-badge.box.top<=6.25,"The compact tab projects no more than 6px above the card");
        assert(badge.box.left>=node.box.left&&badge.box.right<=node.box.right);
      }
      for(const [kind,box] of [["name",node.name],["state",node.state],["rates",node.rates]]) if(box) assert(!overlaps(badge.box,box),`${label}/${node.id}: badge cannot cover its ${kind}`);
    }
  }
}

async function audit(page, baseline, id, direction, name, overview=false, defaultLayout=true) {
  const model=packet.models[id],value=await metrics(page);
  checkMetrics(value,baseline,name);
  await assertInlinePorts(page,model.links,id,direction,overview);
  const findings=geometryFindings(await inlineSnapshot(page));
  const actualDepthOverlap=item=>item.kind==="cards-overlap"||/^(current|peer)-overlaps-neighbor-(card|badge)$/.test(item.kind);
  assert.deepEqual(defaultLayout?findings:findings.filter(item=>!actualDepthOverlap(item)),[],`${name}: badge/content geometry remains sound; only genuine rotated/dragged cross-node overlap is allowed`);
  await assertCardEdges(page);await assertMarkerGeometry(page);
  return value;
}

async function exposedBadge(page,id) {
  const node=page.locator(`[data-topology-node="${id}"]`);await node.scrollIntoViewIfNeeded();
  return node.evaluate(node=>{
    const badge=node.querySelector(".topology-node-selected:not([hidden]),.topology-node-peer:not([hidden])");
    const b=badge.getBoundingClientRect(),n=node.getBoundingClientRect();
    for(const fy of [.35,.55,.15])for(const fx of [.5,.25,.75]){const p={x:b.left+b.width*fx,y:b.top+Math.max(1,n.top-b.top)*fy};
      const hit=document.elementFromPoint(p.x,p.y);if(p.y<n.top&&hit?.closest("[data-topology-node]")===node)return p;}
    return null;
  });
}

async function interactions(page,context,engine,width,baseline) {
  await select(page,"vless:phone-all","forward");
  const point=await exposedBadge(page,media);assert(point,"A target's outside-the-card tab remains a real hit-testable part of the node");
  if(width<768)await page.touchscreen.tap(point.x,point.y);else await page.mouse.click(point.x,point.y);
  await page.waitForFunction(id=>document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode===id,media);await settle(page);
  assert.equal(await hook(page,"select").inputValue(),media,"Tapping a protruding tab selects its node rather than clearing inspection");
  if(width<768) {
    const start=await exposedBadge(page,media);assert(start);
    const before=await page.evaluate(()=>scrollY),xyz=await page.locator(`[data-topology-node="${media}"]`).evaluate(node=>[node.dataset.spaceX,node.dataset.spaceY,node.dataset.spaceZ]);
    if(engine==="chromium") {
      const channel=await context.newCDPSession(page);
      try{await channel.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{id:1,...start}]});
        for(let i=1;i<=6;i++)await channel.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{id:1,x:start.x,y:start.y-i*24}]});
        await channel.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      }finally{await channel.detach();}
      await page.waitForFunction(before=>scrollY>before+65,before);
      await page.evaluate(()=>new Promise(resolve=>{
        let y=scrollY,quietAt=performance.now();
        const check=()=>{const now=performance.now();if(Math.abs(scrollY-y)>.1){y=scrollY;quietAt=now;}if(now-quietAt>=180)resolve();else requestAnimationFrame(check);};
        requestAnimationFrame(check);
      }));
    } else {
      assert.equal(await hook(page,"graph").evaluate(graph=>getComputedStyle(graph).touchAction),"pan-y pinch-zoom");
      await page.evaluate(start=>{const target=document.elementFromPoint(start.x,start.y);for(const[type,dy]of[["pointerdown",0],["pointermove",-100],["pointercancel",-100]])
        target.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:774,pointerType:"touch",isPrimary:true,clientX:start.x,clientY:start.y+dy}));},start);
    }
    assert.equal(await hook(page,"select").inputValue(),media);
    assert.deepEqual(await page.locator(`[data-topology-node="${media}"]`).evaluate(node=>[node.dataset.spaceX,node.dataset.spaceY,node.dataset.spaceZ]),xyz,"Reading-mode scrolling from the tab cannot drag the node");
    await hook(page,"layout-edit").click();
  }
  const start=await exposedBadge(page,media);assert(start);
  const before=await page.locator(`[data-topology-node="${media}"]`).boundingBox();
  const dragFacts=()=>page.locator(`[data-topology-node="${media}"]`).evaluate(node=>{const graph=node.closest("[data-topology-graph]");return {node:{...node.dataset},graph:{...graph.dataset},scroll:scrollY};});
  const factsBefore=await dragFacts();
  // Move inward so this input test does not exercise the independent sphere's
  // outer-boundary clamp; the visible tab must track a free 1:1 displacement.
  const world={x:Number(factsBefore.node.worldX),y:Number(factsBefore.node.worldY)};
  const inward=Math.min(18/Math.max(Math.abs(world.x),1),13/Math.max(Math.abs(world.y),1));
  const delta={x:-world.x*inward,y:-world.y*inward};
  assert(Math.hypot(delta.x,delta.y)>6,"The free radial drag crosses the real drag threshold without crossing the sphere boundary");
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+delta.x,start.y+delta.y,{steps:5});await page.mouse.up();await settle(page);
  const after=await page.locator(`[data-topology-node="${media}"]`).boundingBox();
  const factsAfter=await dragFacts();
  if(Math.abs(after.x-before.x-delta.x)>=1.5||Math.abs(after.y-before.y-delta.y)>=1.5)report.dragFailure={engine,width,start,before,after,delta,factsBefore,factsAfter};
  assert(Math.abs(after.x-before.x-delta.x)<1.5&&Math.abs(after.y-before.y-delta.y)<1.5,`A native drag beginning on the outside tab moves the same leaf at 1:1 scale (actual ${after.x-before.x}, ${after.y-before.y}; expected ${JSON.stringify(delta)})`);
  assert.equal(await hook(page,"select").inputValue(),media);
  await audit(page,baseline,media,"forward","tab-drag",false,false);
  if(width<768)await hook(page,"layout-edit").click();
  await hook(page,"reset").click();await settle(page);
  await orbit(page,"right");await orbit(page,"up");await settle(page);
  await audit(page,baseline,media,"forward","rotated",false,false);
  return {click:"native",drag:"native mouse",scroll:width>=768?"not applicable":engine==="chromium"?"native CDP touch":"touch-action and dispatched pointer cancellation; not native scrolling"};
}

async function cornerSweep(page,baseline,width) {
  await select(page,"vless:phone-all","forward");await hook(page,"reset").click();await settle(page);
  const angles=width>=768?8:4,states=[],step=Math.abs(await measureOrbitStep(page));
  assert(step>0&&step<Math.PI/2,"The real keyboard yaw increment is finite and suitable for complete angular coverage");
  const circleSteps=Math.ceil(Math.PI*2/step);
  for(const pitch of ["up","down"]) {
    await page.locator('[data-topology-orbit="reset"]').click();
    await orbit(page,pitch,2);
    for(let index=0;index<angles;index++) {
      const increments=Math.round((index+1)*circleSteps/angles)-Math.round(index*circleSteps/angles);
      await orbit(page,"right",increments);
      await settle(page);
      await audit(page,baseline,"vless:phone-all","forward",`sweep-${pitch}-${index}`,false,false);
      states.push(await hook(page,"graph").evaluate(graph=>[Number(graph.dataset.cameraYaw),Number(graph.dataset.cameraPitch)]));
    }
  }
  assert.equal(states.length,angles*2);
  assert(circleSteps*step>=Math.PI*2&&circleSteps*step<Math.PI*2+step,"Each pitch sweeps a complete circle with at most one real keyboard step of overshoot");
  return states;
}

async function topBoundary(page,width,baseline,label,capture) {
  await hook(page,"reset").click();await settle(page);
  const id=await hook(page,"node").evaluateAll(nodes=>nodes.filter(node=>node.classList.contains("kind-awg"))
    .sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0].dataset.topologyNode);
  await select(page,id,"reverse");
  if(width<768)await hook(page,"layout-edit").click();
  const start=await exposedBadge(page,id);assert(start,"The top leaf's protruding current badge is natively draggable");
  const canvas=await hook(page,"graph").boundingBox(),node=page.locator(`[data-topology-node="${id}"]`),before=await node.boundingBox();
  assert(canvas.y>=0&&canvas.y+2<1000,"The real top-boundary drag ends inside the viewport, not at fabricated offscreen coordinates");
  const badgeOffset=start.x-(before.x+before.width/2);
  await page.mouse.move(start.x,start.y);await page.mouse.down();
  await page.mouse.move(canvas.x+canvas.width/2+badgeOffset,canvas.y+2,{steps:10});await page.mouse.up();await settle(page);
  assert.equal(await hook(page,"select").inputValue(),id,"A clamped top-edge drag retains the same selection");
  const bounds=await node.evaluate(node=>{const graph=node.closest("[data-topology-graph]");return {x:Number(node.dataset.worldX)/Number(graph.dataset.cameraRadiusX),
    y:Number(node.dataset.worldY)/Number(graph.dataset.cameraRadiusY),z:Number(node.dataset.cameraDepth)};});
  assert(bounds.y<-.8&&Math.abs(Math.hypot(bounds.x,bounds.y,bounds.z)-1)<.002,"The native drag reaches the existing upper spherical clamp");
  await audit(page,baseline,id,"reverse",label+"-top-boundary",false,false);
  if(capture){const file=label+"-top-boundary.png";await hook(page,"graph").screenshot({path:path.join(directory,file)});report.screenshots.push(file);}
  if(width<768)await hook(page,"layout-edit").click();
  return {id,...bounds};
}

async function run(browser,engine,width,theme) {
  const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:width<768?3:1,reducedMotion:"reduce",...(width<768?{isMobile:true,hasTouch:true}:{})});
  let page;
  const label=`${engine}-${width}-${theme}`;
  try {
    await context.addInitScript(theme=>localStorage.setItem("server-kit-theme",theme),theme);
    await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.origin!==base.origin){report.external.push(url.href);return route.abort();}
      if(isJSON(url))return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(packet.models[url.searchParams.get("node")]||packet.models[packet.initial_selected])});return route.continue();});
    page=await context.newPage();page.setDefaultTimeout(10000);page.on("pageerror",error=>report.errors.push(error.message));
    await page.goto(new URL("login/",base).href);await page.locator('[name="username"]').fill("preview");await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/",base).href),page.locator('button[type="submit"]').click()]);
    page.on("request",request=>report.requests.push({method:request.method(),url:request.url()}));
    await page.goto(new URL("network/topology/",base).href);await hook(page,"node").first().waitFor();await settle(page);
    await Promise.all([page.waitForResponse(response=>isJSON(new URL(response.url()))),hook(page,"refresh").click()]);
    await page.waitForFunction(()=>document.querySelectorAll("[data-topology-node]").length===12);await hook(page,"reset").click();await settle(page);
    const baseline=await audit(page,null,packet.initial_selected,"forward",label+"-overview",true);
    const states=[];
    for(const[id,direction,name]of[[media,"forward","current"],["vless:phone-all","forward","target"],["hub","reverse","source"]]) {
      await select(page,id,direction);await hook(page,"reset").click();await settle(page);
      const value=await audit(page,baseline,id,direction,label+"-"+name);states.push({name,nodes:value.nodes});
      if(name==="target"&&((engine==="chromium"&&width!==320)||(engine==="webkit"&&width===320))) {
        const filename=label+"-targets.png";await hook(page,"graph").screenshot({path:path.join(directory,filename),style:".skip-link:not(:focus){visibility:hidden!important}"});report.screenshots.push(filename);
      }
    }
    const input=await interactions(page,context,engine,width,baseline);
    const rotations=await cornerSweep(page,baseline,width);
    const boundary=await topBoundary(page,width,baseline,label,engine==="chromium"&&width===390);
    if(width===1440&&theme==="dark")await assertDepthOcclusion(page);
    report.cases.push({engine,width,theme,baseline:baseline.nodes,states,input,rotations,boundary});
    console.log(`Passed ${label}`);
  } catch(error) {
    if(page){const file=label+"-failure.png";await hook(page,"graph").screenshot({path:path.join(directory,file)}).then(()=>report.screenshots.push(file)).catch(()=>{});}
    throw error;
  } finally {await context.close();}
}

(async()=>{try {
  for(const[engine,factory]of[["chromium",chromium],["webkit",webkit]]){if(caseFilter&&!caseFilter.startsWith(engine+"-"))continue;const browser=await factory.launch();try{for(const width of[1440,390,320])for(const theme of["light","dark"])if(!caseFilter||caseFilter===`${engine}-${width}-${theme}`)await run(browser,engine,width,theme);}finally{await browser.close();}}
  assert.equal(report.cases.length,report.expectedCaseCount);assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);
  assert(report.requests.every(item=>item.method==="GET"&&!item.url.includes("/__preview__/")),"The suite neither writes nor changes a shared preview scenario");
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error.stack);}finally {
  fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,cases:report.cases.length,screenshots:report.screenshots.length,failure:report.failure},null,2));
}})();
