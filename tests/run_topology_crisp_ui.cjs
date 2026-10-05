"use strict";

// Synthetic preview only. Guards against forced raster caching, and verifies
// high-DPI fixed-scale geometry; screenshots cannot prove every iPhone GPU path.
const {chromium, webkit} = require("playwright");
const {assertFixedControls} = require("./topology_fixed_contract.cjs");
const {orbit} = require("./topology_gestures.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const base = new URL(process.argv[2] || "http://127.0.0.1:8877/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password
  && base.pathname === "/" && !base.search && !base.hash, "Use an isolated loopback preview.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-crisp-zoom-"));
const report = {directory, checks: [], compositing: [], errors: [], external: []};
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function snapshot(page) {
  return page.locator("[data-topology-graph]").evaluate(graph => {
    const world = graph.querySelector("[data-topology-world]");
    const scale = Number(graph.dataset.viewportScale);
    const graphBox = graph.getBoundingClientRect();
    const rendering = element => { const style = getComputedStyle(element); return {transform: style.transform,
      willChange: style.willChange, filter: style.filter, backdrop: style.backdropFilter, perspective: style.perspective}; };
    const surfaces = [...world.querySelectorAll("svg.topology-lunar-surface")], moon = surfaces[0];
    return {scale, projection: graph.dataset.projection,
      rootProjection: document.querySelector("[data-topology-root]").dataset.projection,
      layers: [rendering(graph), rendering(world),
        ...[...world.querySelectorAll("[data-topology-node], svg.topology-lunar-surface, svg.topology-lunar-surface *")].map(rendering)],
      moon: {count: surfaces.length, owner: moon?.closest("[data-topology-node]")?.dataset.topologyNode,
        hasOrientation: !!moon?.hasAttribute("data-orientation-yaw") && !!moon?.hasAttribute("data-orientation-pitch"),
        orientation: [Number(moon?.dataset.orientationYaw), Number(moon?.dataset.orientationPitch)],
        visibleFeatures: moon?.getAttribute("data-visible-features"),
        featureShapes: [...(moon?.querySelectorAll("path[data-lunar-feature]") || [])].map(path =>
          ({id: path.dataset.lunarFeature, d: path.getAttribute("d"), visibility: path.getAttribute("visibility")}))},
      width: graph.clientWidth, height: graph.clientHeight, skyInset: Number(graph.dataset.skyInset),
      camera: {yaw: graph.dataset.cameraYaw, pitch: graph.dataset.cameraPitch},
      nodeCount: world.querySelectorAll("[data-topology-node]").length,
      nodes: [...world.querySelectorAll("[data-topology-node]")].map(node => {
        const box = node.getBoundingClientRect();
        const name = node.querySelector("strong");
        return {id: node.dataset.topologyNode, width: node.offsetWidth, height: node.offsetHeight,
          screenWidth: box.width, screenHeight: box.height, font: getComputedStyle(name).fontSize,
          x: Number(node.dataset.worldX), y: Number(node.dataset.worldY),
          screenX: box.left + box.width / 2 - graphBox.left - graph.clientLeft,
          screenY: box.top + box.height / 2 - graphBox.top - graph.clientTop,
          ports: [...node.querySelectorAll("[data-topology-scope]")].map(port => port.dataset.topologyScope)};
      }),
      edges: [...world.querySelectorAll("[data-topology-edge], [data-topology-spoke]")].map(edge => {
        const matrix = edge.getScreenCTM();
        return {scale: Math.hypot(matrix.a, matrix.b), markerStart: edge.getAttribute("marker-start"),
          markerEnd: edge.getAttribute("marker-end"), source: edge.dataset.source, target: edge.dataset.target};
      }),
      viewX: Number(graph.dataset.viewportX), viewY: Number(graph.dataset.viewportY)};
  });
}

