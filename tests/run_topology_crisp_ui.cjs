"use strict";

// Synthetic preview only. Guards against forced raster caching, and verifies
// high-DPI zoom geometry; screenshots alone cannot prove every iPhone GPU path.
const {chromium, webkit} = require("playwright");
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
    const world = graph.querySelector("[data-topology-world]"), css = getComputedStyle(world);
    const scale = Number(graph.dataset.viewportScale);
    const graphBox = graph.getBoundingClientRect();
    return {scale, willChange: css.willChange, transform: css.transform,
      nodeCount: world.querySelectorAll("[data-topology-node]").length,
      nodes: [...world.querySelectorAll("[data-topology-node]")].map(node => {
        const box = node.getBoundingClientRect();
        const name = node.querySelector("strong");
        return {id: node.dataset.topologyNode, width: node.offsetWidth, height: node.offsetHeight,
          screenWidth: box.width, screenHeight: box.height, font: getComputedStyle(name).fontSize,
          x: Number(node.dataset.worldX), y: Number(node.dataset.worldY),
          screenX: box.left + box.width / 2 - graphBox.left,
          screenY: box.top + box.height / 2 - graphBox.top,
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

async function zoomTo(page, target) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const current = await page.locator("[data-topology-graph]").getAttribute("data-viewport-scale");
    if (Math.abs(Number(current) - target) < 1e-8) return;
    await page.locator("[data-topology-graph]").evaluate((graph, wanted) => {
      const rect = graph.getBoundingClientRect();
      graph.dispatchEvent(new WheelEvent("wheel", {bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        deltaY: -Math.log(wanted / Number(graph.dataset.viewportScale)) / .003}));
    }, target);
    await settle(page);
  }
  throw new Error(`Cannot reach zoom ${target}`);
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
        await page.locator("[data-topology-graph]").scrollIntoViewIfNeeded();
        await settle(page);
        const initial = await snapshot(page);
        assert(initial.nodeCount > 1);
        for (const scale of [.03, .333, .8, 1, 1.25, 2, 3.5]) {
          await zoomTo(page, scale);
          const current = await snapshot(page);
          assert.equal(current.willChange, "auto", "Never keep the zoomed graph in a forced raster layer");
          assert(!current.transform.startsWith("matrix3d"), "Do not force 3D compositor promotion");
          assert.equal(current.nodeCount, initial.nodeCount);
          assert.deepEqual(current.edges.map(({scale, ...edge}) => edge), initial.edges.map(({scale, ...edge}) => edge));
          for (const edge of current.edges) assert(Math.abs(edge.scale - scale) < .00001, "SVG follows the same whole-graph zoom");
          for (const [index, node] of current.nodes.entries()) {
            const original = initial.nodes[index];
            for (const property of ["id", "width", "height", "font", "x", "y", "ports"]) {
              assert.deepEqual(node[property], original[property], `${scale}: zoom must not reflow cards or move nodes`);
            }
            assert(Math.abs(node.screenWidth - node.width * scale) < .05);
            assert(Math.abs(node.screenHeight - node.height * scale) < .05);
            assert(Math.abs(node.screenX - (node.x * scale + current.viewX)) < .05);
            assert(Math.abs(node.screenY - (node.y * scale + current.viewY)) < .05);
          }
          if ([1, 3.5].includes(scale)) await page.locator("[data-topology-graph]").screenshot({
            path: path.join(directory, `${engineName}-${density}x-${scale}.png`),
            style: ".skip-link:not(:focus) { visibility: hidden !important; }"});
          report.checks.push({engine: engineName, density, width, scale, nodes: current.nodeCount});
        }
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
