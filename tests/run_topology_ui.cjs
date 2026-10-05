"use strict";

// Isolated browser regression with synthetic fixtures only; never targets a VPS.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {chromium, webkit} = require("playwright");
const {assertCardEdges, assertMarkerGeometry, assertInlinePorts, geometryFindings, inlineSnapshot} = require("./topology_inline_assertions.cjs");
const {assertFixedCenter, assertFixedControls, assertDepthOcclusion} = require("./topology_fixed_contract.cjs");
const {selectionScenarios} = require("./run_topology_selection_ui.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8765/");
if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname)
    || base.username || base.password || base.pathname !== "/") throw new Error("Only an isolated loopback preview is allowed.");
const preservePreviewFixture = process.argv.includes("--preserve-preview-fixture");
if (preservePreviewFixture && !["--arrow-smoke", "--selection-smoke"].some(flag => process.argv.includes(flag))) {
  throw new Error("Preserving a shared preview fixture is supported only by the read-only arrow/selection smoke suites.");
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "server-kit-topology-"));
console.log(`Topology QA started: ${directory}`);
const report = {directory, preservePreviewFixture, checks: [], screenshots: [], errors: [], blocked: [], performance: [], controlStyles: [], readability: []};
const password = "Preview-only-2026!";
const topologyURL = new URL("network/topology/", base).href;
const hook = (page, name) => page.locator(`[data-topology-${name}]`);
const jsonRoute = url => url.origin === base.origin && url.pathname === "/network/topology/" && url.searchParams.get("format") === "json";
const jsonResponse = response => jsonRoute(new URL(response.url()));
// Tall element captures can composite an offscreen fixed skip link into the
// middle of the image. Hide only that unfocused, already-offscreen link during
// capture; it remains available and unchanged in every interaction test.
const captureStyle = ".skip-link:not(:focus) { visibility: hidden !important; }";

function syntheticModel(original, id = "hub", revision = "") {
  const hub = {...original.nodes.find(node => node.id === "hub")};
  const source = original.nodes.find(node => node.kind === "awg");
  assert.ok(source, "rich fixture must contain an AWG node");
  const nodes = [hub, ...Array.from({length: 40}, (_, index) => {
    const name = `synthetic-${String(index).padStart(2, "0")}${index === 39 ? "-long-node-name-for-mobile-layout" : ""}`;
    return {...source, id: `awg:${name}`, name: name + revision, address: `10.20.1.${index + 10}`, protected: false};
  })];
  const selected = nodes.find(node => node.id === id) || hub;
  const allowed = {status: "partial", label: "指定范围", summary: "TCP 22,443", scopes: ["TCP 22,443"], warnings: []};
  const unknown = {status: "unknown", label: "未检测", summary: "VPS 发起的访问未检测", scopes: [], warnings: []};
  const links = nodes.filter(node => node.kind !== "hub").flatMap(source => nodes.filter(target => target.id !== source.id)
    .map(target => ({source: source.id, target: target.id, status: "partial", label: "TCP 22,443", scopes: ["TCP 22,443"]})));
  return {...original, nodes, selected, selected_id: selected.id,
    links,
    relations: nodes.filter(node => node.id !== selected.id).map(node => ({node,
      forward: {...(selected.kind === "hub" ? unknown : allowed)}, reverse: {...(node.kind === "hub" ? unknown : allowed)},
      relation: selected.kind === "hub" ? "inbound" : node.kind === "hub" ? "outbound" : "mutual", label: "配置授权"})),
    summary: {nodes: 40, awg: 40, vless: 0, enabled: 40, disabled: 0, pending: 0},
    observed_at: new Date().toISOString()};
}

function realisticModel(original, id, scopeOverride = null) {
  const hub = {...original.nodes.find(node => node.id === "hub")};
  const template = original.nodes.find(node => node.kind === "awg");
  const names = ["home-desktop", "office-workstation", "nas-primary", "nas-backup", "lab-server", "travel-laptop", "media-server", "family-desktop", "iphone-travel", "android-daily", "retired-phone"];
  const nodes = [hub, ...names.map((name, index) => {
    const kind = index < 8 ? "awg" : "vless", disabled = index === 10;
    return {...template, id: `${kind}:${name}`, name, kind, kind_label: kind === "awg" ? "AmneziaWG" : "VLESS",
      address: kind === "awg" ? `10.20.2.${index + 10}` : "", protected: index === 0,
      availability: disabled ? "disabled" : "enabled", state: disabled ? "已禁用" : "已启用"};
  })];
  const scopes = scopeOverride ? [scopeOverride] : [["全部协议 · 全部端口"], ["TCP · 22, 443"], ["UDP · 53"], ["TCP · 8000-8010"]];
  const targets = nodes.filter(node => node.kind !== "vless");
  const sources = nodes.filter(node => node.kind !== "hub" && node.availability === "enabled");
  const links = [];
  for (let offset = 0; links.length < 46 && offset < targets.length; offset++) {
    for (let index = 0; index < sources.length && links.length < 46; index++) {
      const source = sources[index], target = targets[(index + offset) % targets.length];
      if (source.id === target.id) continue;
      const allowedScopes = scopes[(index + offset) % scopes.length];
      links.push({source: source.id, target: target.id, status: !scopeOverride && allowedScopes === scopes[0] ? "allowed" : "partial", label: allowedScopes.join("；"), scopes: allowedScopes});
    }
  }
  const selected = nodes.find(node => node.id === id) || nodes[1];
  function access(from, to) {
    const link = links.find(link => link.source === from.id && link.target === to.id);
    if (link) return {status: link.status, label: "配置授权", summary: link.label, scopes: link.scopes, warnings: []};
    const status = from.kind === "hub" ? "unknown" : to.kind === "vless" ? "not_applicable" : from.availability === "disabled" || to.availability === "disabled" ? "inactive" : "denied";
    return {status, label: status === "unknown" ? "未检测" : status === "inactive" ? "已禁用" : status === "not_applicable" ? "不适用" : "未授权", summary: "没有确认可用的配置授权", scopes: [], warnings: []};
  }
  const relations = nodes.filter(node => node.id !== selected.id).map(node => {
    const forward = access(selected, node), reverse = access(node, selected);
    const outbound = ["allowed", "partial"].includes(forward.status), inbound = ["allowed", "partial"].includes(reverse.status);
    return {node, forward, reverse, relation: outbound && inbound ? "mutual" : outbound ? "outbound" : inbound ? "inbound" : "unknown", label: "配置访问关系"};
  });
  return {...original, nodes, selected, selected_id: selected.id, links, relations,
    summary: {nodes: 11, awg: 8, vless: 3, enabled: 10, disabled: 1, pending: 0}, observed_at: new Date().toISOString()};
}

async function session(browser, width = 390, options = {}) {
  const context = await browser.newContext({viewport: {width, height: width < 768 ? 844 : 1000},
    ...(width < 768 ? {isMobile: true, hasTouch: true} : {}), ...options});
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === base.origin) return route.continue();
    report.blocked.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => report.errors.push(error.message));
  await page.goto(new URL("login/", base).href);
  await page.locator('[name="username"]').fill("preview");
  await page.locator('[name="password"]').fill(password);
  await Promise.all([page.waitForURL(new URL('/overview/', base).href), page.locator('button[type="submit"]').click()]);
  if (!preservePreviewFixture) {
    assert.equal((await context.request.get(new URL("__preview__/scenario/rich/", base).href)).status(), 200);
  }
  const navigations = [], requests = [], allRequests = [];
  page.on("request", request => {
    const item = {url: request.url(), method: request.method()};
    allRequests.push(item);
    if (jsonRoute(new URL(item.url))) requests.push(item);
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url());
  });
  await page.goto(topologyURL);
  await hook(page, "root").waitFor();
  if (options.javaScriptEnabled !== false) await assertFixedCenter(page);
  navigations.length = 0;
  return {context, page, navigations, requests, allRequests};
}

