"use strict";

// Local-only regression using models projected by the real Python backend.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {chromium, webkit} = require("playwright");
const {assertCardEdges, assertInlinePorts, assertMarkerGeometry, geometryFindings} = require("./topology_inline_assertions.cjs");
const {auditCosmos} = require("./topology_cosmos_assertions.cjs");
const {assertFixedCenter, assertFixedControls} = require("./topology_fixed_contract.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8808/");
assert.ok(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)
  && !base.username && !base.password && base.pathname === "/", "only an isolated loopback preview is allowed");
const fixtureFile = path.join(__dirname, "test_topology_permissions_fixture.py");
const projected = spawnSync(process.env.TOPOLOGY_TEST_PYTHON || "python3", [fixtureFile, "--json"], {encoding: "utf8", maxBuffer: 4 * 1024 * 1024});
assert.equal(projected.status, 0, projected.stderr || "Python projection failed");
const packet = JSON.parse(projected.stdout);
assert.equal(packet.generated_by, "dashboard.topology.build_topology");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "server-kit-topology-permissions-"));
const quick = process.env.TOPOLOGY_QA_QUICK === "1";
const report = {directory, quick, projector: packet.generated_by, checks: [], screenshots: [], flowColors: [], peerStyles: [], routeStyles: [], focusStyles: [], layoutFindings: [], requests: [], errors: [], external: []};
const topologyURL = new URL("network/topology/", base).href;
const hook = (page, name) => page.locator(`[data-topology-${name}]`);
const isJSON = url => url.origin === base.origin && url.pathname === "/network/topology/" && url.searchParams.get("format") === "json";
const captureStyle = ".skip-link:not(:focus) { visibility: hidden !important; }";
console.log(`Topology permissions QA: ${directory}`);

async function settle(page) {
  await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertFixedCenter(page);
}

async function select(page, id) {
  if (await hook(page, "select").inputValue() === id) {
    await page.locator('button[data-topology-mode="relations"]').click();
  } else {
    await hook(page, "select").selectOption(id);
  }
  await page.waitForFunction(id => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy")
    && document.querySelector("[data-topology-select]").value === id
    && document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode === id
    && document.querySelector('button[data-topology-mode="relations"]').getAttribute("aria-pressed") === "true"
    && document.querySelector("[data-topology-status]").dataset.state !== "error", id);
  await settle(page);
}

async function setTheme(page, width, theme) {
  if (width <= 900) await page.locator("[data-mobile-menu] > summary").click();
  await page.locator(`[data-theme-value="${theme}"]:visible`).first().click();
  if (width <= 900) await page.locator("[data-mobile-menu-close]").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
  await settle(page);
  const legend = await page.locator(".topology-legend-peer").evaluate(icon => {
    const style = getComputedStyle(icon);
    return {text: icon.parentElement.textContent.trim(), borderWidth: parseFloat(style.borderTopWidth), borderStyle: style.borderTopStyle, shadow: style.boxShadow};
  });
  assert.equal(legend.text, "色框＋目标/来源：当前方向已授权", "the legend accurately names the simplified frame and direction-aware badge");
  assert.equal(legend.borderWidth, 2);
  assert.equal(legend.borderStyle, "solid");
  assert.equal(legend.shadow, "none", "the legend shows the same single frame without decorative rings");
  const flows = await page.evaluate(() => ["inbound", "outbound"].map(flow => {
    const glyph = document.querySelector(`#topology-flow-arrow-${flow} path`);
    const legend = document.querySelector(`.topology-legend-line.flow-${flow}`);
    return {flow, stroke:getComputedStyle(glyph).stroke, classes:[...glyph.classList],
      legendColor:getComputedStyle(legend).color, legendText:legend.parentElement.textContent.trim()};
  }));
  const rgb = color => color.match(/[\d.]+/g).slice(0,3).map(Number);
  const [incoming,outgoing] = flows.map(flow=>rgb(flow.stroke));
  assert.ok(incoming[2]>incoming[0]+60 && incoming[2]>incoming[1]+15,
    "VPS ingress has a clearly blue color in both themes");
  assert.ok(outgoing[0]>outgoing[1]+40 && outgoing[1]>outgoing[2]+40,
    "VPS egress has a clearly amber color in both themes");
  assert.ok(Math.hypot(...incoming.map((value,index)=>value-outgoing[index]))>=100,
    "Inbound and outbound remain perceptually separated rather than reusing a node-type tint");
  for (const flow of flows) {
    assert.equal(flow.stroke,flow.legendColor,"Flow legend and real arrow use identical color");
    assert.ok(flow.classes.includes("topology-flow-arrow") && flow.classes.includes(`flow-${flow.flow}`));
    assert.match(flow.legendText,flow.flow==="inbound"?/节点 → VPS/:/VPS → 节点/);
  }
  report.flowColors.push({width,theme,flows});
}

