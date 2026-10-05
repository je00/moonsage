"use strict";

// Page-scoped synthetic fixtures, no shared-preview resets or production reads.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {createHash} = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {chromium, webkit} = require("playwright");
const {assertFixedCenter, assertFixedControls} = require("./topology_fixed_contract.cjs");
const {assertInlinePorts, assertCardEdges, assertMarkerGeometry} = require("./topology_inline_assertions.cjs");
const {orbit} = require("./topology_gestures.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8877/");
assert(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash,
  "Only a loopback preview without embedded credentials may be tested");
const fixtureSource = `
import json, sys
sys.path.insert(0, sys.argv[1])
from test_topology_galaxies_fixture import projected_models, galaxy_overview, build_topology, OBSERVED_AT
packet = projected_models()
renamed = galaxy_overview()
renamed["exit_options"][0]["name"] = "north-atlantic-transoceanic-research-hub"
packet["renamed"] = {identifier: {**build_topology(renamed, identifier), "observed_at": OBSERVED_AT} for identifier in packet["models"]}
raw = galaxy_overview()
raw["exit_options"] = [{"id": f"{index + 1:012x}", "name": f"remote-exit-{index + 1:02d}-north-atlantic"} for index in range(16)]
for node in raw["nodes"]:
    node["exit_ids"] = [item["id"] for item in raw["exit_options"]] if node["name"] == "phone-all" else []
packet["sixteen"] = {identifier: {**build_topology(raw, identifier), "observed_at": OBSERVED_AT} for identifier in packet["models"]}
print(json.dumps(packet, ensure_ascii=False))
`;
const fixture = spawnSync(process.env.TOPOLOGY_TEST_PYTHON || "python3", ["-c", fixtureSource, __dirname],
  {encoding: "utf8", maxBuffer: 8 * 1024 * 1024});
assert.equal(fixture.status, 0, fixture.stderr);
const packet = JSON.parse(fixture.stdout);
assert.equal(packet.generated_by, "dashboard.topology.build_topology");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-topology-galaxies-"));
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || null;
if (caseFilter) assert(/^(chromium|webkit)-(1440|390|320)-(light|dark)$/.test(caseFilter));
const report = {directory, caseFilter, projector: packet.generated_by, expectedCaseCount: caseFilter ? 1 : 12,
  runtimeSHA256: createHash("sha256").update(fs.readFileSync(path.join(__dirname, "../web/static/topology.js"))).digest("hex"),
  cases: [], screenshots: [], errors: [], external: [], requests: []};
const hook = (page, name) => page.locator(`[data-topology-${name}]`);
const isTopology = url => url.origin === base.origin && url.pathname === "/network/topology/";
const isJSON = url => isTopology(url) && url.searchParams.get("format") === "json";
const sorted = values => [...values].sort();
const initial = packet.initial_selected;
const phone = "vless:phone-all";
const noExits = "awg:travel-laptop";
console.log(`Topology immersive-exit QA: ${directory}`);

async function settle(page) {
  await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertFixedCenter(page);
}

async function select(page, id, direction = "forward") {
  await hook(page, "select").selectOption(id);
  await page.waitForFunction(id => document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode === id, id);
  await page.locator(`[data-topology-direction="${direction}"]`).click();
  await settle(page);
}