async function screenshot(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${label}: page overflow`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({path: path.join(directory, `${label}.png`), fullPage: true, style: captureStyle});
  report.screenshots.push(`${label}.png`);
}

async function choose(page, id) {
  // Native selection is available at every viewing angle.
  await hook(page, "select").selectOption(id);
}

async function openViewTools(page) {
  if (!await hook(page, "view-options").evaluate(details => details.open)) await hook(page, "view-options").locator("summary").click();
}

async function closeViewTools(page) {
  if (await hook(page, "view-options").evaluate(details => details.open)) await hook(page, "view-options").locator("summary").click();
}

async function mode(page, name) {
  await page.locator(`button[data-topology-mode="${name}"]`).click();
  await settleGraph(page);
}

async function direction(page, name) {
  await page.locator(`[data-topology-direction="${name}"]`).click();
  await settleGraph(page);
}

async function selectionSettled(page, id) {
  // A fresh selection can be a local 30-second cache hit. Check the applied
  // model, not merely the native select value (which changes before a fetch).
  await page.waitForFunction(id => {
    const root = document.querySelector("[data-topology-root]");
    return !root.hasAttribute("aria-busy") && document.querySelector("[data-topology-select]").value === id
      && root.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode === id
      && root.querySelector('[data-topology-mode="relations"]').getAttribute("aria-pressed") === "true"
      && document.querySelector("[data-topology-status]").dataset.state !== "error";
  }, id);
  await settleGraph(page);
}

async function selectAndWait(page, id) {
  await choose(page, id);
  await selectionSettled(page, id);
}

async function assertGraph(page, expectedLinks = null, expectedRelations = null) {
  // Read geometry and metadata atomically while pointer movement can redraw.
  const value = await hook(page, "graph").evaluate(graph => {
    const nodeElements = [...graph.querySelectorAll("[data-topology-node]")];
    const edgeElements = [...graph.querySelectorAll("[data-topology-edge]")].filter(edge => getComputedStyle(edge.closest("[data-topology-link]") || edge).display !== "none");
    const nodes = nodeElements.map(node => ({id: node.dataset.topologyNode, tag: node.tagName, pressed: node.getAttribute("aria-pressed"),
      peer: node.dataset.topologyPeer || null, classPeer: node.classList.contains("is-peer"), related: node.classList.contains("is-related"),
      kind: node.classList.contains("kind-awg") ? "awg" : node.classList.contains("kind-vless") ? "vless" : "hub",
      typeColor: getComputedStyle(node.querySelector(".topology-node-state")).color,
      x: Number(node.dataset.worldX), y: Number(node.dataset.worldY)}));
    const selectedId = document.querySelector("[data-topology-select]").value;
    const edges = edgeElements.map(edge => ({tag: edge.tagName.toLowerCase(), source: edge.dataset.source, target: edge.dataset.target,
      key: edge.dataset.linkKey, dash: getComputedStyle(edge).strokeDasharray, marker: edge.getAttribute("marker-end"),
      reverseMarker: edge.getAttribute("marker-start"), flow: edge.dataset.topologyFlow || null, bidirectional: edge.dataset.bidirectional === "true"}));
    const spokes = [...graph.querySelectorAll("[data-topology-spoke]")].map(line => {
      const style = getComputedStyle(line);
      return {source: line.dataset.source, target: line.dataset.target, dash: style.strokeDasharray, stroke: style.stroke,
        opacity: Number(style.opacity), width: parseFloat(style.strokeWidth), display: style.display,
        route: line.dataset.topologyRoute || null, classRoute: line.classList.contains("is-route"), permission: line.classList.contains("has-permission"),
        routeEnd: line.dataset.topologyRouteEnd || null, routeVia: line.dataset.topologyRouteVia || null, flow: line.dataset.topologyFlow || null,
        kind: line.classList.contains("kind-awg") ? "awg" : line.classList.contains("kind-vless") ? "vless" : null,
        marker: line.getAttribute("marker-end"), reverseMarker: line.getAttribute("marker-start")};
    });
    const options = [...document.querySelector("[data-topology-select]").options];
    return {nodes, selectedId, edges, spokes, options: options.map(option => ({value:option.value, text:option.textContent, disabled:option.disabled, selected:option.selected})),
      flowColors: Object.fromEntries(["inbound", "outbound"].map(flow => [flow, getComputedStyle(document.querySelector(`#topology-flow-arrow-${flow} path`)).stroke])),
      initialLinks: JSON.parse(document.getElementById("topology-data").textContent).links,
      mode: document.querySelector('[data-topology-mode][aria-pressed="true"]')?.dataset.topologyMode,
      direction: document.querySelector('[data-topology-direction][aria-pressed="true"]')?.dataset.topologyDirection};
  });
  const {nodes, selectedId, edges, spokes} = value;
  assert.equal(nodes.filter(node => node.id === "hub").length, 1, "one central VPS");
  assert.ok(nodes.every(node => node.tag === "BUTTON"), "graph nodes are keyboard-operable buttons");
  assert.equal(nodes.length, value.options.filter(option => option.value).length, "every configured node exists in the graph and native selector at once");
  assert.deepEqual(value.options.filter(option => !option.value), [{value:"", text:"选择节点…", disabled:true, selected:value.mode === "overview"}], "the disabled empty option accurately represents no selection");
  assert.ok(nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)), "nodes expose finite layout coordinates");
  assert.deepEqual(nodes.filter(node => node.pressed === "true").map(node => node.id), value.mode === "overview" ? [] : [selectedId], "overview has no selected node; relationship mode has exactly its actual selected node");
  assert.equal(selectedId === "", value.mode === "overview", "overview does not retain a phantom native selection");
  const address = new URL(page.url());
  assert.equal(address.searchParams.get("node"), value.mode === "overview" ? null : selectedId, "the URL reflects only an active node selection");
  assert.equal(address.searchParams.has("format"), false, "the page never retains the JSON-only format parameter");
  const fullDetails = await hook(page, "full-details").evaluate(details => ({hidden:details.hidden, open:details.open}));
  assert.equal(fullDetails.hidden, value.mode === "overview", "complete permissions are hidden without a current selection");
  if (value.mode === "overview") assert.equal(fullDetails.open, false, "canceling selection closes complete permissions");
  assert.notEqual(value.flowColors.inbound, value.flowColors.outbound, "VPS ingress and egress remain visually distinct independently of node types");
  assert.ok(["overview", "relations"].includes(value.mode), "one graph mode is selected");
  assert.ok(["forward", "reverse"].includes(value.direction), "one relationship direction is selected");
  assert.equal(spokes.length, nodes.length - 1, "every graph mode preserves one structural hub spoke per client");
  const ids = new Set(nodes.map(node => node.id));
  for (const line of spokes) {
    assert.ok((line.source === "hub") !== (line.target === "hub"), "structural spokes preserve the complete VPS star without client-to-client lines");
    assert.ok(ids.has(line.source) && ids.has(line.target));
    assert.ok(line.dash && line.dash !== "none" && line.dash !== "0px", "VPS access spokes are dashed");
  }
  const expected = value.mode === "overview" ? [] : (expectedLinks || value.initialLinks).filter(link =>
    value.direction === "forward" ? link.source === selectedId : link.target === selectedId);
  const drawn = expected.filter(link => link.source === "hub" || link.target === "hub");
  const directions = edges.flatMap(edge => edge.bidirectional ? [[edge.source, edge.target].join("→"), [edge.target, edge.source].join("→")] : [[edge.source, edge.target].join("→")]);
  assert.deepEqual(directions.sort(), drawn.map(edge => [edge.source, edge.target].join("→")).sort(),
    "only confirmed selected-direction permissions involving the VPS have arrows; leaf-to-leaf paths are not mounted");
  const peers = expected.map(link => value.direction === "forward" ? link.target : link.source).sort();
  const routeIds = new Set(expected.length ? [...peers, selectedId].filter(id => id !== "hub") : []);
  for (const spoke of spokes) {
    const leaf = nodes.find(node => node.id === spoke.source);
    assert.notEqual(spoke.display, "none", "structural spokes retain one DOM entry per node instead of deleting unknown connections");
    assert.equal(spoke.kind, leaf.kind, "each access spoke retains the leaf's AWG/VLESS identity");
    const isRoute = routeIds.has(spoke.source);
    const expectedRole = isRoute ? spoke.source === selectedId ? "selected" : "peer" : null;
    assert.equal(spoke.classRoute, isRoute, "only the selected node and confirmed directional peers have a highlighted VPS access segment");
    assert.equal(spoke.route, expectedRole, "route role is cleared in overview, no-access, unknown, disabled and unrelated cases");
    const hasArrow = drawn.some(link => link.source === spoke.source || link.target === spoke.source);
    assert.equal(spoke.permission, hasArrow, "a spoke yields to a real arrow only when the configured VPS permission actually exists");
    const isDestination = isRoute && !hasArrow && (value.direction === "forward" ? expectedRole === "peer" : expectedRole === "selected");
    const viaHub = isRoute && !hasArrow && (value.direction === "forward" ? expectedRole === "selected" : expectedRole === "peer");
    const flow = !isRoute ? null : (value.direction === "forward" ? expectedRole === "selected" : expectedRole === "peer") ? "inbound" : "outbound";
    assert.equal(Boolean(spoke.marker), viaHub, "An authorized source receives a source-to-VPS transit arrow in either viewing direction");
    assert.equal(spoke.routeVia, viaHub ? "hub" : null, "Transit direction is not mislabeled as a hub permission or final destination");
    assert.equal(Boolean(spoke.reverseMarker), isDestination, "only the actual accessed leaf receives an endpoint arrow, never the source, unknown or unrelated nodes");
    assert.equal(spoke.routeEnd, isDestination ? spoke.source : null, "the endpoint marker identifies the actual accessed leaf and is cleared on every mode/direction switch");
    assert.equal(spoke.flow, flow, "related spokes expose their exact physical direction even when a real permission replaces their paint");
    if (viaHub) assert.equal(spoke.marker, "url(#topology-flow-arrow-inbound)");
    if (isDestination) assert.equal(spoke.reverseMarker, "url(#topology-flow-arrow-outbound)");
    if (hasArrow) assert.equal(spoke.opacity, 0, "one genuine VPS authorization is not drawn twice as an overlapping access segment");
    else if (isRoute) {
      assert.ok(spoke.opacity >= .8 && spoke.width >= 1.8, "confirmed path access segments remain visually distinct from background structure");
      assert.equal(spoke.stroke, value.flowColors[flow], "highlighted access segments use physical flow color rather than the leaf's identity color");
    } else if (value.mode === "relations") assert.ok(spoke.opacity <= .2, "unrelated structural spokes stay quiet instead of implying confirmed reachability");
  }
  assert.deepEqual(nodes.filter(node => node.classPeer).map(node => node.id).sort(), peers,
    "leaf-to-leaf permissions still receive peer frames even though their crossing paths are absent");
  assert.deepEqual(nodes.filter(node => node.peer).map(node => node.id).sort(), peers);
  assert.ok(nodes.filter(node => node.peer).every(node => node.peer === (value.direction === "forward" ? "outbound" : "inbound")));
  assert.deepEqual(nodes.filter(node => node.related).map(node => node.id).sort(), [...new Set(expected.flatMap(link => [link.source, link.target]))].sort(),
    "related-node highlighting uses all selected permissions, not just the remaining VPS arrows");
  if (value.mode === "relations") {
    const summary = await hook(page, "canvas-summary").textContent();
    if (selectedId === "hub" && value.direction === "forward") assert.match(summary, /VPS 主动访问未检测/,
      "VPS-origin reachability is explicitly untested, not presented as denied or confirmed access");
    else assert.match(summary, new RegExp(`当前方向 ${expected.length} 条授权`),
      "the canvas counts every authorization, including invisible leaf-to-leaf paths");
  }
  await assertInlinePorts(page, expectedLinks || value.initialLinks, selectedId, value.direction, value.mode === "overview");
  for (const edge of edges) {
    assert.equal(edge.tag, "path");
    assert.ok(edge.dash && edge.dash !== "none" && edge.dash !== "0px", "permission links are dashed");
    assert.ok(edge.marker, "every permission path has a directional arrow");
    assert.ok(edge.source === "hub" || edge.target === "hub", "no leaf-to-leaf permission path survives");
    assert.equal(edge.bidirectional, false, "a single-direction inspection must not imply a reverse permission");
    const flow = edge.target === "hub" ? "inbound" : "outbound";
    assert.equal(edge.flow, flow, "a real hub authorization keeps its physical traffic direction");
    assert.equal(edge.marker, `url(#topology-flow-arrow-${flow})`);
    assert.equal(edge.reverseMarker, null, "a real authorization is never duplicated into a two-ended arrow");
    const link = expected.find(link => link.source === edge.source && link.target === edge.target);
    assert.ok(link, "every drawn edge exists in the configured selected direction");
  }
  assert.equal(await hook(page, "direction").first().isVisible(), value.mode === "relations", "direction control is shown only while inspecting relationships");
  assert.equal(await hook(page, "focus").count(), 0, "the old all-edge focus checkbox is removed");
  assert.equal(await page.locator("[data-topology-prev], [data-topology-next], [data-topology-page]").count(), 0, "graph has no pagination");
  if (value.mode === "relations") {
    const inspector = hook(page, "inspector");
    assert.equal(await inspector.evaluate(node => node.tagName), "ASIDE", "inspector is an accessible complementary region");
    assert.equal(await inspector.isVisible(), true);
    const contents = await inspector.innerText();
    for (const link of expected) for (const scope of link.scopes) assert.ok(contents.includes(scope), "inspector preserves every exact configured protocol/port scope");
    const rows = await inspector.locator("[data-topology-access-target]").evaluateAll(items => items.map(item => ({id: item.dataset.topologyAccessTarget,
      status: item.dataset.topologyAccessStatus, summary: item.querySelector(".topology-access-note")?.textContent || "",
      scopes: [...item.querySelectorAll(".topology-access-scopes li")].map(scope => scope.textContent)})));
    const sort = items => items.sort((a, b) => a.id.localeCompare(b.id));
    if (selectedId === "hub" && value.direction === "forward") {
      assert.deepEqual(rows.map(row => row.id).sort(), nodes.filter(node => node.id !== "hub").map(node => node.id).sort(), "VPS outbound inspection includes every target, even unconfirmed or inapplicable ones");
      assert.ok(rows.every(row => ["allowed", "partial", "unknown", "not_applicable", "inactive", "denied"].includes(row.status) && row.summary), "every VPS target retains an explicit status and explanation");
      if (expectedRelations) assert.deepEqual(sort(rows.map(({id,status,summary}) => ({id,status,summary}))), sort(expectedRelations.map(relation => ({id:relation.node.id, status:relation.forward.status, summary:relation.forward.summary}))), "VPS outbound details preserve exact backend facts without promoting unknown reachability to access");
    } else assert.deepEqual(sort(rows.map(({id,scopes}) => ({id,scopes}))), sort(expected.map(link => ({id: value.direction === "forward" ? link.target : link.source, scopes: link.scopes}))),
      "inspector contains only the correct endpoint and complete exact scopes for the selected direction");
  }
}