async function assertPeers(page, model, direction, overview = false) {
  const expected = overview ? [] : model.links.filter(link => direction === "forward" ? link.source === model.selected_id : link.target === model.selected_id)
    .map(link => direction === "forward" ? link.target : link.source).sort();
  const nodes = await hook(page, "node").evaluateAll(items => items.map(node => ({id: node.dataset.topologyNode,
    peer: node.dataset.topologyPeer || null, classPeer: node.classList.contains("is-peer"), selected: node.getAttribute("aria-pressed") === "true",
    badge: node.querySelector(".topology-node-peer")?.textContent,
    badgeVisible: !!node.querySelector(".topology-node-peer:not([hidden])"),
    currentVisible: !!node.querySelector(".topology-node-selected:not([hidden])")})));
  assert.deepEqual(nodes.filter(node => node.classPeer).map(node => node.id).sort(), expected, "peer frames preserve every authorized counterpart, including leaf-to-leaf permissions without paths");
  assert.deepEqual(nodes.filter(node => node.peer).map(node => node.id).sort(), expected, "peer metadata is removed from every unrelated, inactive, unknown, and selected node");
  assert.ok(nodes.filter(node => node.classPeer).every(node => !node.selected && node.peer === (direction === "forward" ? "outbound" : "inbound")),
    "a selected node is never its own peer, and the frame records the correct access direction");
  assert.deepEqual(nodes.filter(node => node.badgeVisible).map(node => node.id).sort(), expected, "the visible role badges match the full confirmed peer set exactly");
  assert.ok(nodes.every(node => !node.badgeVisible || node.badge === (direction === "forward" ? "目标" : "来源") && !node.currentVisible), "role words follow direction and never coexist with current");
}