function assertCrisp(current, initial, label, preservePositions = true) {
  assert.equal(current.scale, 1, `${label}: the scene remains at native CSS pixel scale`);
  assert.equal(current.projection, "3d"); assert.equal(current.rootProjection, "3d");
  assert.equal(current.moon.count, 1, "The VPS contains exactly one vector lunar surface");
  assert.equal(current.moon.owner, "hub");
  assert.equal(current.moon.hasOrientation, true, "The painted moon exposes both rendered orientation coordinates");
  assert(current.moon.orientation.every(value => Number.isFinite(value) && value >= -Math.PI && value < Math.PI),
    "Lunar orientation remains finite and normalized");
  assert.notEqual(current.moon.visibleFeatures, null, "The renderer reports the actually visible feature set");
  assert(current.moon.featureShapes.length > 0, "The surface contains vector lunar features, not a static fallback disc");
  assert.equal(Number(current.moon.visibleFeatures), current.moon.featureShapes.filter(path => path.visibility === "visible" && path.d).length,
    "Visible-feature metadata describes the actual painted SVG paths");
  for (const layer of current.layers) {
    assert.equal(layer.willChange, "auto", "Never retain the scene in a forced raster layer");
    assert(!layer.transform.startsWith("matrix3d"), "Spatial projection must not force 3D compositor promotion");
    assert.equal(layer.filter, "none"); assert.equal(layer.backdrop, "none"); assert.equal(layer.perspective, "none");
  }
  assert.equal(current.nodeCount, initial.nodeCount);
  assert.deepEqual(current.edges.map(({scale, ...edge}) => edge), initial.edges.map(({scale, ...edge}) => edge));
  for (const edge of current.edges) assert(Math.abs(edge.scale - 1) < .00001, "SVG and cards share native pixel scale");
  for (const [index, node] of current.nodes.entries()) {
    const original = initial.nodes[index];
    for (const property of ["id", "width", "height", "font", "ports", ...(preservePositions ? ["x", "y"] : [])]) {
      assert.deepEqual(node[property], original[property], `${label}: the camera must not resize/reflow cards or alter node data`);
    }
    assert(Math.abs(node.screenWidth - node.width) < .05);
    assert(Math.abs(node.screenHeight - node.height) < .05);
    assert(Math.abs(node.screenX - (node.x + current.viewX)) < .05);
    assert(Math.abs(node.screenY - (node.y + current.viewY)) < .05);
  }
  const hub = current.nodes.find(node => node.id === "hub");
  assert(hub);
  assert(Math.abs(hub.screenX - current.width / 2) < .05, "VPS stays at the horizontal canvas center");
  assert(Number.isFinite(current.skyInset) && current.skyInset >= 0 && current.skyInset < current.height);
  assert(Math.abs(hub.screenY - (current.height + current.skyInset) / 2) < .05,
    "VPS stays at the local scene's fixed center, below the single sky inset");
  if (preservePositions) {
    assert.deepEqual(current.camera, initial.camera, `${label}: removed zoom gestures never rotate or pan the graph`);
    assert.deepEqual(current.moon, initial.moon, `${label}: the painted lunar orientation stays in sync with the stationary camera`);
    assert.equal(current.viewX, initial.viewX); assert.equal(current.viewY, initial.viewY);
  }
}