async function galaxyState(page) {
  return hook(page, "stage").evaluate(stage => {
    const graph = stage.querySelector("[data-topology-graph]"), region = stage.querySelector("[data-topology-exit-region]");
    const rect = element => {const b = element.getBoundingClientRect(); return {left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height};};
    const styles = element => {const s = getComputedStyle(element); return {color: s.color, background: s.backgroundColor, border: s.borderColor,
      shadow: s.boxShadow, opacity: s.opacity, filter: s.filter, fill: s.fill, stroke: s.stroke};};
    const world = graph.querySelector("[data-topology-world]");
    const graphStyle = getComputedStyle(graph), horizon = graphStyle.getPropertyValue("--horizon-y").trim();
    const spatial = element => ({xyz: ["spaceX", "spaceY", "spaceZ"].map(key => Number(element.dataset[key])),
      xy: ["worldX", "worldY"].map(key => Number(element.dataset[key])), depth: Number(element.dataset.cameraDepth),
      z: Number(getComputedStyle(element).zIndex), rank: Number(getComputedStyle(element).getPropertyValue("--topology-depth-index")),
      sameWorld: element.closest("[data-topology-world]") === world});
    return {stage: rect(stage), graph: rect(graph), region: rect(region), regionHidden: region.hidden,
      horizon, horizonY: rect(graph).top + graph.clientTop + graph.clientHeight * parseFloat(horizon) / 100,
      regionPosition: getComputedStyle(region).position,
      regionLayer: Number(getComputedStyle(region).zIndex),
      worldLayer: Number(getComputedStyle(world).zIndex), exitLinkLayer: Number(getComputedStyle(stage.querySelector("[data-topology-exit-links]")).zIndex),
      camera: [Number(graph.dataset.cameraYaw), Number(graph.dataset.cameraPitch)],
      radius: [Number(graph.dataset.cameraRadiusX), Number(graph.dataset.cameraRadiusY)],
      skyInset: Number(graph.dataset.skyInset),
      baseNodeHeight: parseFloat(graphStyle.getPropertyValue("--topology-node-height")),
      baseHubHeight: parseFloat(graphStyle.getPropertyValue("--topology-hub-height")),
      pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      nodes: [...graph.querySelectorAll("[data-topology-node]")].map(element => ({id: element.dataset.topologyNode, box: rect(element),
        height: element.offsetHeight, portsHeight: element.querySelector("[data-topology-node-ports]")?.offsetHeight || 0, ...spatial(element)})),
      galaxies: [...region.querySelectorAll("[data-topology-galaxy]")].map(element => ({
        id: element.dataset.topologyGalaxy, objectId: element.dataset.topologyObject, active: element.classList.contains("is-active"), text: element.textContent.trim(),
        ...spatial(element),
        box: rect(element), symbol: rect(element.querySelector("svg")), stateBox: rect(element.querySelector(".topology-galaxy-state")),
        title: element.getAttribute("title"), label: element.getAttribute("aria-label"),
        visible: !element.hidden && getComputedStyle(element).display !== "none" && !!element.getClientRects().length,
        visual: {self: styles(element), children: [...element.querySelectorAll("svg, strong, span, path, ellipse, circle")].map(styles)},
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        name: (() => {const name = element.querySelector(".topology-galaxy-name"); return name ? {text: name.textContent, box: rect(name),
          scrollWidth: name.scrollWidth, clientWidth: name.clientWidth, scrollHeight: name.scrollHeight, clientHeight: name.clientHeight,
          ellipsis: getComputedStyle(name).textOverflow === "ellipsis"} : null;})(),
      })),
      links: [...stage.querySelectorAll("[data-topology-exit-link]")].map(element => ({
        id: element.dataset.topologyExitLink, source: element.dataset.source, target: element.dataset.target,
        active: element.classList.contains("is-active"), visual: styles(element),
        visible: !element.closest("[hidden]") && !!element.getClientRects().length && getComputedStyle(element).visibility !== "hidden"
          && getComputedStyle(element).display !== "none" && Number(getComputedStyle(element).opacity) > 0,
        marker: ["markerStart", "markerMid", "markerEnd"].map(key => getComputedStyle(element)[key]),
        permissionEdge: element.hasAttribute("data-topology-edge") || element.hasAttribute("data-topology-spoke"),
        scopes: element.dataset.scopes || element.dataset.scope || null,
      }))};
  });
}

function assertCompactTail(value, model, label) {
  const hub = value.nodes.find(node => node.id === "hub"), centerX = (hub.box.left + hub.box.right) / 2,
    centerY = (hub.box.top + hub.box.bottom) / 2;
  const scopeLines = model.links.reduce((maximum, edge) => Math.max(maximum, Math.min(3, edge.scopes.length)), 0);
  const scopeHeight = scopeLines ? 6 + 15 * scopeLines : 0;
  // Independently reconstruct the reserved card envelope from rendered body
  // sizes and the model's possible scopes, rather than trusting a padding flag.
  const tallest = Math.max(...value.nodes.map(node => {
    if (node.id === "hub") return Math.max(node.height, value.baseHubHeight + scopeHeight);
    const body = Math.max(value.baseNodeHeight, node.height - (node.portsHeight ? node.portsHeight + 2 : 0));
    return Math.max(node.height, body + scopeHeight);
  }));
  const envelopeBottom = centerY + value.radius[1] + tallest / 2;
  const tail = value.graph.bottom - envelopeBottom;
  assert(Number.isFinite(tail) && tail >= 18 && tail <= 22,
    `${label}: all-angle envelope ends with only 20px of bottom breathing room, not a duplicated sky reserve (${tail}px)`);
  const [yaw, pitch] = value.camera, cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  for (const node of value.nodes) {
    const [x, y, z] = node.xyz, rotatedX = cy * x + sy * z, rotatedY = cp * y - sp * (-sy * x + cy * z);
    assert(Math.abs((node.box.left + node.box.right) / 2 - centerX - rotatedX * value.radius[0]) < 1.1
      && Math.abs((node.box.top + node.box.bottom) / 2 - centerY - rotatedY * value.radius[1]) < 1.1,
    `${label}/${node.id}: the measured projection corroborates the reported camera radius`);
    assert(Math.hypot(x, y, z) <= 1.001, `${label}/${node.id}: each real node fits the all-angle unit-ball envelope`);
    assert(node.box.bottom <= value.graph.bottom - 18 && node.box.top >= value.graph.top,
      `${label}/${node.id}: shortening the tail cannot clip actual node cards`);
  }
  return {tail, envelopeBottom, actualTail: value.graph.bottom - Math.max(...value.nodes.map(node => node.box.bottom))};
}