async function assertSpokes(page, model, direction, overview = false) {
  const expected = overview ? [] : model.links.filter(link => direction === "forward" ? link.source === model.selected_id : link.target === model.selected_id);
  const peerIds = new Set(expected.map(link => direction === "forward" ? link.target : link.source));
  const directIds = new Set(expected.filter(link => link.source === "hub" || link.target === "hub").map(link => link.source === "hub" ? link.target : link.source));
  const spokes = await hook(page, "spoke").evaluateAll(items => items.map(spoke => {
    const style = getComputedStyle(spoke), node = document.querySelector(`[data-topology-node="${spoke.dataset.source}"]`);
    const marker = end => {
      const ref = spoke.getAttribute(`marker-${end}`), id = ref?.match(/#([^)]*)\)/)?.[1], element = id ? document.getElementById(id) : null;
      return element ? {id: element.id, orient: element.getAttribute("orient"), refX: Number(element.getAttribute("refX")), refY: Number(element.getAttribute("refY")),
        units: element.getAttribute("markerUnits"), width: Number(element.getAttribute("markerWidth")), height: Number(element.getAttribute("markerHeight")),
        stroke: getComputedStyle(element.querySelector("path")).stroke} : null;
    };
    return {source: spoke.dataset.source, target: spoke.dataset.target, classes: [...spoke.classList], route: spoke.dataset.topologyRoute || null,
      routeEnd: spoke.dataset.topologyRouteEnd || null, routeVia: spoke.dataset.topologyRouteVia || null, flow:spoke.dataset.topologyFlow || null,
      dash: style.strokeDasharray, stroke: style.stroke, width: parseFloat(style.strokeWidth), opacity: Number(style.opacity), vectorEffect: style.vectorEffect,
      markerStart: spoke.getAttribute("marker-start"), markerEnd: spoke.getAttribute("marker-end"), typeColor: getComputedStyle(node.querySelector(".topology-node-state")).color,
      marker: marker("start"), sourceMarker: marker("end")};
  }));
  report.routeStyles.push({theme: await page.locator("html").getAttribute("data-theme"), selected: model.selected_id, direction, overview, spokes});
  assert.equal(spokes.length, model.nodes.length - 1, "every leaf retains exactly one structural VPS spoke");
  assert.deepEqual(spokes.map(spoke => spoke.source).sort(), model.nodes.filter(node => node.id !== "hub").map(node => node.id).sort());
  for (const spoke of spokes) {
    const kind = model.nodes.find(node => node.id === spoke.source).kind;
    const role = peerIds.has(spoke.source) ? "peer" : expected.length && spoke.source === model.selected_id ? "selected" : null;
    const terminal = !directIds.has(spoke.source) && (direction === "forward" ? role === "peer" : role === "selected");
    const flow = role ? ((direction === "forward" && role === "selected") || (direction === "reverse" && role === "peer") ? "inbound" : "outbound") : null;
    const sourceIngress = !directIds.has(spoke.source) && flow === "inbound";
    assert.equal(spoke.target, "hub", "structural paths always join a leaf to the central VPS");
    assert.notEqual(spoke.dash, "none");
    assert.equal(Boolean(spoke.markerEnd), sourceIngress, "Every confirmed source points into the VPS, whether current outbound source or incoming peer; unknown and direct-hub replacements do not");
    assert.equal(Boolean(spoke.markerStart), terminal, "only actual destination leaves have arrowheads; origin, overview, disabled, unknown, and direct-hub replacements do not");
    assert.ok(!(spoke.markerStart && spoke.markerEnd), "a source and the current destination never receive contradictory two-ended spoke arrows");
    assert.equal(spoke.routeEnd, terminal ? spoke.source : null, "terminal metadata names only the actual destination and clears on every other view");
    assert.equal(spoke.routeVia, sourceIngress ? "hub" : null, "source ingress names the VPS as transit, never the final authorized destination");
    assert.equal(spoke.flow,flow,"Every highlighted segment names its actual direction relative to the VPS, independent of node kind");
    for (const [name, active, marker] of [["destination", terminal, spoke.marker], ["source ingress", sourceIngress, spoke.sourceMarker]]) {
      if (!active) { assert.equal(marker, null, `clearing or replacing a route leaves no stray ${name} marker`); continue; }
      assert.ok(marker, `a visible ${name} arrow resolves to a real SVG marker definition`);
      assert.equal(marker.id, `topology-flow-arrow-${flow}`, "Arrow color identifies actual in/out flow, not AWG/VLESS node type");
      assert.equal(marker.orient, "auto-start-reverse", "the same marker points into the leaf at start, or into the VPS at end");
      assert.equal(marker.refX, 8);
      assert.equal(marker.refY, 5);
      assert.equal(marker.units, "userSpaceOnUse");
      assert.equal(marker.width, 10, "destination and source arrows remain 10 CSS px at the fixed 1:1 scene scale");
      assert.equal(marker.height, 10);
      assert.equal(marker.stroke,spoke.stroke,"Arrowhead and its own line always share the same flow color");
    }
    assert.ok(spoke.classes.includes(`kind-${kind}`), "each spoke retains the connected leaf's AWG/VLESS type");
    assert.equal(spoke.route, role, "only confirmed peers and a selected node with confirmed access highlight the connection");
    assert.equal(spoke.classes.includes("is-route"), Boolean(role), "route styling and metadata clear together on overview, unknown and no-access views");
    assert.equal(spoke.classes.includes("has-permission"), directIds.has(spoke.source), "only a real leaf–VPS authorization replaces its structural spoke");
    assert.equal(spoke.vectorEffect, "none", "SVG line geometry shares the fixed-scale scene coordinates");
    if (role) {
      assert.equal(spoke.stroke, await page.locator(`#topology-flow-arrow-${flow} path`).evaluate(el=>getComputedStyle(el).stroke),
        "Flow color is consistent across different leaf types and route roles");
      assert.equal(spoke.width, 2.4, "related spatial connections retain the explicit, more readable flow line weight");
      assert.equal(spoke.opacity, directIds.has(spoke.source) ? 0 : 1,
        "direct permissions keep one visible arrow, while other relevant connections remain clearly visible");
    } else if (!overview) {
      assert.equal(spoke.opacity, .2, "unrelated spatial connections recede without disappearing");
      assert.equal(spoke.width, 1.25);
    } else assert.ok(spoke.opacity > 0, "the overview restores all neutral structural connections");
  }
}

async function peerStyles(page, engine, width, theme, caseName) {
  // Flat ancestor colors are no longer the painted surface: the real moon,
  // sky and sea have gradients. Preserve the 4.5 text / 3 frame thresholds
  // by sampling the actual background underneath every label and frame.
  const cosmos = await auditCosmos(page, packet.models.hub.nodes.map(node => node.id));
  const styles = await hook(page, "node").evaluateAll(async nodes => {
    await Promise.race([Promise.all(nodes.flatMap(node => node.getAnimations()).map(animation => animation.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 500))]);
    const rgba = value => {
      const values = value.match(/[\d.]+/g).map(Number);
      // color-mix(in srgb, ...) serializes normalized color(srgb ...) channels
      // in Chromium, while WebKit may serialize the same fill as rgb(...).
      const channels = values.slice(0, 3).map(channel => /^color\(srgb /.test(value) ? channel * 255 : channel);
      return [...channels, values[3] ?? 1];
    };
    const blend = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3]));
    const background = node => {
      const layers = [];
      for (let current = node; current; current = current.parentElement) layers.unshift(rgba(getComputedStyle(current).backgroundColor));
      return layers.reduce((color, layer) => blend(layer, color), [255, 255, 255]);
    };
    const ordinary = nodes.find(node => !node.classList.contains("is-hub") && !node.classList.contains("is-peer") && node.getAttribute("aria-pressed") !== "true");
    const ordinaryBackground = background(ordinary);
    return nodes.filter(node => node.classList.contains("is-peer") || node.getAttribute("aria-pressed") === "true").map(node => {
      const style = getComputedStyle(node), bg = background(node), state = node.querySelector(".topology-node-state");
      const color = rgba(style.borderTopColor);
      return {id: node.dataset.topologyNode, kind: node.classList.contains("kind-awg") ? "awg" : node.classList.contains("kind-vless") ? "vless" : "hub",
        shape: node.dataset.topologyShape,
        selected: node.getAttribute("aria-pressed") === "true", peer: node.classList.contains("is-peer"), stateColor: getComputedStyle(state).color,
        border: style.borderTopColor, background: style.backgroundColor, effectiveBackground: bg, color: blend(color, bg), width: parseFloat(style.borderTopWidth), height: node.getBoundingClientRect().height,
        shadow: style.boxShadow, borderStyle: style.borderTopStyle, zIndex: Number(style.zIndex),
        depthIndex: Number(style.getPropertyValue("--topology-depth-index")), animation: style.animationName,
        fillDifference: Math.hypot(...bg.map((channel, index) => channel - ordinaryBackground[index]))};
    });
  });
  report.peerStyles.push({engine, width, theme, case: caseName, nodes: styles, contrast: cosmos.contrast, occludedSamples: cosmos.occludedSamples});
  for (const item of styles) {
    assert.ok(item.width >= 2, `${engine}/${width}/${theme}/${item.id}: peer frame is at least 2 CSS px`);
    assert.equal(item.zIndex, 20 + item.depthIndex, "Current and counterpart markers preserve true camera-depth ordering, including the VPS");
    if (item.peer) {
      if (item.kind === "hub") assert.equal(item.shape, "moon", "The actual VPS uses the separately contrast-tested lunar surface, not a panel-tinted card");
      else assert.ok(item.fillDifference >= 15, "counterpart card tint differs visibly from unrelated spatial cards");
      assert.equal(item.width, 2, "counterparts use a compact single 2 CSS px border");
      assert.equal(item.borderStyle, "solid");
      assert.equal(item.shadow, "none", "counterparts have no separating ring, second outer frame, or decorative shadow");
      assert.equal(item.border, item.stateColor, "the single border preserves the exact node type color");
      assert.equal(item.animation, "none", "highlighting never adds a continuously moving or pulsing animation");
    } else {
      assert.doesNotMatch(item.shadow, /0px 0px 0px [24]px/, "the current node also retains no double-ring decoration");
    }
    if (item.selected) assert.equal(item.border, item.stateColor, "selected card uses its own type color, not an unrelated warm frame");
    const [red, green, blue] = item.color;
    if (item.kind === "awg") assert.ok(blue > red + 15 && green > red, "AWG peers use a recognizable blue frame");
    if (item.kind === "vless") assert.ok(blue > green + 15 && red > green + 10, "VLESS peers use a recognizable purple frame");
    if (item.kind === "hub") assert.ok(blue > red + 20 && blue > green + 10, "VPS peers use a recognizable moon-blue frame");
  }
  const byKind = Object.values(Object.fromEntries(styles.map(item => [item.kind, item])));
  for (let first = 0; first < byKind.length; first++) for (let second = first + 1; second < byKind.length; second++) {
    const distance = Math.hypot(...byKind[first].color.map((value, channel) => value - byKind[second].color[channel]));
    assert.ok(distance >= 45, "different node kinds have visibly distinct peer-frame colors");
  }
}