async function assertRouteArrowheads(page) {
  const arrows = await hook(page, "graph").evaluate(graph => {
    const scale = Number(graph.dataset.viewportScale);
    return [...graph.querySelectorAll("[data-topology-spoke][marker-start]")].map(line => {
      const markerId = line.getAttribute("marker-start").match(/#([^)]*)\)/)?.[1];
      const marker = markerId && document.getElementById(markerId), path = marker?.querySelector("path");
      const node = [...graph.querySelectorAll("[data-topology-node]")].find(node => node.dataset.topologyNode === line.dataset.source);
      if (!marker || !path || !node) return {missing: true};
      const box = node.getBoundingClientRect(), matrix = line.getScreenCTM();
      const start = line.getPointAtLength(0), end = line.getPointAtLength(line.getTotalLength());
      const tip = path.getPointAtLength(path.getTotalLength() / 2), left = path.getPointAtLength(0), right = path.getPointAtLength(path.getTotalLength());
      const ref = {x: Number(marker.getAttribute("refX")), y: Number(marker.getAttribute("refY"))};
      // auto-start-reverse rotates the marker's forward vector away from the
      // line's leaf→hub tangent. Measure that vector against the actual leaf.
      const angle = Math.atan2(end.y - start.y, end.x - start.x) + Math.PI;
      const rotate = (x, y) => ({x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle)});
      const tipOffset = rotate(tip.x - ref.x, tip.y - ref.y), worldTip = new DOMPoint(start.x + tipOffset.x, start.y + tipOffset.y);
      const screenTip = worldTip.matrixTransform(matrix), direction = rotate(tip.x - (left.x + right.x) / 2, tip.y - (left.y + right.y) / 2);
      const toward = {x: box.left + box.width / 2 - screenTip.x, y: box.top + box.height / 2 - screenTip.y};
      return {id: line.dataset.source, routeEnd: line.dataset.topologyRouteEnd, scale,
        orient: marker.getAttribute("orient"), units: marker.getAttribute("markerUnits"),
        width: Number(marker.getAttribute("markerWidth")), height: Number(marker.getAttribute("markerHeight")),
        tip: {x: tip.x, y: tip.y}, ref, color: getComputedStyle(path).stroke, flow:line.dataset.topologyFlow,
        lineColor:getComputedStyle(line).stroke, markerId, markerClasses:[...path.classList],
        cosine: (direction.x * toward.x + direction.y * toward.y) / (Math.hypot(direction.x, direction.y) * Math.hypot(toward.x, toward.y)),
        gap: Math.max(box.left - screenTip.x, screenTip.x - box.right, box.top - screenTip.y, screenTip.y - box.bottom)};
    });
  });
  for (const arrow of arrows) {
    assert.ok(!arrow.missing, "each access endpoint resolves to a real marker and leaf card");
    assert.equal(arrow.routeEnd, arrow.id);
    assert.equal(arrow.orient, "auto-start-reverse", "a start marker points back toward the accessed leaf, not toward the VPS");
    assert.equal(arrow.units, "userSpaceOnUse", "endpoint arrows use world units and scale with the complete graph");
    assert.equal(arrow.width, 10); assert.equal(arrow.height, 10);
    assert.ok(Math.abs(arrow.tip.x - arrow.ref.x) < .01 && Math.abs(arrow.tip.y - arrow.ref.y) < .01, "the marker tip is anchored to the line's leaf endpoint");
    assert.ok(arrow.cosine > .99, `${arrow.id}: arrowhead actually points toward the destination card`);
    assert.equal(arrow.flow, "outbound");
    assert.equal(arrow.markerId, "topology-flow-arrow-outbound");
    assert.ok(arrow.markerClasses.includes("topology-flow-arrow") && arrow.markerClasses.includes("flow-outbound"));
    assert.equal(arrow.color, arrow.lineColor, "the destination arrow and its VPS egress segment share the same flow color");
    assert.ok(arrow.gap >= 5 * arrow.scale && arrow.gap <= 9 * arrow.scale,
      `${arrow.id}: arrow tip stays 7 world px outside the actual card (${arrow.gap}px at ${arrow.scale}×)`);
  }
}

async function assertReadOnly(session) {
  assert.deepEqual(session.navigations, [], "graph interaction must not navigate");
  assert.ok(session.allRequests.every(request => request.method === "GET"), "topology and live telemetry only send read-only GET requests");
  const contents = await hook(session.page, "root").innerHTML();
  assert.doesNotMatch(contents, /synthetic-preview-exit-secret|Preview-only-2026|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|vless:\/\//);
  const storage = await session.page.evaluate(() => JSON.stringify({local: {...localStorage}, session: {...sessionStorage}}));
  assert.doesNotMatch(storage, /synthetic-preview-exit-secret|Preview-only-2026/);
}

async function viewState(page) {
  return {
    selected: await hook(page, "select").inputValue(),
    url: page.url(),
    pressed: await hook(page, "node").evaluateAll(nodes => nodes.filter(node => node.getAttribute("aria-pressed") === "true").map(node => node.dataset.topologyNode)),
    fullDetails: await hook(page, "full-details").evaluate(details => ({hidden:details.hidden,open:details.open})),
    options: await hook(page, "select").locator("option").allTextContents(),
    // Live rate/state text is allowed to update while the configuration model
    // stays unchanged. Strip only those separately tested telemetry spans.
    nodes: await hook(page, "node").evaluateAll(nodes => nodes.map(node => { const clone = node.cloneNode(true); clone.querySelectorAll("[data-telemetry-status], [data-telemetry-rates]").forEach(item => item.remove()); return clone.textContent; })),
    details: await hook(page, "details").evaluate(node => { const clone = node.cloneNode(true); clone.querySelectorAll("[data-telemetry-status], [data-telemetry-rates]").forEach(item => item.remove()); return clone.textContent; }),
    inspector: await hook(page, "inspector").textContent(),
    mode: await page.locator('[data-topology-mode][aria-pressed="true"]').getAttribute("data-topology-mode"),
    direction: await page.locator('[data-topology-direction][aria-pressed="true"]').getAttribute("data-topology-direction"),
    graph: await layoutState(page),
  };
}

async function layoutState(page) {
  return hook(page, "graph").evaluate(graph => ({
    positions: [...graph.querySelectorAll("[data-topology-node]")].map(node => ({id: node.dataset.topologyNode,
      x: Number(node.dataset.worldX), y: Number(node.dataset.worldY)})),
    viewport: {x: Number(graph.dataset.viewportX), y: Number(graph.dataset.viewportY), scale: Number(graph.dataset.viewportScale)},
    edges: [...graph.querySelectorAll("[data-topology-edge]")].map(edge => ({key: edge.dataset.linkKey, path: edge.getAttribute("d")})),
    spokes: [...graph.querySelectorAll("[data-topology-spoke]")].map(spoke => ({source: spoke.dataset.source, target: spoke.dataset.target,
      x1: spoke.getAttribute("x1"), y1: spoke.getAttribute("y1"), x2: spoke.getAttribute("x2"), y2: spoke.getAttribute("y2")})),
    ports: [...graph.querySelectorAll(".topology-node-port")].map(port => ({id: port.closest("[data-topology-node]").dataset.topologyNode,
      scope: port.dataset.topologyScope, text: port.textContent})),
  }));
}

async function settleGraph(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function fixedSnapshot(page) {
  return hook(page, "graph").evaluate(graph => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return {width: box.width, height: box.height, x: box.left + box.width / 2, y: box.top + box.height / 2};
    };
    const visible = element => element && !element.closest("[hidden]") && element.getClientRects().length;
    const nodes = [...graph.querySelectorAll("[data-topology-node]")].map(node => ({id: node.dataset.topologyNode,
      world: {x: Number(node.dataset.worldX), y: Number(node.dataset.worldY)}, box: rect(node),
      local: {width: node.offsetWidth, height: node.offsetHeight},
      text: [...node.querySelectorAll("strong, .topology-node-state, .topology-node-port, .topology-node-rates, .topology-node-selected, .topology-node-peer")]
        .filter(visible).map(element => ({kind: element.className || "name", box: rect(element), font: parseFloat(getComputedStyle(element).fontSize)})),
      scopes: [...node.querySelectorAll(".topology-node-port")].map(port => port.dataset.topologyScope),
    }));
    const edges = [...graph.querySelectorAll("[data-topology-edge], [data-topology-spoke]")].map(edge => {
      const matrix = edge.getScreenCTM(), scale = Math.hypot(matrix.a, matrix.b), style = getComputedStyle(edge);
      const point = offset => { const value = edge.getPointAtLength(offset).matrixTransform(matrix); return {x: value.x, y: value.y}; };
      return {id: `${edge.hasAttribute("data-topology-edge") ? "permission" : "spoke"}:${edge.dataset.source}→${edge.dataset.target}`,
        scale, vectorEffect: style.vectorEffect, stroke: parseFloat(style.strokeWidth), dash: style.strokeDasharray,
        markerStart: edge.getAttribute("marker-start"), markerEnd: edge.getAttribute("marker-end"), routeEnd: edge.dataset.topologyRouteEnd || null,
        length: edge.getTotalLength() * scale, start: point(0), end: point(edge.getTotalLength())};
    });
    const markers = [...graph.querySelectorAll("marker")].map(marker => ({id: marker.id,
      width: Number(marker.getAttribute("markerWidth")), height: Number(marker.getAttribute("markerHeight")), units: marker.getAttribute("markerUnits")}));
    return {scale: Number(graph.dataset.viewportScale), nodes, edges, markers};
  });
}


async function readabilitySnapshot(page) {
  const inline = await inlineSnapshot(page);
  const metrics = await hook(page, "graph").evaluate(graph => {
    const canvas = graph.getBoundingClientRect();
    const visible = node => node.getClientRects().length && getComputedStyle(node.closest("[data-topology-link]") || node).display !== "none";
    const names = [...graph.querySelectorAll("[data-topology-node] strong")].map(node => ({text: node.textContent, rect: node.getBoundingClientRect(), font: parseFloat(getComputedStyle(node).fontSize)}));
    const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return {nodes: names.length, displayedPermissionPaths: [...graph.querySelectorAll("[data-topology-edge]")].filter(visible).length,
      namesOverlapping: names.flatMap((a, i) => names.slice(i + 1).filter(b => area(a.rect, b.rect) > 4).map(b => [a.text, b.text])),
      nodeNameFont: Math.min(...names.map(node => node.font)),
      canvasTopAtPageStart: Math.round(canvas.top + scrollY), canvasHeight: Math.round(canvas.height), viewportHeight: innerHeight,
      controlsAboveCanvas: [...document.querySelectorAll("[data-topology-root] button, [data-topology-root] input, [data-topology-root] select")]
        // Orbit controls are display actions, tested separately in the spatial suite.
        .filter(node => !node.matches("[data-topology-orbit]") && node.getClientRects().length && !node.closest("details:not([open])") && node.getBoundingClientRect().bottom <= canvas.top).length};
  });
  const lines = inline.nodes.flatMap(node => node.ports.lines);
  return {...metrics, geometryFindings: geometryFindings(inline), floatingLabels: inline.floating,
    inlinePortFont: lines.length ? Math.min(...lines.map(line => line.font)) : null};
}

async function setTheme(page, width, theme) {
  if (width <= 900) await page.locator("[data-mobile-menu] > summary").click();
  await page.locator(`[data-theme-value="${theme}"]:visible`).first().click();
  if (width <= 900) await page.locator("[data-mobile-menu-close]").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
}