function assertStableFrame(before, after, label) {
  assert.equal(after.graph.height, before.graph.height, `${label}: rotation/selection never resizes the document`);
  assert.equal(after.skyInset, before.skyInset, `${label}: the one-sided sky reserve stays fixed`);
  assert.deepEqual(after.radius, before.radius, `${label}: the internal scene is not compressed to hide tail padding`);
  const center = value => {
    const box = value.nodes.find(node => node.id === "hub").box;
    return [(box.left + box.right) / 2 - value.graph.left, (box.top + box.bottom) / 2 - value.graph.top];
  };
  assert(center(before).every((value, axis) => Math.abs(value - center(after)[axis]) < 1),
    `${label}: the rendered moon stays at one physical rotation pivot`);
}

async function assertExitEdges(page, label) {
  const endpoints = await hook(page, "stage").evaluate(stage => {
    const hub = stage.querySelector('[data-topology-node="hub"]'), hubBox = hub.getBoundingClientRect();
    return [...stage.querySelectorAll("[data-topology-exit-link]")].flatMap(line => {
      const target = stage.querySelector(`[data-topology-galaxy="${line.dataset.topologyExitLink}"]`), box = target.getBoundingClientRect();
      const style = getComputedStyle(line);
      if (line.closest("[hidden]") || !line.getClientRects().length || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return [];
      const matrix = line.getScreenCTM(), length = line.getTotalLength();
      const start = line.getPointAtLength(0).matrixTransform(matrix), end = line.getPointAtLength(length).matrixTransform(matrix);
      return [{id: line.dataset.topologyExitLink, length,
        hubRadius: Math.hypot((start.x - (hubBox.left + hubBox.right) / 2) / (hubBox.width / 2 + 7),
          (start.y - (hubBox.top + hubBox.bottom) / 2) / (hubBox.height / 2 + 7)),
        exitDistance: Math.max(box.left - end.x, end.x - box.right, box.top - end.y, end.y - box.bottom)}];
    });
  });
  for (const endpoint of endpoints) {
    assert(endpoint.length > 0, `${label}: the VPS-to-exit connection has a visible extent`);
    assert(Math.abs(endpoint.hubRadius - 1) < .04, `${label}/${endpoint.id}: the connection starts outside the actual central moon`);
    assert(endpoint.exitDistance >= 5 && endpoint.exitDistance <= 9,
      `${label}/${endpoint.id}: the connection ends outside the content-sized exit card (${endpoint.exitDistance})`);
  }
  return endpoints;
}

async function assertGalaxies(page, model, activeIds, label) {
  const value = await galaxyState(page);
  value.bottomClearance = assertCompactTail(value, model, label);
  assert(value.worldLayer > value.exitLinkLayer, `${label}: exit paths remain behind real node cards and their labels`);
  assert(value.regionLayer > value.exitLinkLayer, `${label}: exit paths remain behind every remote name, not only their own endpoint`);
  assert(value.pageWidth <= value.viewport + 1, `${label}: the complete page fits narrow screens`);
  assert(value.horizon.endsWith("%") && Number.isFinite(value.horizonY)
    && value.horizonY > value.graph.top && value.horizonY < value.graph.bottom,
    `${label}: the sky boundary comes from the actual canvas horizon variable`);
  for (const edge of ["left", "right", "top", "bottom", "width", "height"])
    assert(Math.abs(value.stage[edge] - value.graph[edge]) <= 1,
      `${label}: internal graph retains the complete stage ${edge} instead of losing space to a rail (${value.stage[edge]} vs ${value.graph[edge]})`);
  assert.equal(value.regionPosition, "absolute", `${label}: exit scenery overlays the same canvas rather than consuming a layout column`);
  assert.equal(await hook(page, "exit-region").locator("h2, h3").count(), 0,
    "Exit scenery does not become a titled secondary panel");
  assert.equal(await hook(page, "exit-field").count(), 0, "The separate top exit strip is removed, not merely hidden");
  assert.equal(await hook(page, "galaxy").count(), value.galaxies.length, "Every exit is inside the same canvas's nonrotating scenery layer");
  assert.deepEqual(sorted(value.galaxies.map(g => g.id)), sorted(model.exits.map(exit => exit.id)), `${label}: all exits appear at once, with no pagination or unknown IDs`);
  assert.deepEqual(sorted(value.galaxies.filter(g => g.active).map(g => g.id)), sorted(activeIds), `${label}: only the selected node's configured exits are illuminated`);
  assert.equal(new Set(value.links.map(line => line.id)).size, value.links.length, `${label}: configured associations do not duplicate paths`);
  assert(value.links.every(line => model.exits.some(exit => exit.id === line.id)), `${label}: only actual exit resources may receive a configuration path`);
  assert.deepEqual(sorted(value.links.filter(line => line.visible).map(line => line.id)), sorted(activeIds), `${label}: only the selected configured exit connections are visible`);
  for (const line of value.links) {
    assert.equal(line.source, "hub"); assert.equal(line.target, "exit:" + line.id);
    assert(!line.permissionEdge && line.scopes === null, "Exit associations never masquerade as internal access permissions or port scopes");
    assert(line.marker.every(value => value === "none"), "Configuration paths cannot imply directed live traffic");
  }
  for (const galaxy of value.galaxies) {
    const expected = model.exits.find(exit => exit.id === galaxy.id);
    assert.equal(galaxy.objectId, undefined, "Fixed exits cannot be dragged as 3D scene objects");
    assert(!galaxy.sameWorld, `${label}: exits stay outside the rotating world`);
    assert(galaxy.visible, `${label}: every configured galaxy remains rendered`);
    assert(galaxy.text.includes(expected.name), `${label}: the complete safe exit name is available as text`);
    assert(galaxy.name && galaxy.name.text === expected.name && !galaxy.name.ellipsis
      && galaxy.name.scrollWidth <= galaxy.name.clientWidth + 1 && galaxy.name.scrollHeight <= galaxy.name.clientHeight + 1,
      `${label}: the complete visible exit name wraps rather than clipping or becoming an ellipsis`);
    assert(galaxy.box.left >= value.region.left - 1 && galaxy.box.right <= value.region.right + 1,
      `${label}: exits stay inside their region without horizontal overflow`);
    assert(galaxy.box.top >= value.region.top - 1 && galaxy.box.bottom <= value.region.bottom + 1);
    for (const [part, box] of [["symbol", galaxy.symbol], ["name", galaxy.name.box], ["state", galaxy.stateBox]]) {
      assert(box.top >= value.graph.top,
        `${label}/${galaxy.id}: the ${part} remains inside the sky, even with camera parallax`);
      assert(box.bottom < value.horizonY - 8,
        `${label}/${galaxy.id}: the ${part} remains above the visible horizon with an 8px gap (${box.bottom} vs ${value.horizonY})`);
    }
    // The symbol may paint a bounded 12px parallax beyond its static box;
    // the actual name itself is still required to fit strictly above.
    assert(galaxy.scrollWidth <= galaxy.clientWidth + 12 && galaxy.scrollHeight <= galaxy.clientHeight + 12,
      `${label}/${galaxy.id}: only the bounded symbol parallax may extend its card (${galaxy.scrollWidth}/${galaxy.clientWidth}, ${galaxy.scrollHeight}/${galaxy.clientHeight})`);
    for (const other of value.galaxies) if (galaxy.id !== other.id) {
      const overlapX = Math.min(galaxy.box.right, other.box.right) - Math.max(galaxy.box.left, other.box.left);
      const overlapY = Math.min(galaxy.box.bottom, other.box.bottom) - Math.max(galaxy.box.top, other.box.top);
      assert(overlapX < 1 || overlapY < 1, `${label}: neighboring galaxy names never overlap`);
    }
    for (const node of value.nodes) {
      const overlapX = Math.min(galaxy.box.right, node.box.right) - Math.max(galaxy.box.left, node.box.left);
      const overlapY = Math.min(galaxy.box.bottom, node.box.bottom) - Math.max(galaxy.box.top, node.box.top);
      assert(overlapX < 1 || overlapY < 1, `${label}: scenery placement does not bury exit ${galaxy.id} inside ${node.id}`);
    }
  }
  assert.equal(await page.locator("[data-topology-node][data-topology-galaxy]").count(), 0,
    "Exits remain separate from internal nodes and cannot acquire internal permission arrows");
  assert.equal(await hook(page, "node").count(), model.nodes.length);
  const objects = value.nodes;
  assert(objects.every(object => object.sameWorld), "Only internal nodes share the rotating projected world");
  assert.equal(new Set(objects.map(object => object.rank)).size, objects.length, "Depth ordering remains valid for internal nodes");
  for (const object of objects) for (const other of objects)
    if (object.depth > other.depth + .000001) assert(object.z > other.z, "Internal front/back stacking remains factual");
  if (value.galaxies.length) {
    assert(!value.regionHidden, "A nonempty exit catalog is displayed");
    for (const edge of ["left", "right", "top", "bottom"])
      assert(Math.abs(value.region[edge] - value.graph[edge]) <= 1, "Remote exits share the full internal scene backdrop");
  } else assert(value.regionHidden, "No exit catalog leaves no empty rail");
  const visibleCopy = await page.locator("body").innerText();
  assert(!visibleCopy.includes("星系"), "The visual metaphor does not become user-visible product terminology");
  assert.deepEqual(await page.locator("[aria-label], [title]").evaluateAll(elements => elements
    .flatMap(element => [element.getAttribute("aria-label"), element.getAttribute("title")]).filter(value => value?.includes("星系"))), [],
  "Accessible labels and tooltips also use exit terminology");
  await assertExitEdges(page, label);
  return value;
}

async function assertAddresses(page, model, label) {
  const metrics = await hook(page, "node").evaluateAll(nodes => nodes.map(node => {
    const element = node.querySelector("[data-topology-node-address]");
    if (!element) return {id: node.dataset.topologyNode, missing: true};
    const rect = el => {const b = el.getBoundingClientRect(); return {left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height};};
    const style = getComputedStyle(element);
    return {id: node.dataset.topologyNode, text: element.textContent.trim(), box: rect(element), card: rect(node),
      font: parseFloat(style.fontSize), display: style.display, visibility: style.visibility, textOverflow: style.textOverflow,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      content: [...node.querySelectorAll("strong, .topology-node-state, .topology-node-rates, .topology-node-ports")]
        .filter(el => !el.contains(element) && !el.hidden && getComputedStyle(el).display !== "none")
        .map(el => ({text: el.textContent.trim(), box: rect(el)}))};
  }));
  for (const node of metrics) {
    const expected = model.nodes.find(item => item.id === node.id);
    assert(!node.missing, `${label}/${node.id}: each node has an inline IP row`);
    if (expected.address) assert.equal(node.text, expected.address, `${label}: full IPv4/IPv6 address, not an abbreviated or invented address`);
    else assert(/无.*IP|未分配.*IP|地址未知|地址未提供/i.test(node.text), `${label}: missing address is honestly identified (${node.text})`);
    assert(node.font >= 10 && node.display !== "none" && node.visibility !== "hidden", `${label}: addresses remain legible`);
    assert(node.box.width > 0 && node.box.height > 0);
    assert(node.box.left >= node.card.left - 1 && node.box.right <= node.card.right + 1 && node.box.top >= node.card.top - 1 && node.box.bottom <= node.card.bottom + 1,
      `${label}/${node.id}: the IP is inside its own node, including the moon`);
    assert(node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
      `${label}/${node.id}: the address fits completely, including full IPv6`);
    assert.notEqual(node.textOverflow, "ellipsis", `${label}: IP addresses do not become ambiguous ellipses`);
    for (const other of node.content) {
      const overlapX = Math.min(node.box.right, other.box.right) - Math.max(node.box.left, other.box.left);
      const overlapY = Math.min(node.box.bottom, other.box.bottom) - Math.max(node.box.top, other.box.top);
      assert(overlapX < .5 || overlapY < .5, `${label}/${node.id}: address cannot cover ${other.text}`);
    }
  }
  return metrics;
}

async function clearOnBlank(page) {
  await hook(page, "graph").evaluate(graph => scrollTo(0, scrollY + graph.getBoundingClientRect().top + graph.clientHeight / 2 - innerHeight / 2));
  const point = await hook(page, "graph").evaluate(graph => {
    const b = graph.getBoundingClientRect();
    for (const y of [180, 250, 350, 450, 550, 650]) for (const x of [b.left + 12, b.right - 12, b.left + 35, b.right - 35]) {
      const hit = document.elementFromPoint(x, y);
      if (y > b.top + 8 && y < b.bottom - 8 && y < innerHeight - 100 && hit?.closest("[data-topology-graph]") === graph
        && !hit.closest("[data-topology-node], [data-topology-galaxy]")) return {x, y};
    }
    return null;
  });
  assert(point, "A real visible canvas blank is available for deselection");
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => !document.querySelector('[data-topology-node][aria-pressed="true"]'));
  await settle(page);
}

