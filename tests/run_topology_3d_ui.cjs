"use strict";

// Synthetic, read-only browser regression. No production hosts or credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync} = require("node:child_process");
const {chromium, webkit} = require("playwright");
const {assertFixedCenter, assertFixedControls, fixedView} = require("./topology_fixed_contract.cjs");
const {orbit} = require("./topology_gestures.cjs");
const {inlineSnapshot, geometryFindings, assertCompactCards, assertInlinePortContents, assertCardEdges, assertMarkerGeometry} = require("./topology_inline_assertions.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8880/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password
  && base.pathname === "/" && !base.search && !base.hash, "Use an isolated loopback preview.");
const projected = spawnSync(process.env.TOPOLOGY_TEST_PYTHON || "python3", [path.join(__dirname, "test_topology_permissions_fixture.py"), "--json"], {encoding: "utf8", maxBuffer: 4 * 1024 * 1024});
assert.equal(projected.status, 0, projected.stderr);
const packet = JSON.parse(projected.stdout);
assert.equal(packet.generated_by, "dashboard.topology.build_topology");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-topology-3d-"));
const report = {directory, checks: [], screenshots: [], routeArrows: [], performance: [], errors: [], external: []};
const hook = (page, name) => page.locator(`[data-topology-${name}]`);
const jsonURL = url => url.origin === base.origin && url.pathname === "/network/topology/" && url.searchParams.get("format") === "json";
const space = state => state.nodes.map(({id, xyz}) => ({id, xyz}));
const positions = state => state.nodes.map(({id, xy, depth}) => ({id, xy, depth}));
const camera = state => ({yaw: state.yaw, pitch: state.pitch});
const close = (actual, expected, message, tolerance = .02) => assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
console.log(`3D topology QA: ${directory}`);