async function main() {
  for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch();
    try {
      for (const density of [1, 2, 3]) {
        const width = density === 3 ? 390 : 1440;
        const context = await browser.newContext({viewport: {width, height: 1000}, deviceScaleFactor: density, reducedMotion: "reduce"});
        await context.route("**/*", route => {
          if (new URL(route.request().url()).origin === base.origin) return route.continue();
          report.external.push(route.request().url()); return route.abort();
        });
        const page = await context.newPage();
        page.on("pageerror", error => report.errors.push(error.message));
        await page.goto(new URL("login/", base).href);
        await page.locator('[name="username"]').fill("preview");
        await page.locator('[name="password"]').fill("Preview-only-2026!");
        await Promise.all([page.waitForURL(new URL("overview/", base).href), page.locator('button[type="submit"]').click()]);
        await page.goto(new URL("network/topology/", base).href);
        await page.locator("[data-topology-node]").first().waitFor();
        await page.waitForFunction(() => document.querySelector("[data-topology-graph]").dataset.projection === "3d");
        await page.locator("[data-topology-graph]").scrollIntoViewIfNeeded();
        await settle(page);
        const initial = await snapshot(page);
        assert(initial.nodeCount > 1);
        await assertFixedControls(page);
        assert.equal(await page.locator("[data-topology-projection], [data-topology-fit], [data-topology-zoom], [data-topology-zoom-in], [data-topology-zoom-out]").count(), 0,
          "Projection, zoom and fit controls are removed, not hidden");
        for (const action of [{name: "initial"}, {name: "wheel-out", deltaY: 720}, {name: "wheel-in", deltaY: -720},
          {name: "ctrl-wheel", deltaY: -480, ctrlKey: true}, {name: "plus", key: "+"}, {name: "minus", key: "-"}, {name: "equals", key: "="}]) {
          if (action.deltaY !== undefined) {
            const scrollAllowed = await page.locator("[data-topology-graph]").evaluate((graph, action) => {
              const rect = graph.getBoundingClientRect();
              return graph.dispatchEvent(new WheelEvent("wheel", {bubbles: true, cancelable: true,
                clientX: rect.left + rect.width / 2, clientY: rect.top + Math.min(100, rect.height / 2),
                deltaY: action.deltaY, ctrlKey: !!action.ctrlKey}));
            }, action);
            assert.equal(scrollAllowed, true, "The graph does not capture native page scrolling or browser zoom");
          }
          if (action.key) { await page.locator("[data-topology-graph]").focus(); await page.keyboard.press(action.key); }
          await settle(page);
          const current = await snapshot(page);
          assertCrisp(current, initial, action.name);
          report.checks.push({engine: engineName, density, width, action: action.name, scale: current.scale, nodes: current.nodeCount});
        }
        await orbit(page,"right");
        await settle(page);
        const rotated = await snapshot(page);
        assert.notDeepEqual(rotated.camera, initial.camera, "Orbit remains functional while zoom is fixed");
        assert.notDeepEqual(rotated.moon.orientation, initial.moon.orientation, "Real keyboard rotation changes the rendered lunar orientation");
        assert.notDeepEqual(rotated.moon.featureShapes, initial.moon.featureShapes, "The visible lunar geometry changes, not only its orientation metadata");
        assert.notDeepEqual(rotated.nodes.map(node => [node.x, node.y]), initial.nodes.map(node => [node.x, node.y]));
        assertCrisp(rotated, initial, "orbit", false);
        await page.locator("[data-topology-graph]").screenshot({path: path.join(directory, `${engineName}-${density}x-orbit.png`),
          style: ".skip-link:not(:focus) { visibility: hidden !important; }"});
        await page.locator('[data-topology-orbit="reset"]').click();
        await settle(page);
        assertCrisp(await snapshot(page), initial, "orbit-reset");
        await page.locator("[data-topology-graph]").screenshot({path: path.join(directory, `${engineName}-${density}x-native.png`),
          style: ".skip-link:not(:focus) { visibility: hidden !important; }"});
        report.checks.push({engine: engineName, density, width, action: "orbit-and-reset", scale: 1});
        if (engineName === "chromium") {
          // Start after navigation/capture, whose temporary viewport can
          // invalidate the compositor's earlier layer IDs.
          const channel = await context.newCDPSession(page);
          let layers = [];
          channel.on("LayerTree.layerTreeDidChange", event => { layers = event.layers || []; });
          await channel.send("LayerTree.enable");
          let reasons, inspectedLayers;
          for (let attempt = 0; attempt < 50; attempt++) {
            await settle(page);
            // LayerTree events run independently of the page's animation
            // frames; allow the compositor to publish its current tree.
            await new Promise(resolve => setTimeout(resolve, 100));
            const currentLayers = [...layers];
            if (!currentLayers.length) continue;
            try {
              const values = await Promise.all(currentLayers.map(layer =>
                channel.send("LayerTree.compositingReasons", {layerId: layer.layerId})));
              reasons = values.flatMap(value => value.compositingReasons);
              inspectedLayers = currentLayers.length;
              break;
            } catch (error) {
              // A screenshot/telemetry repaint may replace the tree in flight.
              if (!error.message.includes("No layer matching given id")) throw error;
            }
          }
          assert(reasons, "A complete current compositor tree must be inspected");
          assert(!reasons.some(reason => /will-change.*transform/i.test(reason)), "Forced transform cache returned");
          report.compositing.push({engine: engineName, density, layers: inspectedLayers, forcedTransformCaches: 0});
          await channel.detach();
        }
        await context.close();
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
}
main().catch(error => { report.failure = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({directory, checks: report.checks.length, compositing: report.compositing,
    errors: report.errors, external: report.external, failure: report.failure || null}, null, 2));
});