async function rotationAndRearrange(page, model, label) {
  await hook(page, "reset").click(); await settle(page);
  const before = await assertGalaxies(page, model, model.selected.exit_ids, label + "/before-rotation");
  await orbit(page, "right", 2); await settle(page);
  const after = await assertGalaxies(page, model, model.selected.exit_ids, label + "/rotated");
  assertStableFrame(before, after, label + "/rotated");
  assert.notDeepEqual(after.camera, before.camera);
  for (const exit of before.galaxies) {
    const fixed = after.galaxies.find(item => item.id === exit.id);
    assertFixedExit(before, after, exit, fixed, "Rotating the moon scene cannot move an exit label");
    assertParallax(before, after, exit, fixed);
  }
  assert(before.galaxies.some(exit => {
    const moved = after.galaxies.find(item => item.id === exit.id);
    return Math.hypot(moved.symbol.left - after.stage.left - exit.symbol.left + before.stage.left,
      moved.symbol.top - after.stage.top - exit.symbol.top + before.stage.top) > .1;
  }), "Remote symbols provide actual subtle camera parallax while their labels stay anchored");
  await assertAddresses(page, model, label + "/rotated");
  assert(after.nodes.some(node => Math.hypot(...node.xy.map((coordinate, axis) => coordinate - before.nodes.find(item => item.id === node.id).xy[axis])) > 1),
    "The internal 3D scene still visibly rotates");
  const angles = [];
  for (const [direction, count] of [["up", 3], ["left", 8], ["down", 7], ["right", 12]]) {
    await orbit(page, direction, count); await settle(page);
    const rotated = await assertGalaxies(page, model, model.selected.exit_ids, `${label}/rotated-${direction}-${count}`);
    assertStableFrame(before, rotated, `${label}/rotated-${direction}-${count}`);
    for (const exit of before.galaxies) {
      const current = rotated.galaxies.find(item => item.id === exit.id);
      assertFixedExit(before, rotated, exit, current, "Remote labels stay anchored across camera yaw and pitch");
      assertParallax(before, rotated, exit, current);
    }
    angles.push(rotated.camera);
  }
  await hook(page, "reset").click(); await settle(page);
  const reset = await assertGalaxies(page, model, model.selected.exit_ids, label + "/rearranged");
  assertStableFrame(before, reset, label + "/rearranged");
  assert.deepEqual(reset.camera, before.camera, "Auto-arrange resets the internal camera");
  const spatial = objects => objects.map(({id, xyz, xy, depth}) => ({id, xyz, xy, depth}));
  for (const exit of before.galaxies) assertFixedExit(before, reset, exit, reset.galaxies.find(item => item.id === exit.id),
    "Auto-arrange must not disturb the fixed exit catalog");
  assert.deepEqual(spatial(reset.nodes), spatial(before.nodes), "Internal node rearrangement remains deterministic");
  return {before: before.galaxies, rotated: after.galaxies, angles};
}