async function settle(page) {
  await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function state(page) {
  const snapshot = await hook(page, "graph").evaluate(graph => {
    const style = getComputedStyle(graph), world = getComputedStyle(graph.querySelector("[data-topology-world]"));
    return {projection: graph.dataset.projection, yaw: Number(graph.dataset.cameraYaw), pitch: Number(graph.dataset.cameraPitch),
      radii: [Number(graph.dataset.cameraRadiusX), Number(graph.dataset.cameraRadiusY)],
      view: {x: Number(graph.dataset.viewportX), y: Number(graph.dataset.viewportY), scale: Number(graph.dataset.viewportScale)},
      touchAction: style.touchAction, dragging: graph.dataset.dragging === "true", editing: graph.dataset.layoutEditing === "true",
      world: {transform: world.transform, willChange: world.willChange, filter: world.filter, perspective: world.perspective},
      nodes: [...graph.querySelectorAll("[data-topology-node]")].map(node => {
        const css = getComputedStyle(node), box = node.getBoundingClientRect();
        return {id: node.dataset.topologyNode, xyz: ["spaceX", "spaceY", "spaceZ"].map(key => Number(node.dataset[key])),
          xy: [Number(node.dataset.worldX), Number(node.dataset.worldY)], depth: Number(node.dataset.cameraDepth),
          rank: Number(css.getPropertyValue("--topology-depth-index")), z: Number(css.zIndex), peer: node.classList.contains("is-peer"),
          selected: node.getAttribute("aria-pressed") === "true", width: node.offsetWidth, height: node.offsetHeight,
          screenWidth: box.width, screenHeight: box.height, font: getComputedStyle(node.querySelector("strong")).fontSize,
          transform: css.transform, filter: css.filter, perspective: css.perspective, willChange: css.willChange};
      })};
  });
  await assertFixedCenter(page);
  return snapshot;
}
function rigidProjection(snapshot) {
  assert.equal(snapshot.projection, "3d");
  assert(Number.isFinite(snapshot.yaw) && Number.isFinite(snapshot.pitch));
  assert(snapshot.radii.every(radius => Number.isFinite(radius) && radius > 0), "The spatial projection exposes its responsive nonzero radii");
  assert(snapshot.nodes.every(node => [...node.xyz, ...node.xy, node.depth].every(Number.isFinite)), "Every node exposes finite actual 3D and projected coordinates");
  assert(new Set(snapshot.nodes.map(node => node.xyz[2])).size > 1, "The graph has genuine spatial depth, not a flat scene with a decorative tilt");
  assert.deepEqual(snapshot.nodes.map(node => node.rank).sort((a, b) => a - b), Array.from({length: snapshot.nodes.length}, (_, i) => i + 1), "Every node has one unique depth rank");
  for (let index = 0; index < snapshot.nodes.length; index++) for (const other of snapshot.nodes.slice(index + 1)) {
    const node = snapshot.nodes[index];
    const spatial = Math.hypot(...node.xyz.map((value, axis) => value - other.xyz[axis]));
    const projectedDistance = Math.hypot((node.xy[0] - other.xy[0]) / snapshot.radii[0],
      (node.xy[1] - other.xy[1]) / snapshot.radii[1], node.depth - other.depth);
    close(projectedDistance, spatial, "After undoing explicit responsive radii, the orthographic camera is a rigid rotation", .00001);
  }
}
function crispProjection(snapshot) {
  assert.equal(snapshot.world.willChange, "auto");
  assert.equal(snapshot.world.filter, "none");
  assert.equal(snapshot.world.perspective, "none");
  assert(!snapshot.world.transform.startsWith("matrix3d"), "3D coordinates project to crisp 2D DOM, not a rasterized CSS 3D plane");
  for (const node of snapshot.nodes) {
    assert(!node.transform.startsWith("matrix3d"));
    assert.equal(node.filter, "none"); assert.equal(node.perspective, "none"); assert.equal(node.willChange, "auto");
    close(node.screenWidth, node.width * snapshot.view.scale, "Card width follows whole-graph scale", .1);
    close(node.screenHeight, node.height * snapshot.view.scale, "Card height follows whole-graph scale", .1);
  }
}
async function capture(page, label) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator(".topology-panel").screenshot({path: path.join(directory, `${label}.png`), style: ".skip-link:not(:focus) { visibility:hidden !important; }"});
  report.screenshots.push(`${label}.png`);
}
async function controls(page) {
  await assertFixedControls(page);
  const values = await page.locator("[data-topology-reset], [data-topology-orbit]").evaluateAll(elements => elements.map(el => ({
    reset: el.hasAttribute("data-topology-reset"), orbit: el.dataset.topologyOrbit || null,
    visible: !!el.getClientRects().length, height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width,
    label: el.getAttribute("aria-label") || el.textContent.trim()})));
  assert.equal(values.filter(item => item.reset).length, 1);
  assert.deepEqual(values.filter(item => item.orbit).map(item => item.orbit), ["reset"], "Only view reset remains; direction buttons are actually removed");
  for (const value of values) assert(value.visible && value.height >= 44 && value.width >= 44 && value.label, "Every arrange/orbit action is labelled, visible and touch-sized");
  assert.equal(await hook(page,"rotate-pad").count(),0,"Horizontal touch rotation needs no separate pad");
  const coarse=await page.evaluate(()=>matchMedia("(pointer: coarse)").matches);
  const edit=hook(page,"layout-edit");
  assert.equal(await edit.isVisible(),coarse,"Node editing is shown for touch input, not on a mouse-only desktop");
  if(coarse) {
    const value=await edit.evaluate(el=>{const box=el.getBoundingClientRect();return {tag:el.tagName,width:box.width,height:box.height,label:el.getAttribute("aria-label")||el.textContent.trim()};});
    assert.equal(value.tag,"BUTTON");assert(value.width>=44&&value.height>=44&&value.label,"The remaining touch control stays labelled and finger-sized");
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "The new controls never overflow the mobile page");
}
async function rejectedZoomInputs(page) {
  const before = await state(page);
  for (const ctrl of [false, true]) for (const delta of [-280, 280]) {
    await hook(page, "graph").evaluate((graph, {ctrl, delta}) => {
      const box = graph.getBoundingClientRect();
      graph.dispatchEvent(new WheelEvent("wheel", {bubbles: true, cancelable: true, clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2, deltaY: delta, ctrlKey: ctrl}));
    }, {ctrl, delta});
    await settle(page); await assertFixedCenter(page);
  }
  await hook(page, "graph").focus();
  for (const key of ["+", "-", "=", "0"]) { await page.keyboard.press(key); await settle(page); await assertFixedCenter(page); }
  const after = await state(page);
  assert.deepEqual(after.view, before.view); assert.deepEqual(camera(after), camera(before)); assert.deepEqual(space(after), space(before));
  crispProjection(after);
}
async function fixedOriginInteractions(page) {
  const card = await point(page, true), leaf = page.locator(`[data-topology-node="${card.id}"]`), before = await state(page);
  await leaf.focus(); await page.keyboard.press("Alt+ArrowRight"); await settle(page);
  const moved = await state(page);
  assert.notDeepEqual(space(moved), space(before), "Alt-arrow still moves a focused leaf in real 3D");
  assert.deepEqual(space(moved).filter(node => node.id !== card.id), space(before).filter(node => node.id !== card.id));
  const hub = page.locator('[data-topology-node="hub"]');
  await hub.focus(); const hubBefore = await state(page);
  await page.keyboard.press("Alt+ArrowRight"); await settle(page);
  assert.deepEqual(space(await state(page)), space(hubBefore), "Alt-arrow cannot move the central VPS");
  const center = await hub.evaluate(el => { const box = el.getBoundingClientRect(); return {x: box.left + box.width / 2 + 40, y: box.top + box.height / 2 + 30}; });
  await pointerNode(page, "hub", center); await settle(page);
  assert.deepEqual(space(await state(page)), space(hubBefore), "Pointer dragging cannot move the central VPS");
  await hook(page, "graph").focus(); const beforeKeys = await state(page);
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowUp"); await settle(page);
  const afterKeys = await state(page); assert.notDeepEqual(camera(afterKeys), camera(beforeKeys), "Canvas arrow keys rotate the spatial camera");
  assert.deepEqual(afterKeys.view, beforeKeys.view); assert.deepEqual(space(afterKeys), space(beforeKeys));
  const details = hook(page, "view-options"); await details.locator("summary").click();
  const beforeSearch = await state(page); await hook(page, "search").fill("no-such-synthetic-node"); await settle(page);
  assert.deepEqual(camera(await state(page)), camera(beforeSearch)); assert.deepEqual((await state(page)).view, beforeSearch.view);
  await hook(page, "search").fill(await leaf.locator("strong").textContent()); await settle(page);
  assert.deepEqual((await state(page)).view, beforeSearch.view, "Finding a real leaf highlights it without panning the fixed center");
  assert.deepEqual(camera(await state(page)), camera(beforeSearch));
  await hook(page, "search").fill(""); await details.locator("summary").click();
  const viewport = page.viewportSize(), original = await state(page);
  await page.setViewportSize({width: viewport.width === 1440 ? 590 : viewport.width + 24, height: viewport.height}); await settle(page);
  assert.deepEqual(camera(await state(page)), camera(original), "Responsive reflow preserves the chosen viewing angle");
  await assertFixedCenter(page);
  await page.setViewportSize(viewport); await settle(page); await assertFixedCenter(page);
}
async function point(page, onNode = false) {
  await hook(page, "graph").evaluate(graph => scrollTo(0, graph.getBoundingClientRect().top + scrollY - 130));
  if (onNode) await page.locator('[data-topology-node]:not(.is-hub)').first().scrollIntoViewIfNeeded();
  await settle(page);
  const result = await hook(page, "graph").evaluate((graph, onNode) => {
    const box = graph.getBoundingClientRect(), top = Math.max(box.top + 35, 180), bottom = Math.min(box.bottom - 65, innerHeight - 180);
    if (onNode) for (const node of graph.querySelectorAll('[data-topology-node]:not(.is-hub)')) {
      const rect = node.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (x > box.left + 25 && x < box.right - 45 && y > top && y < bottom
        && document.elementFromPoint(x, y)?.closest("[data-topology-node]") === node) return {x, y, id: node.dataset.topologyNode};
    }
    if (!onNode) for (let y = top; y <= bottom; y += 24) for (let x = box.left + 32; x < box.right - 65; x += 24) {
      const element = document.elementFromPoint(x, y);
      if (element && graph.contains(element) && !element.closest("[data-topology-node]")) return {x, y};
    }
    return null;
  }, onNode);
  assert(result, "The real viewport provides an unobscured gesture target");
  return result;
}
async function drag(page, start, dx, dy, shift = false) {
  if (shift) await page.keyboard.down("Shift");
  try { await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + dx, start.y + dy, {steps: 8}); await page.mouse.up(); }
  finally { if (shift) await page.keyboard.up("Shift"); }
  await settle(page);
}
async function touchYaw(page,engine,start) {
  const before=await state(page),selected=await hook(page,"select").inputValue();
  const channel=engine==="chromium"?await page.context().newCDPSession(page):null;
  const send=async(type,dx)=>{
    if(channel)return channel.send("Input.dispatchTouchEvent",{type:type==="pointerdown"?"touchStart":type==="pointerup"?"touchEnd":"touchMove",
      touchPoints:type==="pointerup"?[]:[{id:1,x:start.x+dx,y:start.y}]});
    return page.evaluate(({start,type,dx})=>{
      const graph=document.querySelector("[data-topology-graph]"),target=type==="pointerdown"?document.elementFromPoint(start.x,start.y):graph;
      target.dispatchEvent(new PointerEvent(type,{pointerId:803,pointerType:"touch",isPrimary:true,bubbles:true,cancelable:true,clientX:start.x+dx,clientY:start.y}));
    },{start,type,dx});
  };
  try{await send("pointerdown",0);for(let step=1;step<=8;step++)await send("pointermove",step*6);await send("pointerup",48);}
  finally{if(channel){await channel.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]}).catch(()=>{});await channel.detach();}}
  await settle(page);const after=await state(page);
  assert.notEqual(after.yaw,before.yaw,"Dominant horizontal touch on the graph rotates yaw");
  assert.equal(after.pitch,before.pitch,"Touch rotation never changes pitch");
  assert.deepEqual(space(after),space(before));assert.deepEqual(after.view,before.view);
  assert.equal(await hook(page,"select").inputValue(),selected,"A horizontal swipe is not a node tap or blank deselection");
}
async function select(page, id) {
  await hook(page, "select").selectOption(id);
  await page.waitForFunction(id => document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode === id, id);
  await settle(page);
}
async function permissions(page, model, direction) {
  const links = model.links.filter(link => direction === "forward" ? link.source === model.selected_id : link.target === model.selected_id);
  const peers = links.map(link => direction === "forward" ? link.target : link.source).sort();
  const current = await state(page);
  assert.deepEqual(current.nodes.filter(node => node.peer).map(node => node.id).sort(), peers, "3D preserves the exact backend-authorized counterpart set");
  for (const node of current.nodes) {
    assert.equal(node.z, 20 + node.rank, "Permission styling never overrides actual camera depth");
    for (const other of current.nodes) if (node.depth > other.depth + .000001)
      assert(node.z > other.z, "Near leaves can occlude the VPS; distant selected targets cannot jump forward");
  }
  const edges = await hook(page, "edge").evaluateAll(items => items.map(el => ({source: el.dataset.source, target: el.dataset.target,
    arrow: el.getAttribute("marker-end"), start: el.getAttribute("marker-start"), via: el.dataset.topologyRouteVia || null,flow:el.dataset.topologyFlow || null})));
  assert.deepEqual(edges.map(edge => `${edge.source}>${edge.target}`).sort(), links.filter(link => link.source === "hub" || link.target === "hub").map(link => `${link.source}>${link.target}`).sort(), "Leaf-to-leaf permission paths are absent, not merely hidden");
  assert(edges.every(edge => edge.arrow && !edge.start && !edge.via), "Actual hub permission edges remain singly directed, without relay metadata");
  for(const edge of edges){ assert.equal(edge.flow,edge.source === "hub" ? "outbound" : "inbound");assert.equal(edge.arrow,`url(#topology-flow-arrow-${edge.flow})`); }
  const directIds = new Set(links.filter(link => link.source === "hub" || link.target === "hub").map(link => link.source === "hub" ? link.target : link.source));
  const spokes = await hook(page, "spoke").evaluateAll(items => items.map(el => ({source: el.dataset.source, target: el.dataset.target,
    arrow: el.getAttribute("marker-start"), ingress: el.getAttribute("marker-end"), end: el.dataset.topologyRouteEnd || null, via: el.dataset.topologyRouteVia || null,flow:el.dataset.topologyFlow || null,
    visibility: getComputedStyle(el).visibility, opacity: Number(getComputedStyle(el).opacity)})));
  assert.equal(spokes.length, model.nodes.length - 1); assert(spokes.every(edge => edge.target === "hub"));
  assert.deepEqual(spokes.map(spoke => spoke.source).sort(), model.nodes.filter(node => node.id !== "hub").map(node => node.id).sort(), "All leaves retain exactly one structural spoke, never duplicate permission routes");
  for (const spoke of spokes) {
    const peer = peers.includes(spoke.source), selected = links.length > 0 && spoke.source === model.selected_id;
    const terminal = !directIds.has(spoke.source) && (direction === "forward" ? peer : selected);
    const flow = peer || selected ? ((direction === "forward" && selected) || (direction === "reverse" && peer) ? "inbound" : "outbound") : null;
    const ingress = !directIds.has(spoke.source) && flow === "inbound";
    assert.equal(Boolean(spoke.arrow), terminal, "The complete destination arrow set survives rotation, dragging and direction changes");
    assert.equal(Boolean(spoke.ingress), ingress, "Every confirmed source enters the VPS in either viewing direction; other spokes never gain ingress arrows");
    assert.equal(spoke.end, terminal ? spoke.source : null, "Terminal metadata identifies only actual destination leaves and clears from origins");
    assert.equal(spoke.via, ingress ? "hub" : null, "Transit metadata is exact and disappears after changing direction, selection or permissions");
    assert(!(spoke.arrow && spoke.ingress), "A reverse source and current destination never gain opposing spoke arrows");
    assert.equal(spoke.flow,flow,"Actual 3D route direction stays independent of the leaf type");
    if (spoke.arrow || spoke.ingress) assert.equal(spoke.arrow || spoke.ingress, `url(#topology-flow-arrow-${flow})`, "Both 3D route legs use their actual input/output direction color");
    if (directIds.has(spoke.source)) assert.equal(spoke.opacity, 0, "A real hub permission edge replaces, not duplicates, the structural route");
  }
  report.routeArrows.push({width: page.viewportSize().width, theme: await page.locator("html").getAttribute("data-theme"),
    selected: model.selected_id, direction, permissionEdges: edges, spokes});
  const inline = await inlineSnapshot(page);
  assertCompactCards({...inline, nodes: inline.nodes.filter(node => node.id !== "hub")});
  assertInlinePortContents(inline, model.links, model.selected_id, direction);
  const hub = inline.nodes.find(node => node.id === "hub");
  assert(hub.localBox.height >= (page.viewportSize().width <= 600 ? 124 : 148), "The 3D moon remains spacious enough for the disc and inline permissions");
  await assertCardEdges(page, true); await assertMarkerGeometry(page, false, true);
}
function denseModel(selectedId) {
  const original = packet.models.hub, template = original.nodes.find(node => node.kind === "awg" && node.availability === "enabled");
  const nodes = [original.nodes.find(node => node.id === "hub"), ...Array.from({length: 40}, (_, i) => ({...template,
    id: `awg:synthetic-${i}`, name: `synthetic-${String(i).padStart(2, "0")}`, address: `192.0.2.${i + 10}`, protected: false}))];
  const selected = nodes.find(node => node.id === selectedId) || nodes[0];
  const links = nodes.slice(1).flatMap(source => nodes.filter(target => target.id !== source.id).map(target => ({source: source.id, target: target.id, status: "partial", label: "TCP · 22, 443", scopes: ["TCP · 22, 443"]})));
  const allowed = {status: "partial", label: "指定范围", summary: "TCP · 22, 443", scopes: ["TCP · 22, 443"], warnings: []};
  const unknown = {status: "unknown", label: "未检测", summary: "VPS 发起的访问未检测", scopes: [], warnings: []};
  return {...original, nodes, selected, selected_id: selected.id, links,
    relations: nodes.filter(node => node.id !== selected.id).map(node => ({node, forward: selected.id === "hub" ? unknown : allowed,
      reverse: node.id === "hub" ? unknown : allowed, relation: selected.id === "hub" ? "inbound" : node.id === "hub" ? "outbound" : "mutual", label: "配置授权"})),
    summary: {nodes: 40, awg: 40, vless: 0, enabled: 40, disabled: 0, pending: 0}};
}
async function resetLayout(page) {
  await hook(page, "reset").click();
  await settle(page); await assertFixedCenter(page);
}
async function nativeSwipe(page, start) {
  const channel = await page.context().newCDPSession(page);
  try {
    await channel.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{id: 1, x: start.x, y: start.y}]});
    for (let i = 1; i <= 10; i++) {
      await channel.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{id: 1, x: start.x, y: start.y - 170 * i / 10}]});
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(140);
    await channel.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
  } finally { await channel.detach(); }
  await page.waitForTimeout(180); await settle(page);
}
async function mobile(page, engine) {
  assert.equal((await state(page)).editing, false);
  const readingSwipe=async onNode=>{
    const start = await point(page, onNode), before = await state(page), scroll = await page.evaluate(() => scrollY);
    assert(before.touchAction.includes("pan-y"), "Blank canvas always lets a finger scroll the document, including while leaf editing is enabled");
    if (engine === "chromium") {
      await nativeSwipe(page, start); assert(await page.evaluate(() => scrollY) > scroll + 60, "Trusted touch scrolls the page instead of rotating 3D");
    } else {
      const prevented = await page.evaluate(start => {
        const target = document.elementFromPoint(start.x, start.y);
        return [["pointerdown", 0], ["pointermove", -100], ["pointercancel", -100]].map(([type, dy]) => {
          const event = new PointerEvent(type, {pointerId: 801, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true, clientX: start.x, clientY: start.y + dy});
          target.dispatchEvent(event); return event.defaultPrevented;
        });
      }, start);
      assert(prevented.every(value => !value), "WebKit pointer lifecycle preserves native scrolling; synthetic events are not claimed as real swipe coverage");
    }
    const after = await state(page); assert.deepEqual(space(after), space(before)); assert.deepEqual(camera(after), camera(before)); assert.deepEqual(after.view, before.view);
  };
  for(const onNode of [false,true])await readingSwipe(onNode);
  await touchYaw(page,engine,await point(page));
  await hook(page, "layout-edit").click(); await settle(page);
  const policy=await hook(page,"graph").evaluate(graph=>({graph:getComputedStyle(graph).touchAction,
    hub:getComputedStyle(graph.querySelector('[data-topology-node="hub"]')).touchAction,
    leaves:[...graph.querySelectorAll('[data-topology-node]:not(.is-hub)')].map(node=>getComputedStyle(node).touchAction)}));
  assert(policy.graph.includes("pan-y")&&policy.graph.includes("pinch-zoom"));
  assert(policy.hub==="auto"||policy.hub.includes("pan-y"),"The fixed moon leaves scrolling to the always-pan-y canvas instead of claiming layout drags");
  assert(policy.leaves.every(action=>action.includes("pinch-zoom")&&!action.includes("pan-y")),"Only actual leaves claim editing drags, retaining browser accessibility zoom");
  await readingSwipe(false);
  if (engine === "chromium") {
    const center = await point(page), beforePinch = await state(page);
    const channel = await page.context().newCDPSession(page);
    try {
      await channel.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{id: 1, x: center.x - 20, y: center.y}, {id: 2, x: center.x + 20, y: center.y}]});
      for (let i = 1; i <= 6; i++) await channel.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [
        {id: 1, x: center.x + 2 * i - 20 - i * 3, y: center.y + i}, {id: 2, x: center.x + 2 * i + 20 + i * 3, y: center.y + i}]});
      await channel.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
    } finally { await channel.detach(); }
    await settle(page); const pinched = await state(page);
    assert.deepEqual(pinched.view, beforePinch.view, "Trusted two-finger gesture cannot zoom or translate the graph");
    assert.deepEqual(camera(pinched), camera(beforePinch)); assert.deepEqual(space(pinched), space(beforePinch));
    crispProjection(pinched); await assertFixedCenter(page);
    // Restore only the browser's accessibility zoom for later gesture targets;
    // never manipulate graph state to make an assertion pass.
    const resetBrowserZoom = await page.context().newCDPSession(page);
    try { await resetBrowserZoom.send("Emulation.setPageScaleFactor", {pageScaleFactor: 1}); } finally { await resetBrowserZoom.detach(); }
  }
  // Explicit pointer lifecycle covers the one-finger continuation in both
  // engines; only the Chromium branch above claims trusted pinch injection.
  const pinchPoint = await point(page), beforeContinuation = await state(page);
  await page.evaluate(start => {
    const graph=document.querySelector("[data-topology-graph]");
    const send = (type, id, x, y) => (type==="pointerdown"?document.elementFromPoint(x,y):graph).dispatchEvent(new PointerEvent(type, {pointerId: id, pointerType: "touch", isPrimary: id === 810,
      bubbles: true, cancelable: true, clientX: x, clientY: y}));
    send("pointerdown", 810, start.x - 20, start.y); send("pointerdown", 811, start.x + 20, start.y);
    send("pointermove", 810, start.x - 28, start.y + 7); send("pointermove", 811, start.x + 38, start.y + 7);
    send("pointerup", 811, start.x + 38, start.y + 7);
  }, pinchPoint);
  await settle(page); const afterPinch = await state(page);
  await page.evaluate(start => {
    const graph = document.querySelector("[data-topology-graph]");
    for (const type of ["pointermove", "pointerup"]) graph.dispatchEvent(new PointerEvent(type, {pointerId: 810, pointerType: "touch", isPrimary: true,
      bubbles: true, cancelable: true, clientX: start.x - 8, clientY: start.y + 24}));
  }, pinchPoint);
  await settle(page); const continued = await state(page);
  assert.deepEqual(continued.view, afterPinch.view, "One remaining pointer cannot translate or zoom the fixed graph");
  assert.deepEqual(camera(continued), camera(beforeContinuation), "Canceled multi-touch never becomes an unexpected surviving-finger orbit");
  assert.deepEqual(space(continued), space(beforeContinuation));
  await assertFixedCenter(page);
  await touchYaw(page,engine,await point(page));
  const card = await point(page, true);
  await page.mouse.move(card.x, card.y); await page.mouse.down(); await page.mouse.move(card.x + 12, card.y + 9);
  assert.equal((await state(page)).dragging, true);
  await hook(page, "layout-edit").evaluate(button => button.click());
  const stopped = await state(page); assert.equal(stopped.dragging, false); assert.equal(stopped.editing, false);
  await page.mouse.move(card.x + 42, card.y + 35); await page.mouse.up(); await settle(page);
  assert.deepEqual(space(await state(page)), space(stopped), "Exiting edit mode cancels a captured 3D node drag");
  await hook(page, "layout-edit").click();
  const cancelStart = await point(page);
  await page.evaluate(start => {
    const graph=document.querySelector("[data-topology-graph]"),target=document.elementFromPoint(start.x,start.y);
    for (const [type, dx] of [["pointerdown", 0], ["pointermove", 35], ["pointercancel", 35]]) (type==="pointerdown"?target:graph).dispatchEvent(new PointerEvent(type, {pointerId: 802,
      pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true, clientX: start.x + dx, clientY: start.y}));
  }, cancelStart);
  await settle(page); assert.equal((await state(page)).dragging, false, "Canceled touch clears the 3D gesture");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", {persisted: true})));
  assert.equal((await state(page)).editing, false); assert.equal((await state(page)).dragging, false);
  assert((await state(page)).touchAction.includes("pan-y"), "Pagehide never leaves native scrolling captured");
}
async function pointerNode(page, id, destination, finish = true) {
  return page.evaluate(({id, destination, finish}) => {
    const graph = document.querySelector("[data-topology-graph]"), node = [...graph.querySelectorAll("[data-topology-node]")].find(node => node.dataset.topologyNode === id);
    const box = node.getBoundingClientRect(), start = {x: box.left + box.width / 2, y: box.top + box.height / 2};
    const send = (target, type, point) => target.dispatchEvent(new PointerEvent(type, {pointerId: 825, pointerType: "mouse", button: 0,
      buttons: type === "pointerup" ? 0 : 1, isPrimary: true, bubbles: true, cancelable: true, clientX: point.x, clientY: point.y}));
    send(node, "pointerdown", start); send(graph, "pointermove", destination);
    if (finish) send(graph, "pointerup", destination);
    return start;
  }, {id, destination, finish});
}
async function overlapAndRemoval(page, setOmitted) {
  const initial = await state(page), id = initial.nodes.find(node => node.id !== "hub").id;
  const hubCenter = await page.locator('[data-topology-node="hub"]').evaluate(node => {
    const box = node.getBoundingClientRect(); return {x: box.left + box.width / 2, y: box.top + box.height / 2};
  });
  await pointerNode(page, id, hubCenter); await settle(page);
  const overlapped = await state(page), node = overlapped.nodes.find(node => node.id === id), hub = overlapped.nodes.find(node => node.id === "hub");
  close(node.xy[0], hub.xy[0], "Dragged overlap uses real projected coordinates"); close(node.xy[1], hub.xy[1], "Dragged overlap uses real projected coordinates");
  const spoke = page.locator(`[data-topology-spoke][data-source="${id}"]`);
  assert.equal(await spoke.evaluate(el => getComputedStyle(el).visibility), "hidden", "Coincident endpoints suppress a reversed or zero-length stub without deleting the edge");
  assert.equal(await hook(page, "spoke").count(), 40);
  await resetLayout(page);
  assert.equal(await spoke.evaluate(el => getComputedStyle(el).visibility), "visible", "Separating endpoints restores the same connection");
  await assertCardEdges(page, true);
  const rect = await page.locator(`[data-topology-node="${id}"]`).boundingBox();
  await pointerNode(page, id, {x: rect.x + rect.width / 2 + 20, y: rect.y + rect.height / 2 + 12}, false); await settle(page);
  assert.equal((await state(page)).dragging, true);
  setOmitted(id);
  await hook(page, "refresh").click(); await page.waitForFunction(() => document.querySelectorAll("[data-topology-node]").length === 40); await settle(page);
  const removed = await state(page); assert.equal(removed.dragging, false); assert(!removed.nodes.some(node => node.id === id));
  await page.evaluate(() => {
    const graph = document.querySelector("[data-topology-graph]");
    for (const type of ["pointermove", "pointerup"]) graph.dispatchEvent(new PointerEvent(type, {pointerId: 825, pointerType: "mouse", button: 0,
      buttons: type === "pointerup" ? 0 : 1, isPrimary: true, bubbles: true, cancelable: true, clientX: 150, clientY: 240}));
  });
  await settle(page); const stopped = await state(page);
  assert.deepEqual(space(stopped), space(removed)); assert.deepEqual(camera(stopped), camera(removed)); assert.deepEqual(stopped.view, removed.view,
    "A removed active node cannot reinterpret a stale pointer as camera movement");
  setOmitted(null); await hook(page, "refresh").click(); await page.waitForFunction(() => document.querySelectorAll("[data-topology-node]").length === 41); await resetLayout(page);
}
async function runCase(browser, engine, width, density, theme) {
  const context = await browser.newContext({viewport: {width, height: 1000}, deviceScaleFactor: density, reducedMotion: "reduce", ...(width < 768 ? {isMobile: true, hasTouch: true} : {})});
  let dense = false, omitted = null;
  const model = id => {
    const value = dense ? denseModel(id) : packet.models[id] || packet.models[packet.initial_selected];
    if (!omitted) return value;
    return {...value, nodes: value.nodes.filter(node => node.id !== omitted), links: value.links.filter(link => link.source !== omitted && link.target !== omitted),
      relations: value.relations.filter(relation => relation.node.id !== omitted),
      summary: {...value.summary, nodes: value.summary.nodes - 1, awg: value.summary.awg - 1, enabled: value.summary.enabled - 1}};
  };
  try {
    await context.addInitScript(value => localStorage.setItem("server-kit-theme", value), theme);
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) { report.external.push(url.href); return route.abort(); }
      if (jsonURL(url)) return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(model(url.searchParams.get("node")))});
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(new URL("login/", base).href); await page.locator('[name="username"]').fill("preview"); await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/", base).href), page.locator('button[type="submit"]').click()]);
    await page.goto(new URL("network/topology/", base).href); await hook(page, "node").first().waitFor();
    const requests = []; page.on("request", request => requests.push({method: request.method(), url: request.url()}));
    assert.equal(await hook(page, "graph").getAttribute("data-projection"), "3d", "New views start in genuine 3D");
    await hook(page, "refresh").click(); await page.waitForFunction(() => document.querySelectorAll("[data-topology-node]").length === 12); await resetLayout(page);
    await controls(page); await capture(page, `${engine}-${width}-${density}x-${theme}-default`);
    let initial = await state(page); rigidProjection(initial); crispProjection(initial);
    assert.deepEqual(geometryFindings(await inlineSnapshot(page)), [], "Default twelve-node 3D projection fits without overlap");
    await orbit(page, "right"); const yawed = await state(page);
    assert.notEqual(yawed.yaw, initial.yaw); assert.deepEqual(space(yawed), space(initial)); assert.notDeepEqual(positions(yawed), positions(initial)); rigidProjection(yawed);
    await orbit(page, "up"); const pitched = await state(page);
    assert.notEqual(pitched.pitch, yawed.pitch); assert.deepEqual(space(pitched), space(initial)); assert.notDeepEqual(positions(pitched), positions(yawed)); rigidProjection(pitched);
    if (width < 768) { await hook(page, "layout-edit").click(); await settle(page); }
    const card = await point(page, true), beforeDrag = await state(page);
    await drag(page, card, 27, 19); const afterDrag = await state(page);
    assert.notDeepEqual(space(afterDrag), space(beforeDrag), "Node drag changes real XYZ rather than a screen-only offset");
    assert.deepEqual(camera(afterDrag), camera(beforeDrag));
    assert.deepEqual(space(afterDrag).filter(node => node.id !== card.id), space(beforeDrag).filter(node => node.id !== card.id), "Node drag changes only its own spatial position");
    assert.notEqual(afterDrag.nodes.find(node => node.id === card.id).xyz[2], beforeDrag.nodes.find(node => node.id === card.id).xyz[2], "Dragging at an oblique angle moves through the camera plane in true XYZ");
    await orbit(page, "left"); assert.deepEqual(space(await state(page)), space(afterDrag), "Rotating after drag never snaps spatial edits back");
    const panStart = await point(page), beforePan = await state(page); await drag(page, panStart, 31, 23, true); const afterPan = await state(page);
    assert.deepEqual(afterPan.view, beforePan.view); assert.notDeepEqual(camera(afterPan), camera(beforePan), "Shift-drag rotates instead of restoring removed pan"); assert.deepEqual(space(afterPan), space(beforePan));
    await assertFixedCenter(page);
    const rotateStart = await point(page), beforeRotate = await state(page); await drag(page, rotateStart, 32, 21); const afterRotate = await state(page);
    assert.notDeepEqual(camera(afterRotate), camera(beforeRotate), "Dragging the supported rotation surface changes the camera"); assert.deepEqual(space(afterRotate), space(beforeRotate)); rigidProjection(afterRotate);
    await rejectedZoomInputs(page); await fixedOriginInteractions(page); const saved3D = await state(page);
    if (width < 768 && (await state(page)).editing) await hook(page, "layout-edit").click();
    const selected = "vless:phone-all"; await select(page, selected); await page.evaluate(() => document.activeElement?.blur());
    const inspected = await state(page); assert.deepEqual(camera(inspected), camera(saved3D)); assert.deepEqual(space(inspected), space(saved3D));
    await permissions(page, model(selected), "forward");
    await page.locator('[data-topology-direction="reverse"]').click(); await settle(page); await page.evaluate(() => document.activeElement?.blur());
    await permissions(page, model(selected), "reverse"); assert.deepEqual(camera(await state(page)), camera(inspected)); assert.deepEqual(space(await state(page)), space(inspected));
    await Promise.all([page.waitForResponse(response => jsonURL(new URL(response.url()))), hook(page, "refresh").click()]); await settle(page);
    assert.deepEqual(camera(await state(page)), camera(inspected)); assert.deepEqual(space(await state(page)), space(inspected), "Configuration refresh retains actual spatial layout");
    await page.locator('[data-topology-direction="forward"]').click(); await settle(page); await permissions(page, model(selected), "forward");
    await capture(page, `${engine}-${width}-${density}x-${theme}-permissions-rotated`);
    const reverseTarget = "awg:nas-primary"; await select(page, reverseTarget);
    await page.locator('[data-topology-direction="reverse"]').click(); await settle(page); await page.evaluate(() => document.activeElement?.blur());
    assert(model(reverseTarget).links.some(link => link.target === reverseTarget), "Reverse coverage uses actual nonempty incoming permissions");
    await permissions(page, model(reverseTarget), "reverse");
    assert.deepEqual(camera(await state(page)), camera(inspected)); assert.deepEqual(space(await state(page)), space(inspected));
    await capture(page, `${engine}-${width}-${density}x-${theme}-sources-rotated`);
    await page.locator('[data-topology-direction="forward"]').click(); await settle(page);
    await permissions(page, model(reverseTarget), "forward");
    await page.locator('[data-topology-direction="reverse"]').click(); await settle(page);
    await permissions(page, model(reverseTarget), "reverse");
    await Promise.all([page.waitForResponse(response => jsonURL(new URL(response.url()))), hook(page, "refresh").click()]); await settle(page);
    await permissions(page, model(reverseTarget), "reverse");
    assert.deepEqual(camera(await state(page)), camera(inspected)); assert.deepEqual(space(await state(page)), space(inspected), "Refreshing incoming routes cannot disturb camera or dragged coordinates");
    await page.locator('[data-topology-mode="overview"]').click(); await orbit(page, "reset"); await resetLayout(page);
    assert.equal(await page.locator('[data-topology-spoke][marker-start], [data-topology-spoke][marker-end], [data-topology-spoke][data-topology-route-end], [data-topology-spoke][data-topology-route-via]').count(), 0, "Overview clears both destination/source-ingress arrows and their metadata");
    assert.deepEqual(space(await state(page)), space(initial), "One header auto-arrange restores all dragged positions");
    assert.deepEqual(camera(await state(page)), camera(initial), "Auto-arrange also restores the default camera");
    dense = true; const started = Date.now(); await hook(page, "refresh").click(); await page.waitForFunction(() => document.querySelectorAll("[data-topology-node]").length === 41); await resetLayout(page);
    const denseState = await state(page); rigidProjection(denseState); crispProjection(denseState);
    assert.deepEqual(geometryFindings(await inlineSnapshot(page)), [], "Default 41-node 3D projection retains every readable non-overlapping card");
    assert.equal(await hook(page, "spoke").count(), 40); assert.equal(await hook(page, "edge").count(), 0);
    const renderMs = Date.now() - started; assert(renderMs < 10000, "Dense spatial layout is responsive"); report.performance.push({engine, width, density, theme, nodes: 41, renderMs});
    await capture(page, `${engine}-${width}-${density}x-${theme}-dense`);
    await overlapAndRemoval(page, value => { omitted = value; });
    if (width < 768) await mobile(page, engine);
    assert(requests.every(request => request.method === "GET"), "Every post-login interaction stays read-only");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    report.checks.push({engine, width, density, theme, nodes: [12, 41], mobile: width < 768});
  } finally { await context.close(); }
}
(async () => {
  try {
    for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await engine.launch();
      try { for (const [width, density] of [[1440, 1], [390, 3], [320, 2]]) for (const theme of ["light", "dark"]) await runCase(browser, name, width, density, theme); }
      finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({...report,
    screenshots: report.screenshots.length, routeArrows: report.routeArrows.length}, null, 2)); }
})();