async function readabilityAudit(browser, label) {
  for (const width of [320, 390, 768, 1440]) {
    const state = await session(browser, width);
    const {page, context} = state;
    try {
      const original = await (await context.request.get(topologyURL + "?format=json")).json();
      for (const count of [6, 12]) {
        let model = original;
        if (count === 12) {
          model = realisticModel(original);
          assert.equal(model.nodes.length, 12);
          assert.equal(model.links.length, 46, "realistic scene reproduces twelve nodes and forty-six directed permissions");
          await page.route(jsonRoute, route => {
            const id = new URL(route.request().url()).searchParams.get("node");
            return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(realisticModel(original, id))});
          });
          await mode(page, "overview");
          await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
          await page.waitForFunction(() => document.querySelectorAll("[data-topology-node]").length === 12);
          await openViewTools(page);
          await hook(page, "reset").click();
          await hook(page, "view-options").locator("summary").click();
        }
        await settleGraph(page);
        await mode(page, "overview");
        await assertGraph(page, model.links);
        const cachedName = await hook(page, "details").locator("h2").first().textContent();
        const selected = model.nodes.find(node => node.name === cachedName)?.id;
        assert.ok(selected, "the retained complete details identify the last applied cached model without a phantom selected card");
        const before = await layoutState(page), requestsBefore = state.requests.length;
        // The last model stays cached, but overview has no visually selected node.
        await page.locator(`[data-topology-node="${selected}"]`).click();
        await settleGraph(page);
        await selectionSettled(page, selected);
        assert.equal(await page.locator('button[data-topology-mode="relations"]').getAttribute("aria-pressed"), "true", "clicking the cached node reenters relationships from an unselected overview");
        assert.equal(state.requests.length, requestsBefore, "cached inspection is local");
        await mode(page, "overview");
        assert.deepEqual((await layoutState(page)).positions, before.positions, "mode switch does not rearrange nodes");
        assert.deepEqual((await layoutState(page)).viewport, before.viewport, "mode switch does not move the camera");
        assert.equal(await hook(page, "select").inputValue(), "", "returning to overview clears visible selection while retaining the reusable model");
        assert.equal(state.requests.length, requestsBefore, "overview return needs no fetch");
        const target = model.nodes.find(node => node.kind === "awg" && model.links.some(link => link.source === node.id && link.target !== "hub"));
        assert.ok(target, "readability scene includes client-to-client permissions");
        for (const theme of ["light", "dark"]) {
          await setTheme(page, width, theme);
          for (const stateName of ["overview", "forward", "reverse"]) {
            if (stateName === "overview") await mode(page, "overview");
            else {
              await selectAndWait(page, target.id);
              await direction(page, stateName);
            }
            await assertGraph(page, model.links);
            await settleGraph(page);
            const metrics = await readabilitySnapshot(page);
            report.readability.push({browser: label, width, theme, state: stateName, configuredDirections: model.links.length, ...metrics});
            const name = `${label}-${width}-${count}-node-${stateName}-${theme}.png`;
            await page.evaluate(() => document.activeElement?.blur());
            await page.locator(".topology-panel").screenshot({path: path.join(directory, name), style: captureStyle});
            report.screenshots.push(name);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "realistic topology never overflows the page horizontally");
            assert.deepEqual(metrics.geometryFindings, [], `${name}: fitted cards never overlap or clip and inline ports remain within their own rows`);
            await assertCardEdges(page);
            assert.equal(metrics.floatingLabels, 0);
            assert.deepEqual(metrics.namesOverlapping, [], `${name}: node names must not overlap`);
            assert.ok(metrics.nodeNameFont >= 13, `${name}: node names must be at least 13px, not tiny diagram captions`);
            if (metrics.inlinePortFont !== null) assert.ok(metrics.inlinePortFont >= 12, `${name}: inline protocol/port text must be at least 12px`);
            if (stateName === "overview") {
              assert.equal(metrics.displayedPermissionPaths, 0);
              assert.ok(metrics.controlsAboveCanvas <= (width < 768 ? 6 : 5), "default overview keeps secondary controls closed; touch devices additionally retain the explicit layout-mode escape control");
              if (width <= 390) assert.ok(metrics.canvasTopAtPageStart < 700, "mobile overview exposes the canvas in the first viewport");
            } else {
              const scopeMetrics = await page.locator(".topology-access-scopes li").evaluateAll(items => items.map(item => ({font: parseFloat(getComputedStyle(item).fontSize), overflow: item.scrollWidth > item.clientWidth + 1})));
              const configured = model.links.filter(link => stateName === "forward" ? link.source === target.id : link.target === target.id);
              assert.equal(scopeMetrics.length, configured.reduce((total, link) => total + link.scopes.length, 0), "inspector shows exactly the complete scope entries for this permitted direction");
              assert.ok(scopeMetrics.every(scope => scope.font >= 13 && !scope.overflow), "inspector scopes are readable and wrap within the available width");
            }
          }
        }
        const beforeDirectionChange = state.requests.length;
        await direction(page, "reverse");
        await selectAndWait(page, "hub");
        assert.equal(await page.locator('[data-topology-direction="reverse"]').getAttribute("aria-pressed"), "true", "changing selection preserves the user's chosen direction");
        assert.ok(state.requests.length <= beforeDirectionChange + 1, "direction changes are local; only selection may fetch");
      }
      await assertReadOnly(state);
      report.checks.push(`${label} ${width}: six-node and realistic twelve-node/46-direction scenes, overview and both selected directions, complete inspector, readable type and collision-free inline ports in light and dark appearances`);
    } finally { await context.close(); }
  }
}

async function layerSmoke(browser, label) {
  // Keep the historic --layer-smoke entry point while checking the new design.
  for (const width of [320, 1440]) await inlineScopeScenario(browser, label, width);
}

async function dragAccessEndpointFixed(state, label, endpointId, links) {
  const {page, requests} = state;
  await setLayoutEditing(page, true);
  const node = page.locator(`[data-topology-node="${endpointId}"]`);
  const visiblePoint = () => node.evaluate(node => {
    const box = node.getBoundingClientRect();
    for (const fy of [.5,.15,.85,.3,.7,.05,.95]) for (const fx of [.5,.15,.85,.3,.7,.05,.95]) {
      const point = {x:box.x + box.width * fx, y:box.y + box.height * fy};
      if (document.elementFromPoint(point.x,point.y)?.closest("[data-topology-node]") === node) return point;
    }
    return null;
  });
  await node.scrollIntoViewIfNeeded();
  assert.ok(await visiblePoint(), "the actual destination card has a genuinely exposed hit-testable point before fixed-scale endpoint drag");
  const beforeZoom = await fixedSnapshot(page);
  // Magnification is intentionally removed; focus must preserve the center.
  await node.focus();
  await node.scrollIntoViewIfNeeded();
  await settleGraph(page);
  assert.equal((await fixedSnapshot(page)).scale, beforeZoom.scale);
  await assertFixedCenter(page);
  await assertGraph(page, links);
  await assertRouteArrowheads(page);
  await assertCardEdges(page);
  const before = await layoutState(page), oldPosition = before.positions.find(item => item.id === endpointId);
  const selected = await hook(page, "select").inputValue(), requestCount = requests.length, scroll = await page.evaluate(() => scrollY);
  const box = await node.boundingBox(), start = await visiblePoint();
  assert.ok(start, `${label}: a visible portion of the native-size destination remains available to drag under real depth ordering`);
  assert.equal(await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.closest("[data-topology-node]")?.dataset.topologyNode, start), endpointId,
    `${label}: the native-size destination card is the actual hit target at the drag point`);
  await dragPoint(page, start, {x: start.x + 14, y: start.y + 10});
  const after = await layoutState(page), position = after.positions.find(item => item.id === endpointId), afterBox = await node.boundingBox();
  const screen = {x: afterBox.x + afterBox.width / 2 - (box.x + box.width / 2), y: afterBox.y + afterBox.height / 2 - (box.y + box.height / 2)};
  for (const axis of ["x", "y"]) {
    assert.ok(Math.abs(screen[axis] - (position[axis] - oldPosition[axis]) * before.viewport.scale) < .15, "dragging a native-size destination respects screen = projected coordinates at scale 1");
    assert.ok(Math.abs(screen[axis] - ({x: 14, y: 10})[axis]) < 1.5,
      `${label}: the destination card tracks the pointer at native scale (${axis}: ${screen[axis]}, scale ${before.viewport.scale})`);
  }
  assert.deepEqual(after.viewport, before.viewport, "dragging an arrow endpoint preserves the fixed view");
  assert.deepEqual(after.positions.filter(item => item.id !== endpointId), before.positions.filter(item => item.id !== endpointId), "other cards do not move with the endpoint");
  assert.deepEqual(after.ports, before.ports, "dragging the accessed node preserves exact configured port scopes");
  assert.notDeepEqual(after.spokes.find(item => item.source === endpointId), before.spokes.find(item => item.source === endpointId), "the destination arrow's structural segment follows the dragged card");
  assert.equal(await hook(page, "select").inputValue(), selected, "endpoint drag never switches the current permission direction");
  assert.equal(requests.length, requestCount, "endpoint drag is local and does not refresh permissions");
  assert.equal(await page.evaluate(() => scrollY), scroll, "layout editing captures the drag without scrolling the page");
  await assertGraph(page, links);
  await assertRouteArrowheads(page);
  await assertCardEdges(page);
  const name = `${label}-fixed-scale-destination-drag.png`;
  await hook(page, "graph").screenshot({path: path.join(directory, name), style: captureStyle});
  report.screenshots.push(name);
  await setLayoutEditing(page, false);
}

async function accessRouteScenarios(browser, label) {
  const state = await session(browser, 390);
  const {page, context} = state;
  try {
    const original = await (await context.request.get(topologyURL + "?format=json")).json();
    const fixture = realisticModel(original);
    const source = fixture.nodes.find(node => node.kind === "vless" && node.availability === "enabled");
    const target = fixture.nodes.find(node => node.kind === "awg");
    const disabled = fixture.nodes.find(node => node.availability === "disabled");
    const link = destination => ({source: source.id, target: destination, status: "partial", label: "TCP · 22", scopes: ["TCP · 22"]});
    let links = [];
    const modelFor = id => {
      const model = realisticModel(original, id), selected = model.selected;
      const access = (from, to) => {
        const permission = links.find(item => item.source === from.id && item.target === to.id);
        if (permission) return {status: "partial", label: "配置授权", summary: permission.label, scopes: permission.scopes, warnings: []};
        const status = from.kind === "hub" ? "unknown" : from.availability === "disabled" || to.availability === "disabled" ? "inactive" : to.kind === "vless" ? "not_applicable" : "denied";
        return {status, label: "未确认授权", summary: "无已确认配置授权", scopes: [], warnings: []};
      };
      return {...model, links, relations: model.nodes.filter(node => node.id !== selected.id).map(node => {
        const forward = access(selected, node), reverse = access(node, selected);
        const out = forward.status === "partial", incoming = reverse.status === "partial";
        return {node, forward, reverse, relation: out && incoming ? "mutual" : out ? "outbound" : incoming ? "inbound" : "unknown", label: "配置访问关系"};
      })};
    };
    await page.route(jsonRoute, route => route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify(modelFor(new URL(route.request().url()).searchParams.get("node")))}));
    for (const scenario of [
      {name: "leaf-only", selected: source.id, direction: "forward", links: [link(target.id)], routes: 2, arrows: 0, endpoints: [target.id], via: [source.id]},
      {name: "hub-only", selected: source.id, direction: "forward", links: [link("hub")], routes: 1, arrows: 1, endpoints: []},
      {name: "reverse-leaf", selected: target.id, direction: "reverse", links: [link(target.id)], routes: 2, arrows: 0, endpoints: [target.id], via: [source.id]},
      {name: "reverse-hub", selected: "hub", direction: "reverse", links: [link("hub")], routes: 1, arrows: 1, endpoints: []},
      {name: "hub-unknown", selected: "hub", direction: "forward", links: [link(target.id)], routes: 0, arrows: 0, endpoints: []},
      {name: "disabled", selected: disabled.id, direction: "forward", links: [link(target.id)], routes: 0, arrows: 0, endpoints: []},
    ]) {
      links = scenario.links;
      await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
      await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
      await selectAndWait(page, scenario.selected);
      await direction(page, scenario.direction);
      await assertFixedCenter(page);
      await assertGraph(page, links, modelFor(scenario.selected).relations);
      assert.equal(await hook(page, "graph").locator("[data-topology-spoke].is-route").count(), scenario.routes);
      assert.equal(await hook(page, "edge").count(), scenario.arrows);
      assert.deepEqual(await page.locator("[data-topology-route-end]").evaluateAll(lines => lines.map(line => line.dataset.topologyRouteEnd).sort()), scenario.endpoints,
        "only actual accessed leaf endpoints gain route arrows; a hub authorization keeps its existing single arrow");
      assert.deepEqual(await page.locator("[data-topology-route-via]").evaluateAll(lines => lines.map(line => line.dataset.source).sort()), scenario.via || [],
        "Every authorized leaf source gains a transit arrow without inventing or duplicating a hub authorization");
      await assertCardEdges(page);
      await assertRouteArrowheads(page);
      await assertMarkerGeometry(page);
      const name = `${label}-390-access-route-${scenario.name}.png`;
      await hook(page, "graph").screenshot({path: path.join(directory, name), style: captureStyle});
      report.screenshots.push(name);
      if (scenario.endpoints.length) {
        await dragAccessEndpointFixed(state, `${label}-390-${scenario.name}`, scenario.endpoints[0], links);
        await direction(page, scenario.direction === "forward" ? "reverse" : "forward");
        await assertGraph(page, links);
        assert.equal(await page.locator("[data-topology-route-end], [data-topology-spoke][marker-start], [data-topology-spoke][marker-end]").count(), 0,
          "switching to an unconfigured opposite direction removes stale endpoint arrows instead of inventing reverse access");
      }
      await mode(page, "overview");
      await assertGraph(page, links);
      assert.equal(await hook(page, "graph").locator("[data-topology-route], [data-topology-route-end], [data-topology-route-via], [data-topology-spoke][marker-start], [data-topology-spoke][marker-end], .has-permission").count(), 0, "overview clears every route, transit/terminal marker and duplicate-arrow suppression state");
    }
    await assertReadOnly(state);
    report.checks.push(`${label}: reverse sources show their source-to-VPS transit plus the actual destination arrow; forward destinations and hub-only single permissions retain correct geometry; opposite/unknown/disabled/overview clear all stale arrows`);
  } finally { await context.close(); }
}