async function focusAndSearch(page, model, engine, width, theme) {
  const targetId = model.links.find(link => link.source === model.selected_id && link.target !== "hub").target;
  const targetName = model.nodes.find(node => node.id === targetId).name;
  const target = page.locator(`[data-topology-node="${targetId}"]`);
  await hook(page, "view-options").locator("summary").click();
  await hook(page, "search").fill(targetName);
  await settle(page);
  const searchStyle = await target.evaluate(node => {
    const style = getComputedStyle(node);
    return {matched: node.classList.contains("is-match"), outline: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), shadow: style.boxShadow,
      zIndex: Number(style.zIndex), depthIndex: Number(style.getPropertyValue("--topology-depth-index")),
      borderWidth: parseFloat(style.borderTopWidth), border: style.borderTopColor, typeColor: getComputedStyle(node.querySelector(".topology-node-state")).color};
  });
  assert.ok(searchStyle.matched && searchStyle.outline === "dashed" && searchStyle.width >= 2 && searchStyle.offset >= 4,
    "search adds a distinct dashed outline outside, not in place of, the peer's single border");
  assert.equal(searchStyle.shadow, "none", "search does not reintroduce decorative rings or shadows");
  assert.equal(searchStyle.zIndex, 20 + searchStyle.depthIndex, "Search highlights never lift a node above its true depth");
  assert.equal(searchStyle.borderWidth, 2);
  assert.equal(searchStyle.border, searchStyle.typeColor, "search preserves the single type-colored border");
  await page.keyboard.press("Tab");
  await target.focus();
  const focusStyle = await target.evaluate(node => {
    const style = getComputedStyle(node);
    return {visible: node.matches(":focus-visible"), outline: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), shadow: style.boxShadow, zIndex: Number(style.zIndex), depthIndex: Number(style.getPropertyValue("--topology-depth-index")),
      borderWidth: parseFloat(style.borderTopWidth), border: style.borderTopColor, typeColor: getComputedStyle(node.querySelector(".topology-node-state")).color};
  });
  assert.ok(focusStyle.visible && focusStyle.outline === "solid" && focusStyle.width >= 2 && focusStyle.offset >= 4,
    "keyboard focus remains a distinct solid outline even on a search-matched counterpart");
  assert.equal(focusStyle.zIndex, 20 + focusStyle.depthIndex, "Keyboard focus keeps a visible outline without overriding the real depth order");
  assert.equal(focusStyle.shadow, "none", "keyboard focus does not restore a decorative double frame");
  assert.equal(focusStyle.borderWidth, 2);
  assert.equal(focusStyle.border, focusStyle.typeColor);
  await hook(page, "search").fill("");
  await hook(page, "view-options").locator("summary").click();
  await page.locator('[data-topology-orbit="reset"]').click();
  await page.evaluate(() => document.activeElement?.blur());
  await settle(page);
  assert.equal(await target.evaluate(node => node.classList.contains("is-match")), false, "clearing search removes only the search hint");
  assert.equal(await target.locator(".topology-node-peer:not([hidden])").innerText(), "目标", "search/focus never alter the permission counterpart role");
  report.focusStyles.push({engine, width, theme, targetId, searchStyle, focusStyle});
}