function assertFixedExit(before, after, first, second, message) {
  for (const [edge, origin] of [["left", "left"], ["top", "top"], ["right", "left"], ["bottom", "top"]]) {
    assert(Math.abs(first.box[edge] - before.stage[origin] - second.box[edge] + after.stage[origin]) < 1,
      `${message}: ${first.id}/${edge}: ${first.box[edge] - before.stage[origin]} -> ${second.box[edge] - after.stage[origin]}`);
    assert(Math.abs(first.name.box[edge] - before.stage[origin] - second.name.box[edge] + after.stage[origin]) < 1,
      `${message}: complete text ${first.id}/${edge} remains stable`);
  }
}

function assertParallax(before, after, first, second) {
  const x = second.symbol.left - after.stage.left - first.symbol.left + before.stage.left;
  const y = second.symbol.top - after.stage.top - first.symbol.top + before.stage.top;
  assert(Math.hypot(x, y) <= 12.1, `Remote symbol ${first.id} uses restrained parallax instead of orbiting (${x}, ${y})`);
}

async function scrollFromExit(page, context, engine, model, label) {
  let start = null, identifier = null;
  for (const exit of model.exits) {
    const item = page.locator(`[data-topology-galaxy="${exit.id}"]`);
    await item.scrollIntoViewIfNeeded();
    start = await item.evaluate(element => {
      const b = element.getBoundingClientRect();
      for (const fy of [.5, .3, .7]) for (const fx of [.5, .3, .7]) {
        const p = {x: b.left + b.width * fx, y: b.top + b.height * fy}, hit = document.elementFromPoint(p.x, p.y);
        if (p.y > 160 && p.y < innerHeight - 160 && (hit === element || element.contains(hit))) return p;
      }
      return null;
    });
    if (start) {identifier = exit.id; break;}
  }
  assert(start, "A visible exit offers a native scroll-start surface");
  const before = await galaxyState(page), scrollBefore = await page.evaluate(() => scrollY);
  assert.equal(await hook(page, "graph").evaluate(graph => getComputedStyle(graph).touchAction), "pan-y pinch-zoom");
  assert.notEqual(await page.locator(`[data-topology-galaxy="${identifier}"]`).evaluate(element => getComputedStyle(element).touchAction), "none");
  if (engine === "chromium") {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{id: 1, ...start}]});
      for (let index = 1; index <= 8; index++) {
        await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{id: 1, x: start.x, y: start.y - index * 20}]});
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
    } finally {await cdp.detach();}
    await page.waitForFunction(before => scrollY > before + 65, scrollBefore);
  } else {
    await page.evaluate(start => {
      const target = document.elementFromPoint(start.x, start.y);
      for (const [type, delta] of [["pointerdown", 0], ["pointermove", -100], ["pointercancel", -100]])
        target.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 973,
          pointerType: "touch", isPrimary: true, clientX: start.x, clientY: start.y + delta}));
    }, start);
  }
  await settle(page);
  const after = await assertGalaxies(page, model, model.selected.exit_ids, label + "/native-scroll");
  assert.deepEqual(after.camera, before.camera, "Vertical scrolling that starts on an exit cannot rotate the scene");
  for (const exit of before.galaxies) assertFixedExit(before, after, exit, after.galaxies.find(item => item.id === exit.id),
    "Reading-mode scroll cannot drag an exit");
  return {identifier, native: engine === "chromium", scrollDelta: await page.evaluate(() => scrollY) - scrollBefore};
}