async function inlineScopeScenario(browser, label, width) {
  const state = await session(browser, width);
  const {page, context} = state;
  try {
    const original = await (await context.request.get(topologyURL + "?format=json")).json();
    // A UI-only fixture covers future multi-scope responses, independent of the
    // real backend projection checked by run_topology_permissions_ui.cjs.
    const scopes = ["TCP · 22, 443, 445, 8000-8010, 9000-9090, 10000-11000", "UDP · 53, 123", "ICMP · 全部端口", "TCP · 22000-24000"];
    const model = realisticModel(original, undefined, scopes);
    await page.route(jsonRoute, route => route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify(realisticModel(original, new URL(route.request().url()).searchParams.get("node"), scopes))}));
    await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
    await page.waitForFunction(() => document.querySelectorAll("[data-topology-node]").length === 12);
    await openViewTools(page);
    await hook(page, "reset").click();
    await closeViewTools(page);
    await selectAndWait(page, model.nodes[1].id);
    await direction(page, "forward");
    await setTheme(page, width, "light");
    await assertGraph(page, model.links);
    const inline = await inlineSnapshot(page);
    assert.ok(inline.nodes.some(node => node.ports.lines.some(line => line.clipped)), "long scopes exercise genuine visual ellipsis while retaining complete DOM/title/aria text");
    assert.ok(inline.nodes.some(node => node.ports.more.visible && /另 2 项/.test(node.ports.more.text)), "the additional-scope count is visible inside the card");
    const name = `${label}-${width}-12-node-four-inline-scopes.png`;
    await page.evaluate(() => document.activeElement?.blur());
    await page.locator(".topology-panel").screenshot({path: path.join(directory, name), style: captureStyle});
    report.screenshots.push(name);
    const metrics = await readabilitySnapshot(page);
    assert.deepEqual(metrics.geometryFindings, []);
    await assertCardEdges(page);
    report.readability.push({browser: label, width, state: "four-inline-scopes", ...metrics});
    await direction(page, "reverse");
    await assertGraph(page, model.links);
    assert.deepEqual((await readabilitySnapshot(page)).geometryFindings, []);
    await mode(page, "overview");
    await assertGraph(page, model.links);
    await assertReadOnly(state);
    report.checks.push(`${label} ${width}: twelve-node inline ports retain four full scopes in DOM/title/aria/inspector, ellipsis and extra-count rows never collide, direction and overview clean up ports`);
  } finally { await context.close(); }
}

async function assertLegibleOverview(page, width) {
  await settleGraph(page);
  const inline = await inlineSnapshot(page);
  assert.equal(inline.floating, 0);
  assert.deepEqual(geometryFindings(inline), [], "fitted card contents and neighboring cards never overlap or clip");
  const result = await hook(page, "graph").evaluate(graph => {
    const box = graph.getBoundingClientRect();
    const names = [...graph.querySelectorAll("[data-topology-node] strong")].map(node => ({name: node.textContent, box: node.getBoundingClientRect()}));
    const nodes = [...graph.querySelectorAll("[data-topology-node]")].map(node => node.getBoundingClientRect());
    const overlap = (a, b) => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5;
    return {
      overlappingNames: names.flatMap((a, index) => names.slice(index + 1).filter(b => overlap(a.box, b.box)).map(b => [a.name, b.name])),
      verticalFraction: (Math.max(...nodes.map(node => node.y + node.height / 2)) - Math.min(...nodes.map(node => node.y + node.height / 2))) / box.height,
    };
  });
  assert.deepEqual(result.overlappingNames, [], "default overview does not obscure node names with neighboring cards");
  // Rotation needs clearance around the normalized 3D sphere. Native-size
  // cards and a fixed center replace the deleted fit-to-portrait zoom policy.
  await assertFixedCenter(page);
  assert.equal(inline.scale, 1, "mobile cards retain readable native size instead of shrinking a desktop graph");
}

async function assertControlContrast(page, label, width, theme) {
  const styles = await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll(".topology-content button.secondary-button")].filter(button => button.getClientRects().length && !button.closest("details:not([open])"));
    await Promise.race([
      Promise.all(buttons.flatMap(button => button.getAnimations()).map(animation => animation.finished.catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);
    const rgba = color => { const values = color.match(/[\d.]+/g).map(Number); return [...values.slice(0, 3), values[3] ?? 1]; };
    const composite = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3]));
    const background = element => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) layers.unshift(rgba(getComputedStyle(node).backgroundColor));
      return layers.reduce((color, layer) => composite(layer, color), [255, 255, 255]);
    };
    const luminance = color => {
      const rgb = color.map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    return buttons.map(button => {
      const style = getComputedStyle(button);
      // Selected mode buttons use translucent theme fills; contrast is measured
      // against the composited panel, not the opaque RGB channels of that tint.
      const effectiveBackground = background(button);
      const backgroundLum = luminance(effectiveBackground), foregroundLum = luminance(composite(rgba(style.color), effectiveBackground));
      return {text: button.textContent.trim(), disabled: button.disabled, background: style.backgroundColor, color: style.color,
        effectiveBackground,
        appearance: style.appearance, webkitAppearance: style.webkitAppearance, image: style.backgroundImage,
        backgroundLum, contrast: (Math.max(backgroundLum, foregroundLum) + .05) / (Math.min(backgroundLum, foregroundLum) + .05)};
    });
  });
  assert.ok(styles.length >= 3, "primary topology controls expose themed buttons");
  for (const style of styles) {
    assert.equal(style.appearance, "none", `${label} ${theme} ${style.text}: native appearance must not override the themed background`);
    assert.equal(style.image, "none", `${label} ${theme} ${style.text}: no native background image`);
    if (!style.disabled) assert.ok(style.contrast >= 4.5, `${label} ${theme} ${style.text}: text/background contrast ${style.contrast.toFixed(2)} is too low`);
    if (theme === "dark") assert.ok(style.backgroundLum < .2, `${label}: dark controls must not render a light fill`);
  }
  if (width === 1440) report.controlStyles.push({browser: label, theme, buttons: styles});
}

async function coldMobileLayouts(browser, label) {
  for (const [attempt, options] of [[0, {}], [1, {isMobile: false, hasTouch: false}], [2, {}]]) {
    const {page, context} = await session(browser, 320, options);
    try {
      await assertLegibleOverview(page, 320);
      const name = `${label}-320-cold-${attempt}.png`;
      await hook(page, "graph").screenshot({path: path.join(directory, name), style: captureStyle});
      report.screenshots.push(name);
    } finally { await context.close(); }
  }
  report.checks.push(`${label}: three cold 320px loads retain readable portrait positions and complete labels with touch and desktop browser contexts`);
}

async function dragPoint(page, start, end, touch = false, movable = true) {
  const draggedId = await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.closest("[data-topology-node]")?.dataset.topologyNode, start);
  if (touch) {
    const channel = await page.context().newCDPSession(page);
    try {
      await channel.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: start.x, y: start.y, id: 1}]});
      for (let step = 1; step <= 8; step++) {
        await channel.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{id: 1,
          x: start.x + (end.x - start.x) * step / 8, y: start.y + (end.y - start.y) * step / 8}]});
      }
      if (draggedId) assert.equal(await page.locator(`[data-topology-node="${draggedId}"]`).evaluate(node => node.classList.contains("is-dragging")), movable,
        movable ? "trusted touch drag raises its active leaf" : "trusted touch cannot place immutable VPS into a drag layer");
      await channel.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
    } finally { await channel.detach(); }
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, {steps: 8});
    await page.mouse.up();
  }
  await settleGraph(page);
  if (touch) await page.waitForTimeout(100);
  assert.equal(await hook(page, "graph").locator(".is-dragging").count(), 0, "completed mouse/touch gestures remove their temporary card layer");
}

async function setLayoutEditing(page, enabled) {
  const toggle = hook(page, "layout-edit");
  if ((await toggle.getAttribute("aria-pressed") === "true") !== enabled) await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), String(enabled), "explicit layout toggle exposes its current state");
  assert.equal(await hook(page, "graph").getAttribute("data-layout-editing"), String(enabled), "canvas matches the explicit layout mode");
  await settleGraph(page);
}

async function touchScrollStart(page, onNode) {
  // Keep the real document, canvas and fixed mobile navigation in place. Pick a
  // visible starting point instead of dispatching a synthetic scroll event.
  await hook(page, "graph").evaluate(graph => window.scrollTo(0, graph.getBoundingClientRect().top + scrollY - 120));
  if (onNode) await page.locator('[data-topology-node]:not(.is-hub)').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const start = await hook(page, "graph").evaluate((graph, onNode) => {
    const bounds = graph.getBoundingClientRect();
    const top = Math.max(bounds.top + 24, 320), bottom = Math.min(bounds.bottom - 24, innerHeight - 180);
    if (onNode) {
      for (const node of graph.querySelectorAll('[data-topology-node]:not(.is-hub)')) {
        const box = node.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
        if (y >= top && y <= bottom && x > bounds.left + 15 && x < bounds.right - 15
            && document.elementFromPoint(x, y)?.closest("[data-topology-node]") === node) return {x, y, id: node.dataset.topologyNode};
      }
    } else {
      for (let y = bottom; y >= top; y -= 24) for (let x = bounds.left + 20; x < bounds.right - 20; x += 24) {
        const item = document.elementFromPoint(x, y);
        if (item && graph.contains(item) && !item.closest("[data-topology-node]")) return {x, y};
      }
    }
    return null;
  }, onNode);
  assert.ok(start, `real mobile graph exposes a visible ${onNode ? "node" : "background"} swipe target`);
  return start;
}

async function nativeSwipe(page, start, dy = -190) {
  const channel = await page.context().newCDPSession(page);
  try {
    await channel.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{id: 1, x: start.x, y: start.y}]});
    for (let step = 1; step <= 10; step++) {
      await channel.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{id: 1, x: start.x, y: start.y + dy * step / 10}]});
      await page.waitForTimeout(20);
    }
    // Ending at rest avoids a long fling affecting the following assertion.
    await page.waitForTimeout(140);
    await channel.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
  } finally { await channel.detach(); }
  await page.waitForTimeout(180);
  await settleGraph(page);
}