async function overview(page, model, requests) {
  const before = await hook(page, "node").evaluateAll(items => items.map(node => ({id: node.dataset.topologyNode, x: node.dataset.worldX, y: node.dataset.worldY})));
  const beforeRequests = requests.length;
  await page.locator('button[data-topology-mode="overview"]').click();
  await settle(page);
  assert.equal(await hook(page, "edge").count(), 0);
  assert.equal(await hook(page,"select").inputValue(),"","Overview has no selected option");
  assert.equal(await hook(page,"select").locator('option[value=""][disabled]').count(),1);
  assert.equal(await page.locator('[data-topology-node][aria-pressed="true"]').count(),0);
  assert.equal(await hook(page,"full-details").isVisible(),false);
  assert.equal(await hook(page,"full-details").getAttribute("open"),null);
  assert.equal(new URL(page.url()).searchParams.has("node"),false);
  assert.equal(new URL(page.url()).searchParams.has("format"),false);
  await assertPeers(page, model, "forward", true);
  await assertSpokes(page, model, "forward", true);
  await assertInlinePorts(page, model.links, model.selected_id, "forward", true);
  await assertCardEdges(page);
  await assertMarkerGeometry(page);
  assert.equal(requests.length, beforeRequests, "returning to overview removes peer frames without a fetch");
  assert.deepEqual(await hook(page, "node").evaluateAll(items => items.map(node => ({id: node.dataset.topologyNode, x: node.dataset.worldX, y: node.dataset.worldY}))), before,
    "peer cleanup never rearranges nodes");
}

