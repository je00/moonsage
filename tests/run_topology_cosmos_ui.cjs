"use strict";

// Visual/contrast matrix is separate from 2D's intentionally flat contract.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync} = require("node:child_process");
const {chromium, webkit} = require("playwright");
const {auditCosmos} = require("./topology_cosmos_assertions.cjs");
const {orbit} = require("./topology_gestures.cjs");
const {assertFixedCenter, assertFixedControls} = require("./topology_fixed_contract.cjs");
const {inlineSnapshot, geometryFindings, assertInlinePortContents, assertCompactCards, assertCardEdges, assertMarkerGeometry} = require("./topology_inline_assertions.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8880/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname) && Number(base.port) >= 1024
  && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash);
const fixture = spawnSync(process.env.TOPOLOGY_TEST_PYTHON || "python3", [path.join(__dirname, "test_topology_permissions_fixture.py"), "--json"], {encoding: "utf8"});
assert.equal(fixture.status, 0, fixture.stderr);
const packet = JSON.parse(fixture.stdout);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-cosmos-visual-"));
const report = {directory, cases: [], screenshots: [], errors: [], external: [], failures: []};
const hook = (page, name) => page.locator(`[data-topology-${name}]`);
const isJSON = url => url.origin === base.origin && url.pathname === "/network/topology/" && url.searchParams.get("format") === "json";
const settle = async page => {
  await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
function dense(selectedId) {
  const original = packet.models.hub, source = original.nodes.find(node => node.kind === "awg" && node.availability === "enabled");
  const nodes = [original.nodes.find(node => node.id === "hub"), ...Array.from({length: 40}, (_, i) => ({...source, id: `awg:visual-${i}`, name: `visual-device-${String(i).padStart(2, "0")}`, address: `192.0.2.${i + 10}`, protected: false}))];
  const selected = nodes.find(node => node.id === selectedId) || nodes[0];
  const links = nodes.slice(1).flatMap(from => nodes.filter(to => from.id !== to.id).map(to => ({source: from.id, target: to.id, status: "partial", label: "TCP · 22, 443", scopes: ["TCP · 22, 443"]})));
  const yes = {status: "partial", label: "配置授权", summary: "TCP · 22, 443", scopes: ["TCP · 22, 443"], warnings: []};
  const unknown = {status: "unknown", label: "未检测", summary: "VPS 发起访问未检测", scopes: [], warnings: []};
  return {...original, nodes, links, selected, selected_id: selected.id, summary: {nodes: 40, awg: 40, vless: 0, enabled: 40, disabled: 0, pending: 0},
    relations: nodes.filter(node => node.id !== selected.id).map(node => ({node, forward: selected.id === "hub" ? unknown : yes, reverse: node.id === "hub" ? unknown : yes,
      relation: selected.id === "hub" ? "inbound" : node.id === "hub" ? "outbound" : "mutual", label: "配置授权"}))};
}
async function reset(page) {
  await page.locator('button[data-topology-mode="overview"]').click();
  await hook(page, "reset").click(); await settle(page); await assertFixedControls(page);
}
async function capture(page, label) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator(".topology-panel").screenshot({path: path.join(directory, label + ".png"), style: ".skip-link:not(:focus) {visibility:hidden!important;}"});
  report.screenshots.push(label + ".png");
}
async function matrix(browser, engine, width, theme) {
  const context = await browser.newContext({viewport: {width, height: 1000}, deviceScaleFactor: width === 390 ? 3 : width === 320 ? 2 : 1,
    reducedMotion: "no-preference", ...(width < 768 ? {isMobile: true, hasTouch: true} : {})});
  let count = 6, lastModel;
  try {
    await context.addInitScript(theme => localStorage.setItem("server-kit-theme", theme), theme);
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) { report.external.push(url.href); return route.abort(); }
      if (isJSON(url) && count !== 6) {
        const id = url.searchParams.get("node"); lastModel = count === 12 ? packet.models[id] || packet.models[packet.initial_selected] : dense(id);
        return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(lastModel)});
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(new URL("login/", base).href); await page.locator('[name="username"]').fill("preview"); await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/", base).href), page.locator('button[type="submit"]').click()]);
    await context.request.get(new URL("__preview__/scenario/rich/", base).href);
    await page.goto(new URL("network/topology/", base).href); await hook(page, "node").first().waitFor();
    lastModel = await page.locator("#topology-data").evaluate(el => JSON.parse(el.textContent));
    const requests = []; page.on("request", request => requests.push(request.method()));
    for (const wanted of [6, 12, 41]) {
      count = wanted;
      try {
      if (wanted !== 6) {
        await hook(page, "refresh").click(); await page.waitForFunction(count => document.querySelectorAll("[data-topology-node]").length === count, wanted);
      }
      await reset(page); const ids = lastModel.nodes.map(node => node.id), label = `${engine}-${width}-${theme}-${count}`;
      assert.equal(ids.length, wanted);
      await capture(page, `${label}-default`);
      const defaults = await auditCosmos(page, ids);
      assert.deepEqual(geometryFindings(await inlineSnapshot(page)), [], `${label}: every initial card and its contents fit without overlap`);
      const defaultCamera = await hook(page, "graph").evaluate(graph => [graph.dataset.cameraYaw, graph.dataset.cameraPitch]);
      await orbit(page,"right"); await orbit(page,"up"); await settle(page); await assertFixedCenter(page);
      const rotatedCamera = await hook(page, "graph").evaluate(graph => [graph.dataset.cameraYaw, graph.dataset.cameraPitch]);
      assert.notDeepEqual(rotatedCamera, defaultCamera);
      await capture(page, `${label}-rotated`);
      // Physical 3D rotation can make real nodes overlap in projection. Keep
      // exact node/interaction/rendering invariants; default readability is
      // checked separately, never "fixed" by silently moving the XYZ layout.
      const rotated = await auditCosmos(page, ids);
      await reset(page);
      const source = lastModel.links.find(link => link.source !== "hub")?.source;
      assert(source, "Synthetic case includes real configured access to inspect");
      await hook(page, "select").selectOption(source);
      await page.waitForFunction(id => document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode === id, source); await settle(page);
      if (wanted === 6) lastModel = await (await context.request.get(new URL(`network/topology/?format=json&node=${encodeURIComponent(source)}`, base).href)).json();
      await page.locator('[data-topology-direction="forward"]').click(); await settle(page); await assertFixedCenter(page);
      await capture(page, `${label}-targets`);
      const targets = await auditCosmos(page, ids);
      const inline = await inlineSnapshot(page);
      assertCompactCards({...inline, nodes: inline.nodes.filter(node => node.id !== "hub")});
      assertInlinePortContents(inline, lastModel.links, lastModel.selected_id, "forward");
      assert.deepEqual(geometryFindings(inline), [], `${label}: target badges, ports and rate labels retain their own readable space`);
      await assertCardEdges(page, true); await assertMarkerGeometry(page, true, true);
      const controls = await page.locator("[data-topology-reset], [data-topology-orbit], [data-topology-layout-edit]").evaluateAll(items => items.filter(el=>el.getClientRects().length).map(el => ({width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height})));
      assert(controls.every(box => box.width >= 44 && box.height >= 44));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await assertFixedControls(page);
      report.cases.push({engine, width, theme, count, defaults: defaults.contrast, rotated: rotated.contrast, targets: targets.contrast,
        occludedSamples: {defaults: defaults.occludedSamples, rotated: rotated.occludedSamples, targets: targets.occludedSamples},
        captures: {defaults:defaults.capture,rotated:rotated.capture,targets:targets.capture},
        nativeHitOcclusions: {defaults: defaults.nativeHitOcclusions, rotated: rotated.nativeHitOcclusions, targets: targets.nativeHitOcclusions}, realNodes: rotated.ids.length});
      } catch (error) {
        report.failures.push({engine, width, theme, count, error: error.stack});
      }
    }
    assert(requests.every(method => method === "GET"), "Visual inspection performs no management writes");
  } finally { await context.close(); }
}
(async () => {
  try {
    for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await engine.launch();
      try { for (const width of [1440, 390, 320]) for (const theme of ["light", "dark"]) await matrix(browser, name, width, theme); }
      finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
    assert.deepEqual(report.failures, [], "Every independently inspected visual scene must pass; failures are collected without hiding other scenes");
    assert.equal(report.cases.length, 36, "Both engines complete every size/theme/node-count scene");
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({...report, cases: report.cases.length, screenshots: report.screenshots.length,
      failures: report.failures.map(item => ({...item, error: item.error.split("\n")[0]})), failure: report.failure?.split("\n")[0]}, null, 2));
  }
})();