async function touchScrollNavigation(browser, label) {
  const state = await session(browser, 390);
  const {page, context, requests} = state;
  try {
    assert.equal(await hook(page, "layout-edit").getAttribute("aria-pressed"), "false", "mobile loads in reading mode, never in layout mode");
    const assertTouchPolicy = async editing => {
      const actions = await hook(page, "graph").evaluate(graph => ({
        graph: getComputedStyle(graph).touchAction,
        nodes: [...graph.querySelectorAll("[data-topology-node]")].map(node => ({hub:node.dataset.topologyNode === "hub",action:getComputedStyle(node).touchAction})),
      }));
      assert(actions.graph.includes("pan-y") && actions.graph.includes("pinch-zoom"), "Canvas background always permits native scrolling and accessibility zoom, including during node editing");
      for (const node of actions.nodes) {
        if (editing && !node.hub) assert.equal(node.action,"pinch-zoom","Only editable leaves claim single-finger dragging");
        else assert.ok(node.action === "auto" || node.action === "manipulation" || node.action.includes("pan-y"), "Reading-mode cards and the immutable VPS preserve native vertical scrolling");
      }
    };
    await assertTouchPolicy(false);
    const assertReadingSwipe = async onNode => {
      const start = await touchScrollStart(page, onNode);
      const before = await layoutState(page), selection = await hook(page, "select").inputValue();
      const beforeRequests = requests.length, initialScroll = await page.evaluate(() => scrollY);
      if (label === "chromium") {
        await nativeSwipe(page, start);
        assert.ok(await page.evaluate(() => scrollY) > initialScroll + 70, `trusted ${onNode ? "node" : "background"} swipe scrolls the real document`);
      } else {
        // WebKit exposes no CDP touch injection. Verify pointer cancellation and
        // the native-scroll CSS contract; do not pretend dispatchEvent scrolls.
        const result = await hook(page, "graph").evaluate((graph, start) => {
          const target = document.elementFromPoint(start.x, start.y);
          const states = [];
          for (const [type, y] of [["pointerdown", start.y], ["pointermove", start.y - 100], ["pointercancel", start.y - 100]]) {
            const event = new PointerEvent(type, {pointerType: "touch", pointerId: 912, isPrimary: true, clientX: start.x, clientY: y, bubbles: true, cancelable: true});
            target.dispatchEvent(event);
            states.push({prevented: event.defaultPrevented, dragging: graph.dataset.dragging === "true"});
          }
          return states;
        }, start);
        assert.ok(result.every(item => !item.prevented && !item.dragging), "reading touch never captures movement, suppresses native default or begins a canvas drag");
      }
      assert.deepEqual(await layoutState(page), before, "reading swipe never moves nodes, pans, zooms or rewrites inline ports");
      assert.equal(await hook(page, "select").inputValue(), selection, "scrolling from a card never selects it");
      assert.equal(requests.length, beforeRequests, "reading swipe never fetches selection data");
      assert.notEqual(await hook(page, "graph").getAttribute("data-dragging"), "true");
      assert.equal(await hook(page, "graph").locator(".is-dragging").count(), 0);
    };
    await assertReadingSwipe(false);
    await assertReadingSwipe(true);
    const targetId = await hook(page, "node").evaluateAll(nodes => nodes.find(node => node.getAttribute("aria-pressed") !== "true").dataset.topologyNode);
    await page.locator(`[data-topology-node="${targetId}"]`).tap();
    await selectionSettled(page, targetId);
    await settleGraph(page);
    assert.equal(await hook(page, "layout-edit").getAttribute("aria-pressed"), "false", "a normal node tap selects without enabling layout changes");
    await setLayoutEditing(page, true);
    await assertTouchPolicy(true);
    await assertReadingSwipe(false);
    await hook(page, "graph").evaluate(graph => window.scrollTo(0, graph.getBoundingClientRect().top + scrollY + 100));
    await settleGraph(page);
    const exitVisible = await hook(page, "layout-edit").evaluate(button => {
      const bounds = button.getBoundingClientRect(), x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
      return bounds.top >= 0 && bounds.bottom < innerHeight - 90 && button.contains(document.elementFromPoint(x, y));
    });
    assert.equal(exitVisible, true, "the completion button stays visible and clickable when reading has scrolled into the middle of the canvas");
    const editingShot = `${label}-390-touch-layout-sticky.png`;
    await page.screenshot({path: path.join(directory, editingShot), style: captureStyle});
    report.screenshots.push(editingShot);
    const start = await touchScrollStart(page, true);
    const before = await layoutState(page);
    // Mouse remains available even on hybrid touch devices. Exit through the
    // real button click handler while its captured drag is still active.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 12, start.y + 10);
    assert.equal(await hook(page, "graph").locator(".is-dragging").count(), 1, "layout mode begins an active card drag");
    await hook(page, "layout-edit").evaluate(button => button.click());
    assert.notEqual(await hook(page, "graph").getAttribute("data-dragging"), "true", "leaving layout mode cancels an active gesture");
    assert.equal(await hook(page, "graph").locator(".is-dragging").count(), 0, "leaving layout mode removes the temporary active layer");
    const stopped = await layoutState(page);
    await page.mouse.move(start.x + 60, start.y + 50);
    await page.mouse.up();
    await settleGraph(page);
    assert.deepEqual(await layoutState(page), stopped, "a canceled gesture cannot continue moving after layout mode exits");
    assert.notDeepEqual(stopped.positions, before.positions, "exiting layout mode preserves changes already made rather than resetting the arrangement");
    await assertTouchPolicy(false);
    // Exercise the first native tap inside the 450 ms synthetic-click guard
    // left by the canceled drag, rather than waiting through another swipe.
    const immediateTap = await hook(page, "graph").evaluate(graph => {
      for (const node of graph.querySelectorAll('[data-topology-node][aria-pressed="false"]')) {
        const box = node.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
        if (y > 100 && y < innerHeight - 100 && document.elementFromPoint(x, y)?.closest("[data-topology-node]") === node) return {x, y, id: node.dataset.topologyNode};
      }
      return null;
    });
    assert.ok(immediateTap, "mobile graph exposes an unselected card for immediate tap recovery");
    // Reenter/finish without moving the page to start a deterministic guard.
    await hook(page, "layout-edit").evaluate(button => { button.click(); button.click(); });
    await page.touchscreen.tap(immediateTap.x, immediateTap.y);
    await selectionSettled(page, immediateTap.id);
    await settleGraph(page);
    assert.equal(await hook(page, "layout-edit").getAttribute("aria-pressed"), "false", "the first tap after completing a layout edit selects immediately without reentering layout mode");
    await assertReadingSwipe(false);
    await assertReadingSwipe(true);
    await screenshot(page, `${label}-390-touch-page-scroll`);
    await setLayoutEditing(page, true);
    await hook(page, "graph").focus();
    await page.keyboard.press("Escape");
    assert.equal(await hook(page, "layout-edit").getAttribute("aria-pressed"), "false", "Escape provides an accessible way back to page scrolling");
    await assertTouchPolicy(false);
    await setLayoutEditing(page, true);
    await hook(page, "layout-edit").focus();
    await page.keyboard.press("Escape");
    assert.equal(await hook(page, "layout-edit").getAttribute("aria-pressed"), "false", "Escape also exits immediately while focus remains on the layout button");
    await assertTouchPolicy(false);
    await assertReadOnly(state);
    await setLayoutEditing(page, true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", {persisted: true})));
    assert.equal(await hook(page, "layout-edit").getAttribute("aria-pressed"), "false", "leaving or restoring the page never leaves native scrolling captured");
    assert.equal(await hook(page, "graph").locator(".is-dragging").count(), 0);
    await page.reload();
    await hook(page, "root").waitFor();
    await assertFixedCenter(page);
    assert.equal(await hook(page, "layout-edit").getAttribute("aria-pressed"), "false", "layout manipulation is never sticky across page loads");
    await assertTouchPolicy(false);
    report.checks.push(`${label}: reading-mode ${label === "chromium" ? "trusted native page scrolling" : "touch-action/pointer lifecycle"} from background and cards, tap selection, explicit layout mode, active-gesture cancellation, and restored reading mode after exit/reload`);
  } finally { await page.mouse.up().catch(() => {}); await context.close(); }
}

async function directManipulation(browser, label, width, touch = false) {
  const state = await session(browser, width), {page, context, requests} = state;
  try {
    const model = await (await context.request.get(topologyURL + "?format=json")).json();
    const source = model.links.find(link => link.source !== "hub").source;
    await selectAndWait(page, source); await assertFixedControls(page);
    await hook(page, "reset").click(); await settleGraph(page);
    const original = await layoutState(page);
    if (touch) await setLayoutEditing(page, true);
    const nodeId = model.links.find(link => link.source === source && link.target !== "hub")?.target
      || model.nodes.find(node => node.id !== "hub").id;
    const node = page.locator('[data-topology-node="' + nodeId + '"]');
    await node.scrollIntoViewIfNeeded();
    const box = await node.boundingBox(), beforeRequests = requests.length;
    const start = {x: box.x + box.width / 2, y: box.y + box.height / 2};
    await dragPoint(page, start, {x: start.x + 26, y: start.y + 18}, touch);
    const moved = await layoutState(page);
    assert.notDeepEqual(moved.positions.find(node => node.id === nodeId), original.positions.find(node => node.id === nodeId), "leaf dragging changes its projected position");
    assert.notDeepEqual(moved.spokes, original.spokes, "leaf dragging updates its real VPS access segment");
    assert.deepEqual(moved.positions.filter(node => node.id !== nodeId), original.positions.filter(node => node.id !== nodeId), "leaf dragging never moves other nodes or VPS");
    assert.deepEqual(moved.ports, original.ports, "drag preserves exact inline access scopes");
    assert.equal(await hook(page, "select").inputValue(), source); assert.equal(requests.length, beforeRequests);
    await assertFixedCenter(page);
    await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
    await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
    assert.deepEqual((await layoutState(page)).positions, moved.positions, "refresh preserves custom leaf placement");
    await selectAndWait(page, nodeId);
    assert.deepEqual((await layoutState(page)).positions, moved.positions, "selection preserves custom leaf placement");
    await direction(page, "reverse"); await assertGraph(page); await assertCardEdges(page);
    await direction(page, "forward"); await assertGraph(page); await assertCardEdges(page);
    assert.deepEqual((await layoutState(page)).positions, moved.positions, "direction and inline height changes never move leaf positions");
    const beforeInputs = await layoutState(page);
    for (const ctrlKey of [false, true]) for (const deltaY of [-240, 240]) {
      await hook(page, "graph").evaluate((graph, input) => graph.dispatchEvent(new WheelEvent("wheel", {bubbles:true, cancelable:true, ...input})), {ctrlKey, deltaY});
      await settleGraph(page); await assertFixedCenter(page);
    }
    await hook(page, "graph").focus();
    for (const key of ["+", "-", "="]) { await page.keyboard.press(key); await settleGraph(page); await assertFixedCenter(page); }
    assert.deepEqual(await layoutState(page), beforeInputs, "removed zoom inputs do not resize cards, move arrows, rewrite scopes or pan the scene");
    await page.keyboard.press("ArrowRight"); await settleGraph(page);
    assert.notDeepEqual((await layoutState(page)).positions, beforeInputs.positions, "canvas keyboard rotates the projected layout");
    assert.deepEqual((await layoutState(page)).viewport, beforeInputs.viewport, "keyboard rotation cannot become camera translation");
    if (!touch) {
      await node.focus(); const beforeAlt = await layoutState(page); await page.keyboard.press("Alt+ArrowRight"); await settleGraph(page);
      assert.notDeepEqual((await layoutState(page)).positions, beforeAlt.positions, "Alt-arrow adjusts only a focused leaf");
    }
    await selectAndWait(page, "hub"); await direction(page, "reverse");
    const hub = page.locator('[data-topology-node="hub"]'); await hub.scrollIntoViewIfNeeded();
    const hubBox = await hub.boundingBox(), fixed = await layoutState(page), requestCount = requests.length;
    await dragPoint(page, {x: hubBox.x + hubBox.width / 2, y: hubBox.y + hubBox.height / 2},
      {x: hubBox.x + hubBox.width / 2 + 30, y: hubBox.y + hubBox.height / 2 + 20}, touch, false);
    assert.deepEqual(await layoutState(page), fixed, "hub drag cannot move the origin, spokes, arrows or port labels");
    await hub.focus(); await page.keyboard.press("Alt+ArrowRight"); await settleGraph(page);
    assert.deepEqual(await layoutState(page), fixed, "keyboard also cannot move the hub"); assert.equal(requests.length, requestCount);
    await hook(page, "reset").click(); await settleGraph(page);
    assert.deepEqual((await layoutState(page)).positions, original.positions, "header auto-arrange restores default camera and all leaf positions");
    await assertFixedCenter(page);
    if (!touch) {
      await page.setViewportSize({width: 590, height: 844}); await settleGraph(page); await assertFixedCenter(page); await assertGraph(page); await assertCardEdges(page);
      await page.setViewportSize({width, height: 1000}); await settleGraph(page); await assertFixedCenter(page);
    }
    await screenshot(page, label + "-" + width + "-fixed-center-dragged");
    await assertReadOnly(state);
    report.checks.push(label + " " + width + ": leaf-only drag and Alt move, fixed central VPS, ignored zoom inputs, keyboard rotation, refresh/selection/direction preservation, and one-click rearrangement");
  } finally { await context.close(); }
}

async function layerPriority(browser, label) {
  const state = await session(browser, 1440);
  const {page, context, requests} = state;
  try {
    const model = await (await context.request.get(topologyURL + "?format=json")).json();
    const selected = model.nodes.find(node => model.links.some(link => link.source === node.id)
      && model.nodes.some(other => other.id !== node.id && !model.links.some(link => link.source === node.id && link.target === other.id)));
    assert.ok(selected, "layer fixture includes a selected source, authorized peer, and ordinary node");
    await selectAndWait(page, selected.id);
    await assertDepthOcclusion(page, scene => screenshot(page, `${label}-depth-${scene}`));
    assert.equal(await hook(page, "graph").locator(".is-dragging").count(), 0, "drag completion clears gesture styling");
    const positions = (await layoutState(page)).positions;
    await direction(page, "reverse");
    await mode(page, "overview");
    assert.equal(await hook(page, "graph").locator(".is-peer, .is-dragging").count(), 0, "overview clears peer and drag layers");
    assert.deepEqual((await layoutState(page)).positions, positions, "layer/content cleanup never resets the deliberately dragged positions");
    await assertReadOnly(state);
    report.checks.push(`${label}: actual front/back VPS occlusion follows camera depth during selection, dragging, keyboard focus and permissions; cleanup preserves geometry and remains read-only`);
  } finally { await context.close(); }
}

async function interruptedGestures(browser, label) {
  const state = await session(browser, 1440);
  const {page, context} = state;
  let releaseResponse;
  try {
    const original = await (await context.request.get(topologyURL + "?format=json")).json();
    const target = original.nodes.find(node => node.kind === "awg" && node.id !== original.selected_id);
    const targetNode = page.locator(`[data-topology-node="${target.id}"]`);
    await hook(page, "graph").scrollIntoViewIfNeeded();
    await hook(page, "graph").evaluate(graph => {
      graph.addEventListener("pointerdown", event => { graph.dataset.qaPointerId = String(event.pointerId); }, {capture: true});
    });
    let box = await targetNode.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 14, box.y + box.height / 2 + 11);
    await hook(page, "graph").evaluate(graph => graph.releasePointerCapture(Number(graph.dataset.qaPointerId)));
    const graphBox = await hook(page, "graph").boundingBox();
    await page.mouse.move(graphBox.x - 5, graphBox.y + 40);
    await page.mouse.up();
    await settleGraph(page);
    assert.notEqual(await hook(page, "graph").getAttribute("data-dragging"), "true", "lost pointer capture cancels the gesture without sticky dragging");
    assert.equal(await hook(page, "graph").locator(".is-dragging").count(), 0, "lost capture removes the temporary node top layer");
    box = await targetNode.boundingBox();
    const beforeNew = await layoutState(page);
    await dragPoint(page, {x: box.x + box.width / 2, y: box.y + box.height / 2}, {x: box.x + box.width / 2 + 20, y: box.y + box.height / 2 + 12});
    assert.notDeepEqual((await layoutState(page)).positions, beforeNew.positions, "a new gesture works after losing capture");

    const changed = structuredClone(original);
    changed.nodes = changed.nodes.filter(node => node.id !== target.id);
    changed.relations = changed.relations.filter(relation => relation.node.id !== target.id);
    changed.links = changed.links.filter(link => link.source !== target.id && link.target !== target.id);
    changed.summary.nodes -= 1; changed.summary.awg -= 1; changed.summary.enabled -= 1;
    let reached;
    const pending = new Promise(resolve => { releaseResponse = resolve; });
    const intercepted = new Promise(resolve => { reached = resolve; });
    await page.route(jsonRoute, async route => {
      reached(); await pending;
      try { await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(changed)}); }
      catch (error) { if (!/closed|disposed|aborted|interception|already handled/i.test(error.message)) throw error; }
    });
    await hook(page, "refresh").click();
    await intercepted;
    await hook(page, "graph").scrollIntoViewIfNeeded();
    box = await targetNode.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 10);
    releaseResponse();
    await targetNode.waitFor({state: "detached"});
    const afterRemoval = await layoutState(page);
    await page.mouse.move(box.x + box.width / 2 + 43, box.y + box.height / 2 + 32);
    await page.mouse.up();
    await settleGraph(page);
    assert.deepEqual((await layoutState(page)).viewport, afterRemoval.viewport, "removing a dragged node cannot reinterpret its coordinates as a background pan");
    assert.notEqual(await hook(page, "graph").getAttribute("data-dragging"), "true");
    await assertGraph(page, changed.links);
    await assertReadOnly(state);
    report.checks.push(`${label}: lost pointer capture and refresh removal of a dragged node cancel cleanly without stale gestures or camera jumps`);
  } finally { releaseResponse?.(); await page.mouse.up().catch(() => {}); await context.close(); }
}

