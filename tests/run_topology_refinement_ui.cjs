"use strict";

// Focused synthetic visual review: no preview reset, external requests or writes.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {spawnSync} = require("node:child_process");
const {chromium, webkit} = require("playwright");
const {auditCosmos} = require("./topology_cosmos_assertions.cjs");
const {assertFixedControls, assertDepthOcclusion} = require("./topology_fixed_contract.cjs");
const {inlineSnapshot, geometryFindings, assertInlinePortContents, assertCardEdges, assertMarkerGeometry} = require("./topology_inline_assertions.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8877/");
assert(base.protocol==="http:"&&["127.0.0.1","localhost"].includes(base.hostname)&&Number(base.port)>=1024
  &&!base.username&&!base.password&&base.pathname==="/"&&!base.search&&!base.hash);
const fixture=spawnSync(process.env.TOPOLOGY_TEST_PYTHON||"python3",[path.join(__dirname,"test_topology_permissions_fixture.py"),"--json"],{encoding:"utf8"});
assert.equal(fixture.status,0,fixture.stderr);const packet=JSON.parse(fixture.stdout);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"moonsage-topology-refinement-"));
const report={directory,cases:[],screenshots:[],errors:[],external:[]};
const hook=(page,name)=>page.locator(`[data-topology-${name}]`);
const isJSON=url=>url.origin===base.origin&&url.pathname==="/network/topology/"&&url.searchParams.get("format")==="json";
const settle=async page=>{await page.waitForFunction(()=>!document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
const rgb=color=>color.match(/[\d.]+/g).slice(0,3).map(Number);
const palette={light:{inbound:[9,101,174],outbound:[180,83,9]},dark:{inbound:[85,213,245],outbound:[255,180,94]}};
console.log(`Topology refinement QA: ${directory}`);

async function chrome(page,theme){
  await assertFixedControls(page);
  const value=await page.evaluate(()=>{
    const graph=document.querySelector("[data-topology-graph]"),legend=document.querySelector(".topology-legend");
    const hidden=el=>{const css=getComputedStyle(el),box=el.getBoundingClientRect();return {text:el.textContent.trim(),width:box.width,height:box.height,
      position:css.position,clip:css.clip,clipPath:css.clipPath,display:css.display,visibility:css.visibility,
      ariaHidden:el.getAttribute("aria-hidden"),role:el.getAttribute("role"),live:el.getAttribute("aria-live"),hidden:el.hidden};};
    const moon=graph.querySelector('[data-topology-node="hub"]'),disc=moon.querySelector(".topology-moon-disc");
    const box=el=>{const b=el.getBBox();return {x:b.x,y:b.y,width:b.width,height:b.height};};
    return {helper:hidden(document.getElementById("topology-canvas-help")),summary:hidden(document.querySelector("[data-topology-canvas-summary]")),
      descriptions:graph.getAttribute("aria-describedby").split(/\s+/),legendCount:document.querySelectorAll(".topology-legend").length,
      legendAbove:legend.getBoundingClientRect().bottom<=graph.getBoundingClientRect().top,
      visibleLegend:[...legend.children].filter(el=>!el.classList.contains("sr-only")).map(el=>el.textContent.trim()),
      legendSemantic:[...legend.children].filter(el=>el.classList.contains("sr-only")).map(hidden),
      oldVisibleFootnotes:document.querySelectorAll(".topology-canvas-help, .topology-canvas-summary, .topology-graph-note, .topology-note").length,
      noteInside:!!document.querySelector("[data-topology-note]").closest("[data-topology-full-details]"),
      noteOutsideReplace:!document.querySelector("[data-topology-note]").closest("[data-topology-details]"),
      ids:[...document.querySelectorAll("[id]")].map(el=>el.id),
      flows:["inbound","outbound"].map(flow=>{const glyph=document.querySelector(`#topology-flow-arrow-${flow} path`),icon=document.querySelector(`.topology-legend-line.flow-${flow}`);return {flow,
        stroke:getComputedStyle(glyph).stroke,legend:getComputedStyle(icon).color,classes:[...glyph.classList]};}),
      moon:{rim:getComputedStyle(moon).borderTopColor,width:parseFloat(getComputedStyle(moon).borderTopWidth),
        shadow:getComputedStyle(moon).boxShadow,gradient:getComputedStyle(disc).backgroundImage,discBorder:parseFloat(getComputedStyle(disc).borderTopWidth),
        sharedRim:getComputedStyle(document.documentElement).getPropertyValue("--lunar-rim").trim()},
      waves:[...graph.querySelectorAll(".topology-waves path")].map(box),reflections:[...graph.querySelectorAll(".topology-moon-reflection path")].map(box)};
  });
  assert.equal(value.legendCount,1);assert(value.legendAbove,"Only one concise flow legend is placed before the canvas");
  assert.deepEqual(value.visibleLegend,["节点 → VPS","VPS → 节点"]);
  assert.equal(value.oldVisibleFootnotes,0,"Old bottom explanatory paragraphs no longer consume canvas/page space");
  assert.equal(new Set(value.ids).size,value.ids.length,"Moving accessibility helpers creates no duplicate IDs");
  assert(value.descriptions.includes("topology-canvas-help"));assert(value.noteInside&&value.noteOutsideReplace);
  for(const item of [value.helper,value.summary,...value.legendSemantic]){
    assert(item.width<=1&&item.height<=1&&item.position==="absolute","Screen-reader guidance consumes no visible layout space");
    assert(!item.hidden&&item.ariaHidden!=="true"&&item.display!=="none"&&item.visibility!=="hidden","Meaningful hints remain accessible, not display:none or aria-hidden");
    assert(item.clip!=="auto"||item.clipPath!=="none");
  }
  assert.match(value.helper.text,/Alt.*方向键/);assert.equal(value.summary.role,"status");assert.equal(value.summary.live,"polite");
  for(const flow of value.flows){assert.deepEqual(rgb(flow.stroke),palette[theme][flow.flow]);assert.equal(flow.stroke,flow.legend);assert(flow.classes.includes(`flow-${flow.flow}`));}
  assert(Math.hypot(...rgb(value.flows[0].stroke).map((n,i)=>n-rgb(value.flows[1].stroke)[i]))>=100,"Input/output colors retain strong separation");
  assert.doesNotMatch(value.moon.shadow,/0px 0px 0px [24]px/);assert.equal(value.moon.discBorder,0,"A second border is not painted inside the lunar node");
  assert(value.moon.gradient.startsWith("radial-gradient("));
  if(theme==="light"){assert.equal(value.moon.sharedRim,"#476e89");assert.deepEqual(rgb(value.moon.rim),[71,110,137]);}
  assert.equal(value.waves.length,5);assert.equal(value.reflections.length,10);
  assert(value.waves.every(w=>w.width>=40&&w.width<=200),"Sea ripples stay short, never full-width stripes");
  assert(new Set(value.waves.map(w=>Math.round(w.x))).size>=4,"Ripple positions are not centered on a repeated rail");
  const rows=value.waves.map(w=>w.y).sort((a,b)=>a-b),gaps=rows.slice(1).map((y,i)=>y-rows[i]);
  assert(Math.max(...gaps)>Math.min(...gaps)*1.5,"Sparse ripple rows have intentionally uneven spacing");
  assert(value.reflections.every(w=>w.width<=100)&&new Set(value.reflections.map(w=>Math.round(w.width))).size>=7,"Moonlight consists of varied short glints");
  return value;
}
async function selected(page,id,direction){await hook(page,"select").selectOption(id);await page.waitForFunction(id=>document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode===id,id);await page.locator(`[data-topology-direction="${direction}"]`).click();await settle(page);}
async function routes(page,model,direction){
  const links=model.links.filter(link=>direction==="forward"?link.source===model.selected_id:link.target===model.selected_id);
  const peers=new Set(links.map(link=>direction==="forward"?link.target:link.source));
  const direct=new Set(links.filter(link=>link.source==="hub"||link.target==="hub").map(link=>link.source==="hub"?link.target:link.source));
  const actual=await hook(page,"graph").evaluate(graph=>({
    peers:[...graph.querySelectorAll("[data-topology-node].is-peer")].map(el=>el.dataset.topologyNode).sort(),
    lines:[...graph.querySelectorAll("[data-topology-edge], [data-topology-spoke]")].map(el=>({edge:el.hasAttribute("data-topology-edge"),source:el.dataset.source,target:el.dataset.target,flow:el.dataset.topologyFlow||null,
      start:el.getAttribute("marker-start"),end:el.getAttribute("marker-end"),via:el.dataset.topologyRouteVia||null,terminal:el.dataset.topologyRouteEnd||null,
      color:getComputedStyle(el).stroke,width:parseFloat(getComputedStyle(el).strokeWidth),opacity:Number(getComputedStyle(el).opacity),
      arrows:["start","end"].flatMap(end=>{const id=el.getAttribute(`marker-${end}`)?.match(/#([^)]*)\)/)?.[1];return id?[{id,color:getComputedStyle(document.getElementById(id).querySelector("path")).stroke}]:[];})}))}));
  assert.deepEqual(actual.peers,[...peers].sort());
  assert.deepEqual(actual.lines.filter(x=>x.edge).map(x=>`${x.source}>${x.target}`).sort(),links.filter(x=>x.source==="hub"||x.target==="hub").map(x=>`${x.source}>${x.target}`).sort());
  for(const line of actual.lines){
    if(line.edge){assert.equal(line.flow,line.source==="hub"?"outbound":"inbound");assert.equal(line.start,null);assert.equal(line.via,null);}
    else{
      const role=peers.has(line.source)?"peer":links.length&&line.source===model.selected_id?"selected":null;
      const flow=role?((direction==="forward"?role==="selected":role==="peer")?"inbound":"outbound"):null;
      assert.equal(line.target,"hub");assert.equal(line.flow,flow);
      assert.equal(line.start,!direct.has(line.source)&&flow==="outbound"?"url(#topology-flow-arrow-outbound)":null);
      assert.equal(line.end,!direct.has(line.source)&&flow==="inbound"?"url(#topology-flow-arrow-inbound)":null);
      assert.equal(line.via,!direct.has(line.source)&&flow==="inbound"?"hub":null);
      if(direct.has(line.source))assert.equal(line.opacity,0,"Real hub access replaces its structural spoke");
    }
    if(line.flow){assert.equal(line.width,2.4);for(const arrow of line.arrows){assert.equal(arrow.id,`topology-flow-arrow-${line.flow}`);assert.equal(arrow.color,line.color);}}
  }
  const inline=await inlineSnapshot(page);assertInlinePortContents(inline,model.links,model.selected_id,direction);
  assert.deepEqual(geometryFindings(inline),[],"Full port information fits without overlapping the default node layout");
  await assertCardEdges(page,true);await assertMarkerGeometry(page,true,true);
  return actual;
}
async function capture(page,label,selector=".topology-panel"){
  await page.evaluate(()=>document.activeElement?.blur());
  await page.locator(selector).screenshot({path:path.join(directory,label+".png"),style:".skip-link:not(:focus){visibility:hidden!important}"});report.screenshots.push(label+".png");
}
async function run(browser,engine,width,theme){
  const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:width===390?3:1,reducedMotion:"reduce",...(width<768?{isMobile:true,hasTouch:true}:{})});
  try{
    await context.addInitScript(theme=>localStorage.setItem("server-kit-theme",theme),theme);
    await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.origin!==base.origin){report.external.push(url.href);return route.abort();}
      if(isJSON(url))return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(packet.models[url.searchParams.get("node")]||packet.models[packet.initial_selected])});return route.continue();});
    const page=await context.newPage();page.setDefaultTimeout(10000);page.on("pageerror",error=>report.errors.push(error.message));
    await page.goto(new URL("login/",base).href);await page.locator('[name="username"]').fill("preview");await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/",base).href),page.locator('button[type="submit"]').click()]);
    await page.goto(new URL("network/topology/",base).href);await hook(page,"node").first().waitFor();await settle(page);
    const methods=[];page.on("request",request=>methods.push(request.method()));
    const initial=await page.locator("#topology-data").evaluate(el=>JSON.parse(el.textContent));const label=`${engine}-${width}-${theme}`;
    await capture(page,label+"-overview");const structure=await chrome(page,theme);
    const overview=await auditCosmos(page,initial.nodes.map(node=>node.id),true,{normalMoonRim:theme==="light"});assert.deepEqual(geometryFindings(await inlineSnapshot(page)),[]);
    await Promise.all([page.waitForResponse(response=>isJSON(new URL(response.url()))),hook(page,"refresh").click()]);
    await page.waitForFunction(()=>document.querySelectorAll("[data-topology-node]").length===12);await hook(page,"reset").click();await settle(page);
    const audits=[];
    for(const [id,direction,name]of[["vless:phone-all","forward","outgoing"],["awg:nas-primary","reverse","incoming"]]){
      await selected(page,id,direction);await hook(page,"reset").click();await settle(page);
      const model=packet.models[id],actual=await routes(page,model,direction);
      await capture(page,label+"-"+name);const cosmos=await auditCosmos(page,model.nodes.map(node=>node.id));
      const full=hook(page,"full-details");await full.locator("summary").click();
      const caveats=await full.textContent();for(const expected of["B/s","1024","VLESS 未开启统计","不代表 VPS 另有访问权限"])assert(caveats.includes(expected),"Collapsed details retain the essential caveat: "+expected);
      assert(await hook(page,"note").isVisible(),"Moved factual warning remains readable after runtime details rerender");await full.locator("summary").click();
      audits.push({name,contrast:cosmos.contrast,occludedSamples:cosmos.occludedSamples,routeCount:actual.lines.filter(x=>x.flow).length});
    }
    await selected(page,"hub","reverse");await routes(page,packet.models.hub,"reverse");const hub=await auditCosmos(page,packet.models.hub.nodes.map(node=>node.id));
    if(width===1440)await capture(page,label+"-moon",'[data-topology-node="hub"]');
    if(width===1440&&theme==="dark")await assertDepthOcclusion(page);
    assert(methods.every(method=>method==="GET"));
    report.cases.push({engine,width,theme,structure,overview:overview.contrast,audits,hub:hub.contrast});
  }finally{await context.close();}
}
(async()=>{try{for(const[engine,factory]of[["chromium",chromium],["webkit",webkit]]){const browser=await factory.launch();try{for(const width of[1440,390])for(const theme of["light","dark"])await run(browser,engine,width,theme);}finally{await browser.close();}}
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);assert.equal(report.cases.length,8);
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error.stack);}finally{fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,cases:report.cases.length,screenshots:report.screenshots.length,failure:report.failure},null,2));}})();
