"use strict";

// Invoked by the main local-only suite, or directly through its smoke entry.
const assert = require("node:assert/strict");

async function selectionScenarios(harness, widths = [1440, 390]) {
  const {browser, label, session, hook, selectAndWait, selectionSettled, mode, direction,
    settleGraph, touchScrollStart, nativeSwipe, setLayoutEditing, assertReadOnly,
    jsonRoute, jsonResponse, topologyURL, report, screenshot} = harness;
  const geometry = page => hook(page, "graph").evaluate(graph => ({
    camera: [graph.dataset.cameraYaw, graph.dataset.cameraPitch, graph.dataset.viewportX, graph.dataset.viewportY, graph.dataset.viewportScale],
    nodes: [...graph.querySelectorAll("[data-topology-node]")].map(node => ({id:node.dataset.topologyNode,
      xyz:[node.dataset.spaceX,node.dataset.spaceY,node.dataset.spaceZ], xy:[node.dataset.worldX,node.dataset.worldY]})),
  }));
  const selection = page => hook(page, "root").evaluate(root => {
    const full = root.querySelector("[data-topology-full-details]");
    return {url:location.href, value:root.querySelector("[data-topology-select]").value,
      mode:root.dataset.topologyMode, direction:root.querySelector('[data-topology-direction][aria-pressed="true"]')?.dataset.topologyDirection,
      pressed:[...root.querySelectorAll('[data-topology-node][aria-pressed="true"]')].map(node => node.dataset.topologyNode),
      current:[...root.querySelectorAll('.topology-node-selected:not([hidden])')].map(node => node.closest("[data-topology-node]").dataset.topologyNode),
      peers:[...root.querySelectorAll('[data-topology-node].is-peer')].map(node => node.dataset.topologyNode),
      ports:[...root.querySelectorAll(".topology-node-port")].map(node => ({owner:node.closest("[data-topology-node]").dataset.topologyNode, text:node.textContent})),
      full:{hidden:full.hidden,open:full.open}, inspector:root.querySelector("[data-topology-inspector] h3")?.textContent || "",
      access:[...root.querySelectorAll("[data-topology-inspector] [data-topology-access-target]")].map(row => ({id:row.dataset.topologyAccessTarget,status:row.dataset.topologyAccessStatus})),
    };
  });
  async function supportingInformation(page, expanded = false) {
    const value = await hook(page, "root").evaluate(root => {
      const graph = root.querySelector("[data-topology-graph]"), full = root.querySelector("[data-topology-full-details]");
      const legend = root.querySelector(".topology-legend");
      const describe = node => ({classes:[...node.classList], hidden:node.hidden, ariaHidden:node.getAttribute("aria-hidden"),
        display:getComputedStyle(node).display, visibility:getComputedStyle(node).visibility,
        role:node.getAttribute("role"), live:node.getAttribute("aria-live"), text:node.textContent});
      return {
        helper:describe(root.querySelector("#topology-canvas-help")), summary:describe(root.querySelector("[data-topology-canvas-summary]")),
        describedBy:graph.getAttribute("aria-describedby").split(/\s+/),
        legendBeforeGraph:Boolean(legend.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING),
        visibleLegend:[...legend.children].filter(node => !node.classList.contains("sr-only")).map(node => node.textContent.trim()),
        peerLegendHidden:legend.querySelector(".topology-legend-peer").parentElement.classList.contains("sr-only"),
        notes:[...root.querySelectorAll("[data-topology-note], [data-topology-full-details] > .topology-detail-note")].map(node => ({
          text:node.textContent, inFull:node.closest("[data-topology-full-details]") === full,
          inReplacedDetails:Boolean(node.closest("[data-topology-details]")),
        })),
        ids:[...root.querySelectorAll("[id]")].map(node => node.id),
      };
    });
    for (const key of ["helper", "summary"]) {
      assert(value[key].classes.includes("sr-only"), `${key} remains available to assistive technology without visible footnote clutter`);
      assert.equal(value[key].hidden, false); assert.notEqual(value[key].ariaHidden, "true");
      assert.notEqual(value[key].display, "none"); assert.notEqual(value[key].visibility, "hidden");
    }
    assert(value.describedBy.includes("topology-canvas-help"));
    assert.equal(value.summary.role,"status"); assert.equal(value.summary.live,"polite");
    assert.equal(value.legendBeforeGraph,true); assert.deepEqual(value.visibleLegend,["节点 → VPS","VPS → 节点"]);
    assert.equal(value.peerLegendHidden,true,"the compact legend keeps the permission-frame explanation accessible");
    assert.equal(value.ids.length,new Set(value.ids).size,"moving explanatory markup cannot duplicate an ID");
    assert.equal(value.notes.length,2,"both permission and telemetry caveats survive dynamic detail replacement");
    assert(value.notes.every(note=>note.inFull && !note.inReplacedDetails),"caveats belong to full details outside the dynamically replaced relation list");
    const text=value.notes.map(note=>note.text).join("\n");
    for(const expression of [/权限视图不是连通性测试/,/单位 B\/s/,/1024 进位/,/含内外网流量/,/近期握手不代表实时连通/,/VLESS 未开启统计时不显示速率/,/箭头表示经 VPS 的访问方向/,/不代表 VPS 另有访问权限/,/叶子间不画箭头/]) assert.match(text,expression);
    if(expanded) {
      assert.equal(await hook(page,"note").isVisible(),true,"opening full details exposes the retained permission caveat");
      assert.match(await hook(page,"full-details").innerText(),/单位 B\/s/);
    }
  }
  async function cleared(page) {
    await settleGraph(page);
    const current = await selection(page), url = new URL(current.url);
    assert.equal(current.mode, "overview"); assert.equal(current.value, "");
    for (const key of ["pressed", "current", "peers", "ports", "access"]) assert.deepEqual(current[key], [], `canceling selection clears ${key}`);
    assert.deepEqual(current.full, {hidden:true,open:false});
    assert.equal(url.searchParams.has("node"), false); assert.equal(url.searchParams.has("format"), false);
    assert.equal(await hook(page, "graph").locator("[data-topology-edge], [data-topology-route], [data-topology-route-end], [data-topology-route-via], [data-topology-flow], [data-topology-spoke][marker-start], [data-topology-spoke][marker-end], .is-related").count(), 0,
      "overview contains only neutral structure, without retained permission segments or flow metadata");
    assert.equal(await hook(page, "direction").first().isVisible(), false);
    assert.equal(await hook(page, "root").getAttribute("aria-busy"), null);
    assert.equal(await hook(page, "refresh").isEnabled(), true);
    return current;
  }
  async function blankTap(page, mobile) {
    const point = await touchScrollStart(page, false);
    assert(await page.evaluate(point => {
      const hit = document.elementFromPoint(point.x,point.y), graph = document.querySelector("[data-topology-graph]");
      return hit && graph.contains(hit) && !hit.closest("[data-topology-node],button,a,input,select,summary");
    }, point), "blank taps use genuinely exposed canvas, not a node, control or overlay");
    if (mobile) await page.touchscreen.tap(point.x,point.y); else await page.mouse.click(point.x,point.y);
    await settleGraph(page);
  }
  async function preserve(page, action, message, keepGeometry = false) {
    const before = await selection(page), layout = keepGeometry ? await geometry(page) : null;
    await action(); await settleGraph(page);
    assert.deepEqual(await selection(page), before, message);
    if (keepGeometry) assert.deepEqual(await geometry(page), layout, `${message}: no scene movement`);
  }
  for (const width of widths) {
    const state = await session(browser,width,{reducedMotion:"reduce"}), {page,context,requests} = state;
    const mobile = width < 768;
    try {
      const model = await (await context.request.get(topologyURL+"?format=json")).json();
      const leaf = model.nodes.find(node => node.kind === "awg");
      await cleared(page);
      await supportingInformation(page);
      await selectAndWait(page,leaf.id); await direction(page,"forward");
      const full = hook(page,"full-details");
      await full.locator("summary").click(); assert.equal(await full.evaluate(node=>node.open),true);
      await supportingInformation(page,true);
      await page.evaluate(() => {
        const url = new URL(location.href); url.searchParams.set("qa_keep","selection"); url.searchParams.set("format","json"); url.hash="graph";
        history.replaceState(null,"",url.href);
      });
      const before = await geometry(page), count = requests.length;
      await blankTap(page,mobile); await cleared(page);
      assert.deepEqual(await geometry(page),before,"a short blank tap clears inspection without moving the camera or any node");
      assert.equal(requests.length,count,"canceling inspection is local and never fetches a substitute selection");
      assert.equal(new URL(page.url()).searchParams.get("qa_keep"),"selection"); assert.equal(new URL(page.url()).hash,"#graph");
      await blankTap(page,mobile); await cleared(page);
      assert.equal(requests.length,count,"repeated blank taps are idempotent");
      await mode(page,"relations"); await selectionSettled(page,leaf.id);
      assert.equal(requests.length,count,"the explicit relationships action can restore the last cached node");
      await blankTap(page,mobile); await cleared(page);
      await Promise.all([page.waitForResponse(jsonResponse),hook(page,"refresh").click()]);
      await page.waitForFunction(()=>!document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
      await cleared(page);
      // Age only the local freshness clock to trigger the real visibility/background
      // refresh path. No request, response, DOM or production action is bypassed.
      try {
        await Promise.all([page.waitForResponse(jsonResponse),page.evaluate(() => {
          const now = performance.now.bind(performance); window.__selectionClock=now; performance.now=()=>now()+60000;
          document.dispatchEvent(new Event("visibilitychange"));
        })]);
        await page.waitForFunction(()=>!document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
      } finally { await page.evaluate(()=>{ if(window.__selectionClock) {performance.now=window.__selectionClock;delete window.__selectionClock;} }); }
      await cleared(page);
      await supportingInformation(page);
      const hub = page.locator('[data-topology-node="hub"]');
      await (mobile ? hub.tap() : hub.click()); await selectionSettled(page,"hub");
      assert.equal(await page.locator('[data-topology-direction="reverse"]').getAttribute("aria-pressed"),"true","clicking the VPS initially exposes incoming access");
      assert.equal(await page.locator('[data-topology-direction="forward"]').innerText(),"VPS 可访问");
      assert.equal(await page.locator('[data-topology-direction="reverse"]').innerText(),"可访问 VPS");
      await direction(page,"forward");
      await supportingInformation(page);
      const facts = await (await context.request.get(topologyURL+"?format=json&node=hub")).json();
      const rows = await hook(page,"inspector").locator("[data-topology-access-target]").evaluateAll(items=>items.map(row=>({id:row.dataset.topologyAccessTarget,status:row.dataset.topologyAccessStatus,summary:row.querySelector(".topology-access-note")?.textContent})));
      const sort=items=>items.sort((a,b)=>a.id.localeCompare(b.id));
      assert.deepEqual(sort(rows),sort(facts.relations.map(item=>({id:item.node.id,status:item.forward.status,summary:item.forward.summary}))),"VPS outbound inspection retains all exact target statuses, including unknown and inapplicable");
      assert.equal(await hook(page,"edge").count(),facts.links.filter(link=>link.source==="hub").length,"displaying unknown VPS targets does not fabricate permission arrows");
      await preserve(page,()=>mobile?hub.tap():hub.click(),"clicking the currently inspected VPS preserves the explicit outbound direction");
      await blankTap(page,mobile); await cleared(page);
      await (mobile ? hub.tap() : hub.click()); await selectionSettled(page,"hub");
      assert.equal(await page.locator('[data-topology-direction="reverse"]').getAttribute("aria-pressed"),"true","reselecting VPS from overview starts with its useful inbound view");
      await selectAndWait(page,leaf.id);
      const blank = await touchScrollStart(page,false);
      await preserve(page,async()=>{await page.mouse.click(blank.x,blank.y,{button:"right"});await page.keyboard.press("Escape");},"right-clicking blank canvas cannot cancel selection",true);
      if (mobile) await setLayoutEditing(page,true);
      const rotation=async returning=>{
        const start=await touchScrollStart(page,false);
        if(!mobile){
          await page.mouse.move(start.x,start.y);await page.mouse.down();
          await page.mouse.move(start.x+25,start.y-14,{steps:5});
          if(returning)await page.mouse.move(start.x,start.y,{steps:4});
          await page.mouse.up();return;
        }
        const before=await geometry(page),channel=label==="chromium"?await context.newCDPSession(page):null;
        const send=async(type,dx)=>{
          if(channel)return channel.send("Input.dispatchTouchEvent",{type:type==="pointerdown"?"touchStart":type==="pointerup"?"touchEnd":"touchMove",
            touchPoints:type==="pointerup"?[]:[{id:1,x:start.x+dx,y:start.y}]});
          return page.evaluate(({start,type,dx})=>{
            const graph=document.querySelector("[data-topology-graph]"),target=type==="pointerdown"?document.elementFromPoint(start.x,start.y):graph;
            target.dispatchEvent(new PointerEvent(type,{pointerId:503,pointerType:"touch",isPrimary:true,button:0,bubbles:true,cancelable:true,clientX:start.x+dx,clientY:start.y}));
          },{start,type,dx});
        };
        try{
          await send("pointerdown",0);
          for(let step=1;step<=6;step++)await send("pointermove",step*8);
          await settleGraph(page);const peak=await geometry(page);
          assert.notEqual(peak.camera[0],before.camera[0],"A real dominant-horizontal touch exceeds the axis-lock threshold and rotates yaw");
          assert.equal(peak.camera[1],before.camera[1],"Horizontal touch never tilts pitch");
          if(returning)for(let step=5;step>=0;step--)await send("pointermove",step*8);
          await send("pointerup",returning?0:48);
        }finally{if(channel){await channel.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]}).catch(()=>{});await channel.detach();}}
      };
      await preserve(page,()=>rotation(false),"releasing a horizontal touch/desktop canvas orbit cannot masquerade as a blank tap");
      await preserve(page,()=>rotation(true),"an orbit that returns to its starting point is still a drag, not a short tap");
      if (mobile) await setLayoutEditing(page,false);
      await preserve(page,async()=>{
        const start=await touchScrollStart(page,false);
        await hook(page,"graph").evaluate(graph=>{
          graph.dataset.selectionCaptureLost="false";
          graph.addEventListener("pointerdown",event=>{graph.dataset.selectionPointer=String(event.pointerId);},{once:true,capture:true});
          graph.addEventListener("lostpointercapture",()=>{graph.dataset.selectionCaptureLost="true";},{once:true,capture:true});
        });
        await page.mouse.move(start.x,start.y);await page.mouse.down();
        // Native capture changes are pending until the next pointer dispatch.
        // Small moves realize got/lost capture while staying below the 6px drag threshold.
        await page.mouse.move(start.x+1,start.y);
        assert(await hook(page,"graph").evaluate(graph=>graph.hasPointerCapture(Number(graph.dataset.selectionPointer))),"native blank press captured its pointer");
        await hook(page,"graph").evaluate(graph=>graph.releasePointerCapture(Number(graph.dataset.selectionPointer)));
        await page.mouse.move(start.x+2,start.y);
        assert.equal(await hook(page,"graph").getAttribute("data-selection-capture-lost"),"true","the test observes real lostpointercapture before pointerup");
        await page.mouse.up();
      },"lost pointer capture followed by release must not clear selection",true);
      if (mobile) {
        for(const onNode of [false,true]) await preserve(page,async()=>{
          const start=await touchScrollStart(page,onNode);
          if(label==="chromium") {const y=await page.evaluate(()=>scrollY);await nativeSwipe(page,start);assert(await page.evaluate(()=>scrollY)>y+70,"native mobile swipe scrolls the document");}
          else await page.evaluate(start=>{
            const target=document.elementFromPoint(start.x,start.y);
            for(const [type,dy] of [["pointerdown",0],["pointermove",-120],["pointercancel",-120]])
              target.dispatchEvent(new PointerEvent(type,{pointerId:501,pointerType:"touch",isPrimary:true,bubbles:true,cancelable:true,clientX:start.x,clientY:start.y+dy}));
          },start);
        },"reading scroll/pointer cancellation preserves selection, URL and details",true);
      }
      for(const pointerType of ["mouse","touch"]) {
        if(mobile && pointerType==="touch")await setLayoutEditing(page,true);
        await preserve(page,async()=>{
          const point=await touchScrollStart(page,false);
          await page.evaluate(({point,pointerType})=>{
            const target=document.elementFromPoint(point.x,point.y);
            for(const type of ["pointerdown","pointercancel","pointerup"])
              target.dispatchEvent(new PointerEvent(type,{pointerId:502,pointerType,isPrimary:true,button:0,bubbles:true,cancelable:true,clientX:point.x,clientY:point.y}));
          },{point,pointerType});
        },`a canceled ${pointerType} tap cannot clear selection, including a stale pointerup after cancellation`,true);
        if(mobile && pointerType==="touch")await setLayoutEditing(page,false);
      }
      if(mobile) await preserve(page,async()=>{
        const point=await touchScrollStart(page,false);
        if(label==="chromium") {
          const channel=await context.newCDPSession(page);
          const one={id:1,x:point.x,y:point.y},two={id:2,x:point.x+25,y:point.y+10};
          try {await channel.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[one]});await channel.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[one,two]});
            for(let step=1;step<=4;step++)await channel.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{...one,x:one.x-step*3},{...two,x:two.x+step*3}]});
            await channel.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[one]});await channel.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});}
          finally {await channel.detach();}
        } else await page.evaluate(point=>{
          const graph=document.querySelector("[data-topology-graph]");
          for(const [type,id,dx] of [["pointerdown",510,0],["pointerdown",511,25],["pointermove",510,-12],["pointermove",511,37],["pointerup",511,37],["pointerup",510,-12]])
            graph.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:"touch",isPrimary:id===510,bubbles:true,cancelable:true,clientX:point.x+dx,clientY:point.y}));
        },point);
      },"both contacts of a two-finger gesture must finish without clearing or reselecting",true);
      await blankTap(page,mobile);await cleared(page);
      await selectAndWait(page,leaf.id);
      const leafButton=page.locator(`[data-topology-node="${leaf.id}"]`);await leafButton.focus();await page.keyboard.press("Enter");await selectionSettled(page,leaf.id);
      await screenshot(page,`${label}-${width}-selection-recovered`);
      await assertReadOnly(state);
      report.selectionInputCoverage ||= [];
      report.selectionInputCoverage.push({engine:label,width,mouseAndTap:"native",lostCapture:"native mouse capture lifecycle",
        orbit:mobile?label==="chromium"?"native CDP horizontal touch":"dispatched horizontal touch lifecycle":"native mouse",
        pointerCancellation:"dispatched pointer lifecycle, no fabricated compatibility click",touchScroll:mobile ? label==="chromium"?"native CDP touch":"dispatched pointer cancellation plus CSS contract":"not applicable",
        pinch:mobile ? label==="chromium"?"native CDP two-contact movement":"dispatched two-pointer lifecycle; not native browser zoom":"not applicable"});
      report.checks.push(`${label} ${width}: genuine blank tap clears selection/URL/details without changing layout; VPS click and both access views, cached restoration/background refresh, orbit/right-click/lost-capture/cancel/scroll/multi-touch guards, and immediate recovery`);
    } finally {await page.mouse.up().catch(()=>{});await context.close();}
  }
  for (const outcome of ["success","error","timeout","refresh","new-selection"]) {
    const state=await session(browser,390,{reducedMotion:"reduce"}),{page,context}=state;
    let release, arrived;const held=new Promise(resolve=>{release=resolve;}), reached=new Promise(resolve=>{arrived=resolve;});
    try {
      const original=await(await context.request.get(topologyURL+"?format=json")).json();
      const initial=original.nodes.find(node=>node.kind==="awg"),target=original.nodes.find(node=>node.id!=="hub"&&node.id!==initial.id);
      await selectAndWait(page,initial.id);
      const requested=outcome==="refresh"?initial.id:target.id;
      const response=await(await context.request.get(topologyURL+"?format=json&node="+encodeURIComponent(requested))).json();
      await page.route(jsonRoute,async route=>{
        if(new URL(route.request().url()).searchParams.get("node")!==requested)return route.continue();
        arrived();await held;
        try{await route.fulfill({status:outcome==="error"?503:200,contentType:"application/json",body:JSON.stringify(outcome==="error"?{error:"synthetic delayed failure"}:response)});}
        catch(error){if(!/closed|disposed|aborted|interception|already handled/i.test(error.message))throw error;}
      });
      if(outcome==="timeout")await page.evaluate(()=>{
        const timer=setTimeout.bind(window);window.setTimeout=(callback,delay,...args)=>timer(callback,delay===15000?1000:delay,...args);
      });
      if(outcome==="refresh")await hook(page,"refresh").click();else await hook(page,"select").selectOption(requested);
      let arrivalTimer;
      try {await Promise.race([reached,new Promise((_,reject)=>{arrivalTimer=setTimeout(()=>reject(new Error("uncached selection request was not intercepted")),10000);})]);}
      finally {clearTimeout(arrivalTimer);}
      const before=await geometry(page);await blankTap(page,true);const empty=await cleared(page);
      assert.deepEqual(await geometry(page),before,"canceling a pending request never resets spatial layout");
      let expected=empty;
      if(outcome==="new-selection"){await selectAndWait(page,"hub");expected=await selection(page);}
      if(outcome==="timeout")await page.waitForTimeout(1200);
      release();await page.waitForTimeout(180);await settleGraph(page);
      assert.deepEqual(await selection(page),expected,`late ${outcome} cannot undo blank-tap cancellation or a newer selection`);
      if(outcome!=="new-selection")await cleared(page);
      assert.notEqual(await hook(page,"status").getAttribute("data-state"),"error","a canceled request cannot surface a stale failure");
      await assertReadOnly(state);
      report.checks.push(`${label}: blank-tap cancellation wins against delayed ${outcome}, preserving URL/details/newer selection`);
    } finally {release?.();await context.close();}
  }
}

module.exports={selectionScenarios};
if(require.main===module){
  const {spawnSync}=require("node:child_process"),path=require("node:path");
  const args=process.argv.length>2?process.argv.slice(2):["http://127.0.0.1:8765/"];
  const result=spawnSync(process.execPath,[path.join(__dirname,"run_topology_ui.cjs"),...args,"--selection-smoke"],{stdio:"inherit",env:process.env});
  process.exitCode=result.status??1;
}