async function responsiveThemes(browser, label, width) {
  const state = await session(browser, width);
  const {page, context} = state;
  try {
    assert.equal(await page.locator('button[data-topology-mode="overview"]').getAttribute("aria-pressed"), "true", "initial graph is a clean star overview");
    assert.equal(await hook(page, "view-options").evaluate(details => details.open), false, "secondary view controls are initially collapsed");
    assert.equal(await hook(page, "full-details").evaluate(details => details.open), false, "the exhaustive permission list is initially collapsed with JavaScript");
    await assertGraph(page);
    await assertLegibleOverview(page, width);
    if (width === 390) {
      const name = `${label}-390-initial-graph.png`;
      await hook(page, "graph").screenshot({path: path.join(directory, name), style: captureStyle});
      report.screenshots.push(name);
    }
    assert.match(await hook(page, "full-details").textContent(), /权限视图不是连通性测试/, "the full details retain the warning that live handshakes do not imply proven reachability");
    assert.equal(await hook(page, "note").isVisible(), false, "overview does not repeat the full-details caveat below the canvas");
    const clients = await hook(page, "node").evaluateAll(items => items.map(node => node.getAttribute("data-topology-node")).filter(id => id !== "hub"));
    assert.ok(clients.length > 1, "rich fixture graph has clients");
    const target = clients.find(id => id.startsWith("vless:")) || clients[1];
    const targetButton = hook(page, "node").filter({hasText: target.split(":").slice(1).join(":")});
    await (width < 768 ? targetButton.tap() : targetButton.click());
    await selectionSettled(page, target);
    assert.match(await hook(page, "details").textContent(), new RegExp(target.split(":").slice(1).join(":")));
    assert.equal(await page.locator('button[data-topology-mode="relations"]').getAttribute("aria-pressed"), "true", "node click enters relationship mode");
    for (const theme of ["light", "dark"]) {
      await setTheme(page, width, theme);
      await assertControlContrast(page, label, width, theme);
      await assertGraph(page);
      await assertLegibleOverview(page, width);
      await screenshot(page, `${label}-${width}-${theme}`);
      if (width === 1440) {
        const name = `${label}-${width}-${theme}-controls.png`;
        await page.locator(".topology-panel").screenshot({path: path.join(directory, name), style: captureStyle});
        report.screenshots.push(name);
      }
      if (theme === "light") {
        const name = `${label}-${width}-graph.png`;
        await hook(page, "graph").screenshot({path: path.join(directory, name), style: captureStyle});
        report.screenshots.push(name);
      }
    }
    await assertReadOnly(state);
    report.checks.push(`${label} ${width}: clean overview, all nodes, single-direction inspection, touch/click selection, light and dark appearances, no overflow or navigation`);
  } finally { await context.close(); }
}

async function keyboardAndErrors(browser, label) {
  const state = await session(browser, 1440);
  const {page, context} = state;
  try {
    const original = await (await context.request.get(topologyURL + "?format=json")).json();
    const target = original.nodes.find(node => node.kind === "awg" && node.id !== original.selected_id);
    const button = hook(page, "node").filter({hasText: target.name});
    await button.focus();
    await page.keyboard.press("Enter");
    await selectionSettled(page, target.id);
    assert.equal(await hook(page, "select").inputValue(), target.id);
    await hook(page, "refresh").focus();
    await Promise.all([page.waitForResponse(jsonResponse), page.keyboard.press("Space")]);
    const select = hook(page, "select");
    await select.focus();
    // Native type-ahead works in macOS headless browsers; their OS arrow-key
    // popup is not controlled by Playwright. "v" uniquely selects VPS here.
    await page.keyboard.press("v");
    await page.keyboard.press("Enter");
    await selectionSettled(page, "hub");
    assert.equal(await select.inputValue(), "hub", "native selection works from the keyboard");
    const before = await viewState(page);
    await page.route(jsonRoute, route => route.fulfill({status: 503, contentType: "application/json", body: JSON.stringify({code: "snapshot_unavailable", error: "暂时无法读取节点连接关系，请稍后重试。"})}));
    await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
    await page.waitForFunction(() => /失败|无法|重试/.test(document.querySelector("[data-topology-status]").textContent));
    assert.deepEqual(await viewState(page), before, "refresh error preserves selection, nodes, options, and details");
    const cachedIds = new Set([original.selected_id, target.id, "hub"]);
    const uncachedTarget = original.nodes.find(node => !cachedIds.has(node.id));
    assert.ok(uncachedTarget, "failed selection must exercise an actual uncached request");
    await Promise.all([page.waitForResponse(jsonResponse), choose(page, uncachedTarget.id)]);
    await page.waitForFunction(() => !document.querySelector("[data-topology-refresh]").disabled);
    assert.deepEqual(await viewState(page), before, "failed selection restores the previous selection and complete view");
    await assertGraph(page);
    await screenshot(page, `${label}-refresh-error`);
    await page.unroute(jsonRoute);
    await page.route(jsonRoute, route => route.fulfill({status: 200, contentType: "text/html", body: "<!doctype html><title>Login</title><form>synthetic expired session</form>"}));
    await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
    await page.waitForFunction(() => !document.querySelector("[data-topology-refresh]").disabled);
    assert.deepEqual(await viewState(page), before, "expired login HTML cannot replace the last good view");
    assert.doesNotMatch(await hook(page, "root").innerHTML(), /synthetic expired session/);
    const missingKind = structuredClone(original);
    delete missingKind.nodes.find(node => node.kind === "awg").kind;
    const unknownLink = structuredClone(original);
    assert.ok(unknownLink.links.length, "rich fixture has confirmed permissions");
    unknownLink.links[0].status = "unknown";
    const missingLinks = structuredClone(original);
    delete missingLinks.links;
    for (const body of ["{bad json", JSON.stringify({nodes: [], selected_id: "hub"}), JSON.stringify(missingKind), JSON.stringify(unknownLink), JSON.stringify(missingLinks)]) {
      await page.unroute(jsonRoute);
      await page.route(jsonRoute, route => route.fulfill({status: 200, contentType: "application/json", body}));
      await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
      await page.waitForFunction(() => !document.querySelector("[data-topology-refresh]").disabled);
      assert.deepEqual(await viewState(page), before, "malformed JSON/model cannot replace the last good view");
      assert.equal(await hook(page, "status").getAttribute("data-state"), "error");
    }
    await assertReadOnly(state);
    report.checks.push(`${label}: keyboard node/select/refresh; HTTP errors, expired login, malformed JSON/model preserve the last good view`);
  } finally { await context.close(); }
}

async function cancellationAndTimeout(browser, label) {
  const state = await session(browser);
  const {page, context} = state;
  const releases = [];
  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    releases.push(release);
    return {promise, release};
  }
  try {
    const original = await (await context.request.get(topologyURL + "?format=json")).json();
    const target = original.nodes.find(node => node.kind === "awg" && node.id !== original.selected_id);
    const next = await (await context.request.get(topologyURL + "?format=json&node=" + encodeURIComponent(target.id))).json();
    const before = await viewState(page);
    const modeReached = gate(), modeDelayed = gate();
    await page.route(jsonRoute, async route => {
      modeReached.release(); await modeDelayed.promise;
      try { await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(next)}); }
      catch (error) { if (!/closed|disposed|aborted|interception|already handled/i.test(error.message)) throw error; }
    });
    await choose(page, target.id);
    await modeReached.promise;
    await mode(page, "overview");
    assert.equal(await hook(page, "root").getAttribute("aria-busy"), null, "returning to overview cancels a pending selection");
    assert.deepEqual(await viewState(page), before, "returning to overview restores the prior selection and layout");
    modeDelayed.release();
    await page.waitForTimeout(150);
    assert.deepEqual(await viewState(page), before, "a late selected-node response cannot force the user out of overview");
    await page.unroute(jsonRoute);
    const reached = gate(), delayed = gate();
    await page.route(jsonRoute, async route => {
      reached.release();
      await delayed.promise;
      try { await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(next)}); }
      catch (error) { if (!/closed|disposed|aborted|interception|already handled/i.test(error.message)) throw error; }
    });
    await choose(page, target.id);
    await reached.promise;
    assert.equal(await hook(page, "root").getAttribute("aria-busy"), "true");
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true}));
    });
    assert.equal(await hook(page, "refresh").isEnabled(), true);
    assert.equal(await hook(page, "root").getAttribute("aria-busy"), null);
    assert.deepEqual(await viewState(page), before, "pagehide cancels selection and resets the prior view");
    delayed.release();
    await page.waitForTimeout(150);
    assert.deepEqual(await viewState(page), before, "response arriving after pagehide cannot replace the view");
    await page.unroute(jsonRoute);
    const timeoutReached = gate(), timeoutHeld = gate();
    await page.route(jsonRoute, async route => {
      timeoutReached.release();
      await timeoutHeld.promise;
      try { await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(original)}); }
      catch (error) { if (!/closed|disposed|aborted|interception|already handled/i.test(error.message)) throw error; }
    });
    await page.evaluate(() => {
      const originalTimer = window.setTimeout.bind(window);
      // Accelerate only the production 15-second fetch deadline, not UI timers.
      let accelerated = false;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 15000 && !accelerated) { accelerated = true; return originalTimer(callback, 100, ...args); }
        return originalTimer(callback, delay, ...args);
      };
    });
    await hook(page, "refresh").click();
    await timeoutReached.promise;
    await page.waitForFunction(() => /超时/.test(document.querySelector("[data-topology-status]").textContent));
    assert.deepEqual(await viewState(page), before, "deadline preserves all displayed data");
    assert.equal(await hook(page, "refresh").isEnabled(), true, "timeout restores the refresh control");
    assert.equal(await hook(page, "root").getAttribute("aria-busy"), null);
    await screenshot(page, `${label}-390-timeout`);
    timeoutHeld.release();
    await page.unroute(jsonRoute);
    await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
    await page.waitForFunction(() => document.querySelector("[data-topology-status]").dataset.state === "ready");
    await assertReadOnly(state);
    report.checks.push(`${label}: overview return and pagehide cancel late responses; 15-second deadline preserves the view and permits retry`);
  } finally { releases.forEach(release => release()); await context.close(); }
}