async function assertDirection(page, model, direction, expectedCount) {
  const positions = await hook(page, "node").evaluateAll(nodes => nodes.map(node => ({id: node.dataset.topologyNode, x: node.dataset.worldX, y: node.dataset.worldY})));
  await page.locator(`button[data-topology-direction="${direction}"]`).click();
  await settle(page);
  assert.deepEqual(await hook(page, "node").evaluateAll(nodes => nodes.map(node => ({id: node.dataset.topologyNode, x: node.dataset.worldX, y: node.dataset.worldY}))), positions,
    "direction-dependent content height changes never reset node positions");
  const expected = model.links.filter(link => direction === "forward" ? link.source === model.selected_id : link.target === model.selected_id);
  assert.equal(expected.length, expectedCount, "the real backend produced the expected number of confirmed directions");
  assert.equal(await hook(page, "node").count(), 12, "all twelve nodes remain on one canvas");
  await assertSpokes(page, model, direction);
  const paths = await hook(page, "edge").evaluateAll(edges => edges.map(edge => ({source: edge.dataset.source, target: edge.dataset.target,
    dash: getComputedStyle(edge).strokeDasharray, marker: edge.getAttribute("marker-end"), start: edge.getAttribute("marker-start"),
    via: edge.dataset.topologyRouteVia || null, bidirectional: edge.dataset.bidirectional, flow:edge.dataset.topologyFlow || null,
    stroke:getComputedStyle(edge).stroke,
    arrowStroke:(()=>{const id=edge.getAttribute("marker-end")?.match(/#([^)]*)\)/)?.[1];return id?getComputedStyle(document.getElementById(id).querySelector("path")).stroke:null;})()})));
  const drawn = expected.filter(link => link.source === "hub" || link.target === "hub");
  assert.deepEqual(paths.map(link => `${link.source}→${link.target}`).sort(), drawn.map(link => `${link.source}→${link.target}`).sort(),
    "only real VPS-involving permissions create permission paths; relay arrows never add hub authorization or leaf-to-leaf paths");
  assert.ok(paths.every(edge => edge.marker && !edge.start && !edge.via && edge.bidirectional !== "true" && edge.dash !== "none"), "confirmed hub permissions retain exactly one destination arrow and never gain reverse or transit semantics");
  for (const edge of paths) {
    assert.equal(edge.flow,edge.source === "hub" ? "outbound" : "inbound");
    assert.equal(edge.marker,`url(#topology-flow-arrow-${edge.flow})`);
    assert.equal(edge.arrowStroke,edge.stroke,"A genuine hub permission uses the same directional line and arrow color");
  }
  const hubForward = model.selected_id === "hub" && direction === "forward";
  assert.match(await hook(page, "canvas-summary").textContent(), hubForward ? /VPS 主动访问未检测/ : new RegExp(`当前方向 ${expectedCount} 条授权`),
    "Confirmed permission counts remain the backend count; unmeasured VPS outbound never claims a denial or allowed connection");
  const rows = await hook(page, "inspector").locator("[data-topology-access-target]").evaluateAll(items => items.map(item => ({id: item.dataset.topologyAccessTarget,
    text:item.textContent,status:item.dataset.topologyAccessStatus,scopes: [...item.querySelectorAll(".topology-access-scopes li")].map(scope => scope.textContent)})));
  const expectedRows = hubForward ? model.relations.map(relation=>({id:relation.node.id,scopes:relation.forward.scopes}))
    : expected.map(link => ({id: direction === "forward" ? link.target : link.source, scopes: link.scopes}));
  assert.deepEqual(rows.map(({id,scopes})=>({id,scopes})).sort((a, b) => a.id.localeCompare(b.id)), expectedRows.sort((a, b) => a.id.localeCompare(b.id)),
    "the visible inspector contains every exact backend scope and no additional access");
  if (hubForward) for (const relation of model.relations) {
    const row=rows.find(row=>row.id===relation.node.id);
    assert.equal(row.status,relation.forward.status,"VPS outbound shows exact backend status, not a fabricated allowed state");
    assert(row.text.includes(relation.forward.label) && row.text.includes(relation.forward.summary),
      "Hub outbound inspection exposes each true state and explanation instead of implying unknown access is allowed");
  }
  await assertPeers(page, model, direction);
  const inline = await assertInlinePorts(page, model.links, model.selected_id, direction);
  const layoutFindings = geometryFindings(inline);
  assert.deepEqual(layoutFindings, [], "inline port rows are inside non-overlapping cards, including dense hub inbound");
  await assertCardEdges(page);
  await assertMarkerGeometry(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  return layoutFindings;
}

async function capture(page, name) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator(".topology-panel").screenshot({path: path.join(directory, name), style: captureStyle});
  report.screenshots.push(name);
}

async function scenario(browser, engine, width) {
  const context = await browser.newContext({viewport: {width, height: width < 768 ? 844 : 1000}, ...(width < 768 ? {isMobile: true, hasTouch: true} : {})});
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const requests = [], allRequests = [], navigations = [];
  let missingContext = false;
  try {
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === base.origin) return route.continue();
      report.external.push(url.href);
      return route.abort();
    });
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(new URL("login/", base).href);
    await page.locator('[name="username"]').fill("preview");
    await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL('/overview/', base).href), page.locator('button[type="submit"]').click()]);
    await page.route(isJSON, route => {
      const id = new URL(route.request().url()).searchParams.get("node");
      const model = missingContext ? packet.missing_context : packet.models[id] || packet.models[packet.initial_selected];
      return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(model)});
    });
    await page.route(url => url.origin === base.origin && url.pathname === "/network/telemetry/", route => {
      const nodes = packet.models.hub.nodes.filter(node => node.kind !== "hub").map((node, index) => {
        const state = node.availability === "disabled" ? "disabled" : node.availability === "pending" ? "pending" : node.kind === "vless" ? "unsupported" : "active";
        const sampled = state === "active";
        return {id: node.id, state, source: sampled ? "awg" : "none", last_seen_at: sampled ? Math.floor(Date.now() / 1000) - 25 : null,
          rate_status: sampled ? "ok" : "unavailable", upload_bps: sampled ? (index + 1) * 1024 * 2 : null,
          download_bps: sampled ? (index + 1) * 1024 * 1024 * 99 : null};
      });
      return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({schema_version: 1,
        sampled_at: new Date().toISOString(), sample_age_ms: 0, refresh_ms: 2000, stale_after_ms: 8000, nodes})});
    });
    await page.goto(topologyURL);
    await hook(page, "graph").waitFor();
    await page.waitForFunction(() => document.querySelector("[data-topology-root]").dataset.projection === "3d"
      && document.querySelector("[data-topology-graph]").dataset.projection === "3d");
    await assertFixedControls(page);
    assert.equal(await page.locator("[data-topology-projection], [data-topology-fit], [data-topology-zoom], [data-topology-zoom-in], [data-topology-zoom-out]").count(), 0,
      "The spatial view has no old projection selector, fit action or zoom controls");
    page.on("request", request => {
      const item = {method: request.method(), url: request.url()};
      allRequests.push(item);
      if (isJSON(new URL(item.url))) requests.push(item);
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url());
    });
    await Promise.all([page.waitForResponse(response => isJSON(new URL(response.url()))), hook(page, "refresh").click()]);
    await page.waitForFunction(() => document.querySelectorAll("[data-topology-node]").length === 12);
    assert.equal(await hook(page, "reset").isVisible(), true, "Auto rearrange is available without opening a secondary menu");
    await hook(page, "reset").click();
    await settle(page);
    const cardSizes = await hook(page, "node").evaluateAll(items => items.map(node => ({id: node.dataset.topologyNode, width: node.offsetWidth, height: node.offsetHeight})));
    async function inspect(model, direction, expected, theme, name) {
      try {
        const findings = await assertDirection(page, model, direction, expected);
        if (findings.length) report.layoutFindings.push({engine, width, theme, case: name, findings});
      }
      catch (error) {
        await peerStyles(page, engine, width, theme, name + "-failure");
        await capture(page, `${engine}-${width}-${theme}-${name}-failure.png`);
        throw error;
      }
      const actualSizes = await hook(page, "node").evaluateAll(items => items.map(node => ({id: node.dataset.topologyNode, width: node.offsetWidth, height: node.offsetHeight})));
      for (const actual of actualSizes) {
        const initial = cardSizes.find(node => node.id === actual.id);
        assert.ok(Math.abs(actual.width - initial.width) < .5, "local card width stays fixed while permission contents change at the fixed 1:1 scene scale");
      }
      try { await peerStyles(page, engine, width, theme, name); }
      catch (error) { await capture(page, `${engine}-${width}-${theme}-${name}-style-failure.png`); throw error; }
      await capture(page, `${engine}-${width}-${theme}-${name}.png`);
    }
    const allModel = packet.models["vless:phone-all"], partialModel = packet.models["vless:phone-ports"], nasModel = packet.models["vless:phone-nas"], hubModel = packet.models.hub, nasTargetModel = packet.models["awg:nas-primary"];
    const details = hook(page, "full-details");
    for (const theme of ["light", "dark"]) {
      await setTheme(page, width, theme);
      await overview(page, allModel, requests);
      await capture(page, `${engine}-${width}-${theme}-overview.png`);
      await select(page, allModel.selected_id);
      await inspect(allModel, "forward", 8, theme, "phone-all-forward");
      assert.equal(await hook(page, "edge").count(), 1, "all-access phone has one VPS arrow, not eight crossing permission paths");
      assert.equal(await hook(page, "graph").locator(".is-peer").count(), 8, "all eight authorized targets remain framed");
      assert.equal(await hook(page, "inspector").locator("[data-topology-access-target]").count(), 8);
      assert.ok(allModel.links.filter(link => link.source === allModel.selected_id).every(link => link.scopes.length === 1 && link.scopes[0] === "全部协议 · 全部端口"));
      await focusAndSearch(page, allModel, engine, width, theme);
      await inspect(allModel, "reverse", 0, theme, "phone-all-reverse");
      await overview(page, allModel, requests);
      await select(page, partialModel.selected_id);
      await inspect(partialModel, "forward", 1, theme, "phone-hub-tcp-udp");
      const hubScopes = await hook(page, "inspector").locator('.topology-access-scopes li').allTextContents();
      assert.deepEqual(hubScopes, ["TCP · 22, 9080", "UDP · 53, 123"]);
      // A new partial target must replace, not accumulate with, the moon-blue VPS frame.
      await select(page, nasModel.selected_id);
      await inspect(nasModel, "forward", 1, theme, "phone-nas-only");
      assert.equal(await hook(page, "edge").count(), 0, "NAS-only phone has no direct hub permission edge while its target remains visible");
      assert.equal(await hook(page, "graph").locator(".is-peer").count(), 1);
      await select(page, hubModel.selected_id);
      assert.equal(await page.locator('[data-topology-direction="reverse"]').getAttribute("aria-pressed"),"true",
        "Newly selecting VPS defaults to confirmed incoming permissions, without requiring a manual direction switch");
      assert.equal(await page.locator('[data-topology-direction="forward"]').innerText(),"VPS 可访问");
      assert.equal(await page.locator('[data-topology-direction="reverse"]').innerText(),"可访问 VPS");
      const inboundCount = hubModel.links.filter(link => link.target === "hub").length;
      await inspect(hubModel, "reverse", inboundCount, theme, "hub-inbound");
      assert.equal(await hook(page, "edge").count(), inboundCount, "VPS reverse view retains every authorized leaf-to-VPS arrow");
      assert.equal(await hook(page, "graph").locator('.kind-vless.is-peer[data-topology-peer="inbound"]').count(), 2, "known VLESS sources receive purple inbound frames");
      const outboundCount=hubModel.links.filter(link=>link.source==="hub").length;
      await inspect(hubModel,"forward",outboundCount,theme,"hub-outbound-statuses");
      assert.equal(outboundCount,0,"The real backend fixture does not claim VPS-origin permissions");
      assert.equal(await hook(page,"edge").count(),0,"Unknown, inactive and not-applicable Hub outgoing statuses create no access arrow");
      assert.equal(await hook(page,"graph").locator('.is-peer').count(),0,"Unknown VPS outbound relations create no allowed peer frames");
      await overview(page,hubModel,requests);
      await select(page,hubModel.selected_id);
      assert.equal(await page.locator('[data-topology-direction="reverse"]').getAttribute("aria-pressed"),"true",
        "Reselecting the VPS from overview restores the useful inbound view rather than stale unknown outbound");
      await select(page, nasTargetModel.selected_id);
      await inspect(nasTargetModel, "reverse", 3, theme, "nas-inbound");
      assert.equal(await hook(page, "graph").locator('.kind-vless.is-peer[data-topology-peer="inbound"]').count(), 2, "a sparse reverse view independently verifies both purple source frames");
      assert.equal(await page.locator('[data-topology-spoke][marker-end]').count(), 3, "all three authorized sources have a VPS ingress arrow");
      assert.equal(await page.locator('[data-topology-spoke][marker-start]').count(), 1, "the reverse route has exactly one common destination arrow into the selected NAS");
      await assertDirection(page, nasTargetModel, "forward", nasTargetModel.links.filter(link => link.source === nasTargetModel.selected_id).length);
      await assertDirection(page, nasTargetModel, "reverse", 3);
      await Promise.all([page.waitForResponse(response => isJSON(new URL(response.url()))), hook(page, "refresh").click()]);
      await settle(page);
      await assertDirection(page, nasTargetModel, "reverse", 3);
      await overview(page, hubModel, requests);
      await capture(page, `${engine}-${width}-${theme}-overview-cleared.png`);
    }

    await select(page, allModel.selected_id);
    await assertDirection(page, allModel, "reverse", 0);
    await details.locator("summary").click();
    const reverseStatuses = await hook(page, "inbound").locator("[data-relation-status]").evaluateAll(items => items.map(item => item.dataset.relationStatus));
    assert.equal(reverseStatuses.length, 11);
    assert.ok(reverseStatuses.every(status => status === "not_applicable"), "every inbound relationship to a VLESS entry is not applicable, not falsely allowed");
    await details.locator("summary").click();

    missingContext = true;
    await Promise.all([page.waitForResponse(response => isJSON(new URL(response.url()))), hook(page, "refresh").click()]);
    await settle(page);
    await assertDirection(page, packet.missing_context, "forward", 0);
    await details.locator("summary").click();
    assert.match(await hook(page, "outbound").innerText(), /待核实|未提供|无法核实/);
    await details.locator("summary").click();
    await capture(page, `${engine}-${width}-missing-facts.png`);
    assert.deepEqual(navigations, [], "inspecting permissions never navigates away or sends a management operation");
    assert.ok(requests.length > 0 && requests.every(request => request.method === "GET" && isJSON(new URL(request.url))));
    assert.ok(allRequests.every(request => request.method === "GET" && (isJSON(new URL(request.url)) || new URL(request.url).pathname === "/network/telemetry/")), "configuration and telemetry remain exclusively read-only and no unrelated endpoint is called");
    assert.doesNotMatch(await hook(page, "root").innerHTML(), /synthetic-topology-private-credential-never-render|vless:\/\/|Preview-only-2026/);
    report.requests.push({engine, width, topologyGETs: requests.length});
    report.checks.push(`${engine} ${width}: real backend permissions, type-colored peers, blue ingress/amber egress with identical line/marker/legend colors, source→VPS→destination arrows without duplicate or invented permissions, default VPS inbound and exact unmeasured outbound statuses, full inline port scopes, light/dark contrast, genuinely unselected overview and URL/details cleanup, GET-only and no credentials`);
  } finally { await context.close(); }
}

(async () => {
  try {
    for (const [engine, factory] of quick ? [["webkit", webkit]] : [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await factory.launch();
      try {
        const anonymous = await browser.newContext();
        try {
          const response = await anonymous.request.get(topologyURL + "?format=json", {maxRedirects: 0});
          assert.ok([302, 401, 403].includes(response.status()), "topology requires authentication");
        } finally { await anonymous.close(); }
        for (const width of quick ? [320] : [1440, 320, 390]) await scenario(browser, engine, width);
      } finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.external, []);
    console.log(JSON.stringify({directory, checks: report.checks, screenshots: report.screenshots.length,
      peerStyleCases: report.peerStyles.length, layoutFindings: report.layoutFindings,
      requests: report.requests, errors: report.errors, external: report.external}, null, 2));
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
    console.error(error.stack);
  } finally {
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Topology permission artifacts: ${directory}`);
  }
})();