async function run(browser, engine, width, theme) {
  const context = await browser.newContext({viewport: {width, height: 1000}, deviceScaleFactor: width < 768 ? 3 : 1,
    reducedMotion: "reduce", ...(width < 768 ? {isMobile: true, hasTouch: true} : {})});
  const label = `${engine}-${width}-${theme}`;
  let page, revision = "models";
  try {
    await context.addInitScript(theme => localStorage.setItem("server-kit-theme", theme), theme);
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) {report.external.push(url.href); return route.abort();}
      if (isJSON(url)) return route.fulfill({status: 200, contentType: "application/json",
        body: JSON.stringify(packet[revision][url.searchParams.get("node")] || packet[revision][initial])});
      if (isTopology(url) && route.request().isNavigationRequest()) {
        const response = await route.fetch(), html = await response.text();
        const expression = /(<script\b[^>]*\bid="topology-data"[^>]*>)[\s\S]*?(<\/script>)/;
        assert(expression.test(html), "The real preview returns the production topology template and initial JSON slot");
        const json = JSON.stringify(packet[revision][initial]).replaceAll("<", "\\u003c");
        return route.fulfill({response, body: html.replace(expression, (_, before, after) => before + json + after)});
      }
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", error => report.errors.push({label, message: error.message}));
    await page.goto(new URL("login/", base).href);
    await page.locator('[name="username"]').fill("preview");
    await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/", base).href), page.locator('button[type="submit"]').click()]);
    page.on("request", request => report.requests.push({label, method: request.method(), url: request.url()}));
    await page.goto(new URL("network/topology/", base).href);
    await hook(page, "node").first().waitFor(); await settle(page); await assertFixedControls(page);
    const baseline = await assertGalaxies(page, packet.models[initial], [], label + "/overview");
    const addresses = await assertAddresses(page, packet.models[initial], label + "/overview");
    const states = [];
    for (const [id, direction] of [[initial, "forward"], [phone, "forward"], [phone, "reverse"], [noExits, "forward"],
      ["awg:lab-server", "forward"], ["hub", "reverse"], [packet.ipv6_node, "forward"]]) {
      await select(page, id, direction);
      const model = packet.models[id];
      const value = await assertGalaxies(page, model, model.selected.exit_ids, `${label}/${id}/${direction}`);
      assertStableFrame(baseline, value, `${label}/${id}/${direction}`);
      for (const exit of baseline.galaxies) assertFixedExit(baseline, value, exit, value.galaxies.find(item => item.id === exit.id),
        `${label}/${id}/${direction}: switching the selected node does not reorder or shift exits (graph ${baseline.graph.height} -> ${value.graph.height})`);
      await assertAddresses(page, model, `${label}/${id}/${direction}`);
      await assertInlinePorts(page, model.links, id, direction);
      await assertCardEdges(page); await assertMarkerGeometry(page);
      for (const active of value.galaxies.filter(g => g.active)) {
        const inactive = baseline.galaxies.find(g => g.id === active.id);
        assert.notDeepEqual(active.visual, inactive.visual, "Illumination changes visible rendering, not only a testable class");
      }
      states.push({id, direction, active: value.galaxies.filter(g => g.active).map(g => g.id)});
    }
    await select(page, phone);
    const rotation = await rotationAndRearrange(page, packet.models[phone], label);
    const scroll = width < 768 ? await scrollFromExit(page, context, engine, packet.models[phone], label) : null;
    const filename = label + ".png";
    await page.locator(".topology-map-pane").screenshot({path: path.join(directory, filename), style: ".skip-link:not(:focus){visibility:hidden!important}"});
    report.screenshots.push(filename);
    await clearOnBlank(page);
    await assertGalaxies(page, packet.models[phone], [], label + "/cleared");
    await select(page, initial);
    revision = "changed";
    await hook(page, "refresh").click(); await settle(page);
    await assertGalaxies(page, packet.changed[initial], packet.changed[initial].selected.exit_ids, label + "/refreshed");
    // This selection was cached before refresh: it must not revive old assignments.
    await select(page, phone);
    await assertGalaxies(page, packet.changed[phone], packet.changed[phone].selected.exit_ids, label + "/refreshed-cache");
    revision = "empty";
    await hook(page, "refresh").click(); await settle(page);
    await assertGalaxies(page, packet.empty[phone], [], label + "/no-exits");
    await assertAddresses(page, packet.empty[phone], label + "/no-exits");
    // Start from an untouched empty-catalog layout, then add the exits through
    // a normal refresh. New objects must trigger safe automatic placement.
    await page.reload(); await hook(page, "node").first().waitFor(); await settle(page);
    await select(page, initial);
    await assertGalaxies(page, packet.empty[initial], [], label + "/empty-initial-layout");
    revision = "models";
    await hook(page, "refresh").click(); await settle(page);
    const restored = await assertGalaxies(page, packet.models[initial], packet.models[initial].selected.exit_ids,
      label + "/new-exits-auto-layout");
    for (const [index, node] of restored.nodes.entries()) for (const other of restored.nodes.slice(index + 1)) {
      const overlapX = Math.min(node.box.right, other.box.right) - Math.max(node.box.left, other.box.left);
      const overlapY = Math.min(node.box.bottom, other.box.bottom) - Math.max(node.box.top, other.box.top);
      assert(overlapX < 1 || overlapY < 1, `${label}: adding exits to the untouched layout cannot overlap ${node.id} and ${other.id}`);
    }
    await assertAddresses(page, packet.models[initial], label + "/new-exits-auto-layout");
    let sixteen = null;
    if (label === "chromium-1440-dark") {
      // Absolute-positioned children must remeasure on a same-ID name update;
      // the canvas/region ResizeObserver alone will not notice the label growing.
      revision = "renamed";
      await hook(page, "refresh").click(); await settle(page);
      const renamed = await assertGalaxies(page, packet.renamed[initial], packet.renamed[initial].selected.exit_ids,
        label + "/same-id-longer-name");
      assert(renamed.galaxies[0].name.text.length > packet.models[initial].exits[0].name.length,
        "The same-ID rename fixture expands a previously short name");
      revision = "models";
      await hook(page, "refresh").click(); await settle(page);
      await assertGalaxies(page, packet.models[initial], packet.models[initial].selected.exit_ids, label + "/name-restored");
      revision = "sixteen";
      await hook(page, "refresh").click(); await settle(page);
      await select(page, phone);
      const model = packet.sixteen[phone];
      assert.equal(model.exits.length, 16, "The maximum catalog fixture is produced by the real model projector");
      const desktop = await assertGalaxies(page, model, model.selected.exit_ids, label + "/sixteen-desktop");
      await assertAddresses(page, model, label + "/sixteen-desktop");
      const exit = hook(page, "galaxy").first();
      await exit.scrollIntoViewIfNeeded();
      const beforeDrag = await galaxyState(page), box = await exit.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 + 30, {steps: 6}); await page.mouse.up();
      await settle(page);
      const afterDrag = await assertGalaxies(page, model, model.selected.exit_ids, label + "/fixed-exit-not-draggable");
      assert.deepEqual(afterDrag.camera, beforeDrag.camera, "Dragging a fixed exit cannot rotate the internal scene");
      for (const item of beforeDrag.galaxies) assertFixedExit(beforeDrag, afterDrag, item, afterDrag.galaxies.find(other => other.id === item.id),
        "A fixed remote exit cannot be dragged into the internal scene");
      await exit.click(); // Collapse the drag's native text selection before the visual capture.
      await page.setViewportSize({width: 390, height: 1000});
      await settle(page);
      const narrow = await assertGalaxies(page, model, model.selected.exit_ids, label + "/sixteen-resized");
      await assertAddresses(page, model, label + "/sixteen-resized");
      const image = "sixteen-exits-390.png";
      await page.locator(".topology-map-pane").screenshot({path: path.join(directory, image)});
      report.screenshots.push(image);
      sixteen = {desktop, narrow};
    }
    const rendered = await page.locator("body").textContent();
    for (const forbidden of ["synthetic-topology-private-credential-never-render", "private-proxy.example", "private-subscription.example"])
      assert(!rendered.includes(forbidden), "Neither raw exit credentials nor server/subscription endpoints are rendered");
    report.cases.push({label, states, addresses, baseline, rotation, scroll, sixteen});
    console.log(`Passed ${label}`);
  } catch (error) {
    if (page) {
      const file = label + "-failure.png";
      await page.locator(".topology-map-pane").screenshot({path: path.join(directory, file)}).then(() => report.screenshots.push(file)).catch(() => {});
    }
    throw error;
  } finally {await context.close();}
}

(async () => {try {
  for (const [engine, factory] of [["chromium", chromium], ["webkit", webkit]]) {
    if (caseFilter && !caseFilter.startsWith(engine + "-")) continue;
    const browser = await factory.launch();
    try {for (const width of [1440, 390, 320]) for (const theme of ["dark", "light"])
      if (!caseFilter || caseFilter === `${engine}-${width}-${theme}`) await run(browser, engine, width, theme);
    } finally {await browser.close();}
  }
  assert.equal(report.cases.length, report.expectedCaseCount);
  assert.equal(createHash("sha256").update(fs.readFileSync(path.join(__dirname, "../web/static/topology.js"))).digest("hex"), report.runtimeSHA256,
    "The runtime source remains unchanged throughout the browser matrix");
  assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
  assert(report.requests.every(item => item.method === "GET" && !item.url.includes("/__preview__/")),
    "After synthetic login, interaction only reads and never mutates preview scenarios or network configuration");
} catch (error) {report.failure = error.stack; process.exitCode = 1; console.error(error.stack);}
finally {fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({directory, cases: report.cases.length, screenshots: report.screenshots.length, failure: report.failure}, null, 2));}
})();