async function stressAndRace(browser, label) {
  const state = await session(browser);
  const {page, context} = state;
  let releaseOld;
  try {
    const original = await (await context.request.get(topologyURL + "?format=json")).json();
    let reachedOld;
    const oldReached = new Promise(resolve => { reachedOld = resolve; });
    const oldPending = new Promise(resolve => { releaseOld = resolve; });
    let delayId = null;
    await page.route(jsonRoute, async route => {
      const id = new URL(route.request().url()).searchParams.get("node") || "hub";
      if (id === delayId) { reachedOld(); await oldPending; }
      try { await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(syntheticModel(original, id))}); }
      catch (error) { if (!/closed|disposed|aborted|interception|already handled/i.test(error.message)) throw error; }
    });
    const renderStarted = Date.now();
    await Promise.all([page.waitForResponse(jsonResponse), hook(page, "refresh").click()]);
    await page.waitForFunction(() => [...document.querySelector("[data-topology-select]").options].filter(option => option.value).length === 41);
    await settleGraph(page);
    const denseModel = syntheticModel(original);
    await assertGraph(page, denseModel.links);
    const renderMs = Date.now() - renderStarted;
    assert.ok(renderMs < 8000, "40-node dense graph renders without freezing the page");
    assert.equal(await hook(page, "node").count(), 41, "all 40 clients and the hub are mounted together");
    const positions = (await layoutState(page)).positions;
    await openViewTools(page);
    await hook(page, "search").fill("synthetic-39");
    assert.equal(await hook(page, "node").count(), 41, "search preserves every node");
    assert.equal(await hook(page, "graph").locator("[data-topology-node].is-match").count(), 1, "search highlights its match");
    assert.deepEqual((await layoutState(page)).positions, positions, "search preserves the camera without rearranging nodes");
    await assertGraph(page, denseModel.links);
    await screenshot(page, `${label}-390-search-40-nodes`);
    await hook(page, "search").fill("no-synthetic-node-matches");
    assert.equal(await hook(page, "node").count(), 41, "an unmatched search does not hide configured nodes");
    assert.equal(await hook(page, "graph").locator("[data-topology-node].is-match").count(), 0);
    await hook(page, "search").fill("");
    await closeViewTools(page);
    const frameMs = await page.evaluate(async () => {
      const started = performance.now();
      for (let frame = 0; frame < 12; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
      return performance.now() - started;
    });
    assert.ok(frameMs < 2000, "dense graph continues to process animation frames");
    report.performance.push({browser: label, nodes: 41, directedLinks: denseModel.links.length, renderMs, twelveFramesMs: Math.round(frameMs)});
    const delayedId = "awg:synthetic-00", finalId = "awg:synthetic-01";
    delayId = delayedId;
    await choose(page, delayedId);
    await oldReached;
    await Promise.all([page.waitForResponse(response => jsonResponse(response) && new URL(response.url()).searchParams.get("node") === finalId), choose(page, finalId)]);
    await page.waitForFunction(id => document.querySelector("[data-topology-select]").value === id, finalId);
    const finalDetails = await hook(page, "details").textContent();
    assert.match(finalDetails, /synthetic-01/);
    releaseOld();
    // Let both the network and rendering queues settle after the stale response.
    await page.waitForTimeout(200);
    assert.equal(await hook(page, "select").inputValue(), finalId, "late response cannot restore stale selection");
    assert.equal(await hook(page, "details").textContent(), finalDetails, "late response cannot replace current details");
    await assertFixedCenter(page);
    await assertGraph(page, denseModel.links);
    assert.equal(await hook(page, "node").count(), 41, "directional inspection never drops nodes");
    await screenshot(page, `${label}-390-many-nodes-focused`);
    await mode(page, "overview");
    await screenshot(page, `${label}-390-many-nodes`);
    await page.setViewportSize({width: 320, height: 844});
    await settleGraph(page);
    await assertFixedCenter(page);
    await assertGraph(page, denseModel.links);
    await mode(page, "relations");
    await screenshot(page, `${label}-320-many-nodes`);
    await page.setViewportSize({width: 768, height: 1000});
    await settleGraph(page);
    await assertFixedCenter(page);
    await assertGraph(page, denseModel.links);
    await screenshot(page, `${label}-768-many-nodes`);
    await page.setViewportSize({width: 1440, height: 1000});
    await settleGraph(page);
    await assertFixedCenter(page);
    await assertGraph(page, denseModel.links);
    await hook(page, "graph").scrollIntoViewIfNeeded();
    const dragNode = page.locator('[data-topology-node="awg:synthetic-02"]');
    const dragBox = await dragNode.boundingBox();
    const beforeDenseDrag = await layoutState(page);
    const requestCount = state.requests.length;
    const dragStarted = Date.now();
    await dragPoint(page, {x: dragBox.x + dragBox.width / 2, y: dragBox.y + dragBox.height / 2},
      {x: dragBox.x + dragBox.width / 2 + 29, y: dragBox.y + dragBox.height / 2 + 19});
    const denseDragMs = Date.now() - dragStarted;
    const afterDenseDrag = await layoutState(page);
    assert.notDeepEqual(afterDenseDrag.positions, beforeDenseDrag.positions, "dense graph remains draggable");
    assert.notDeepEqual(afterDenseDrag.spokes, beforeDenseDrag.spokes, "dense graph updates the dragged leaf's VPS spoke");
    assert.deepEqual(afterDenseDrag.edges, beforeDenseDrag.edges, "an unrelated leaf drag does not invent or change permission arrows");
    assert.equal(state.requests.length, requestCount, "dense node drag does not fetch selection data");
    assert.ok(denseDragMs < 3500, "dense graph handles an eight-step drag without freezing");
    report.performance.find(item => item.browser === label).denseDragMs = denseDragMs;
    await screenshot(page, `${label}-1440-many-nodes`);
    await assertReadOnly(state);
    report.checks.push(`${label}: all 40 clients plus hub, 1600-direction payload with selected-direction rendering, search without hiding, dense graph performance, and stale request protection`);
  } finally { releaseOld?.(); await context.close(); }
}

async function fixturesAndFallback(browser, label) {
  const state = await session(browser);
  const {context, page} = state;
  try {
    for (const scenario of ["empty", "pending", "error"]) {
      assert.equal((await context.request.get(new URL(`__preview__/scenario/${scenario}/`, base).href)).status(), 200);
      const response = await page.goto(topologyURL);
      if (scenario !== "error") await assertFixedCenter(page);
      assert.equal(response.status(), scenario === "error" ? 503 : 200);
      await hook(page, "root").waitFor();
      if (scenario === "empty") {
        assert.equal(await hook(page, "node").count(), 1);
        assert.match(await hook(page, "root").innerText(), /暂无|还没有|尚无|尚未|没有/);
      }
      if (scenario === "pending") assert.match(await hook(page, "root").innerText(), /待.*应用|待同步|尚未同步|未同步/);
      if (scenario === "error") assert.match(await hook(page, "root").innerText(), /无法|失败|重试/);
      await screenshot(page, `${label}-390-${scenario}`);
    }
  } finally { await context.close(); }
  const fallback = await session(browser, 390, {javaScriptEnabled: false});
  try {
    assert.match(await fallback.page.locator("body").innerText(), /JavaScript|脚本|未启用交互图/);
    assert.match(await hook(fallback.page, "details").innerText(), /VPS/);
    assert.equal(await hook(fallback.page, "full-details").evaluate(details => details.open), true, "full fallback detail stays open without JavaScript");
    assert.ok(await hook(fallback.page, "select").isVisible(), "native selection is visible without JavaScript");
    await screenshot(fallback.page, `${label}-390-noscript`);
    report.checks.push(`${label}: empty/pending/error fixtures and readable no-JavaScript fallback`);
  } finally { await fallback.context.close(); }
}

(async () => {
  try {
    for (const [label, engine] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await engine.launch();
      try {
        const selectionAudit = widths => selectionScenarios({browser,label,session,hook,selectAndWait,selectionSettled,mode,direction,
          settleGraph,touchScrollStart,nativeSwipe,setLayoutEditing,assertReadOnly,jsonRoute,jsonResponse,topologyURL,report,screenshot},widths);
        if (process.argv.includes("--selection-smoke")) {
          await selectionAudit();
          continue;
        }
        if (process.argv.includes("--arrow-smoke")) {
          await accessRouteScenarios(browser, label);
          continue;
        }
        if (process.argv.includes("--touch-scroll-only")) {
          await selectionAudit([390]);
          await touchScrollNavigation(browser, label);
          if (label === "chromium") await directManipulation(browser, label, 390, true);
          await directManipulation(browser, label, 1440);
          continue;
        }
        if (process.argv.includes("--layer-smoke")) {
          await layerSmoke(browser, label);
          await directManipulation(browser, label, 1440);
          await layerPriority(browser, label);
          continue;
        }
        if (process.argv.includes("--readability-audit")) {
          await readabilityAudit(browser, label);
          continue;
        }
        const anonymous = await browser.newContext();
        try {
          const response = await anonymous.request.get(topologyURL + "?format=json", {maxRedirects: 0});
          assert.ok([302, 401, 403].includes(response.status()), "topology requires authentication");
        } finally { await anonymous.close(); }
        if (process.argv.includes("--interruptions-only")) {
          await interruptedGestures(browser, label);
          continue;
        }
        if (!process.argv.includes("--keyboard-only") && !process.argv.includes("--functional-only")) {
          await coldMobileLayouts(browser, label);
          for (const width of [320, 390, 768, 1440]) await responsiveThemes(browser, label, width);
          await readabilityAudit(browser, label);
        }
        if (process.argv.includes("--visual-only")) continue;
        await selectionAudit();
        await layerSmoke(browser, label);
        await layerPriority(browser, label);
        await accessRouteScenarios(browser, label);
        if (!process.argv.includes("--theme-gesture-only")) await keyboardAndErrors(browser, label);
        if (process.argv.includes("--keyboard-only")) continue;
        await directManipulation(browser, label, 1440);
        await touchScrollNavigation(browser, label);
        if (label === "chromium") await directManipulation(browser, label, 390, true);
        await interruptedGestures(browser, label);
        if (process.argv.includes("--theme-gesture-only")) continue;
        await stressAndRace(browser, label);
        await cancellationAndTimeout(browser, label);
        await fixturesAndFallback(browser, label);
      } finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, [], "no browser runtime errors");
    assert.deepEqual(report.blocked, [], "no external requests");
    console.log(JSON.stringify({directory, checks: report.checks, screenshots: report.screenshots.length, readabilityScenes: report.readability.length,
      performance: report.performance, errors: report.errors, blocked: report.blocked}, null, 2));
  } catch (error) {
    report.failure = error.stack;
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Topology QA artifacts: ${directory}`);
  }
})();
