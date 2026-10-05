"use strict";

// Compare the real home and connection canvas in an isolated synthetic preview.
const {chromium, webkit} = require("playwright");
const {auditCosmos} = require("./topology_cosmos_assertions.cjs");
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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-topology-style-"));
const report = {directory, checks: [], surfaceAudits: [], errors: [], external: []};
const sharedTokens = ["--bg", "--panel", "--text", "--text-soft", "--accent-text", "--line", "--field-bg"];

async function verify(page, reference, overview) {
  await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertFixedControls(page);
  const result = await page.evaluate(tokens => {
    const css = selector => getComputedStyle(document.querySelector(selector));
    const graph = css(".topology-graph"), panel = css(".topology-panel");
    const world = css(".topology-world"), inspector = css(".topology-inspector");
    const select = document.querySelector("[data-topology-select]");
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      tokens: Object.fromEntries(tokens.map(token => [token, getComputedStyle(document.documentElement).getPropertyValue(token).trim()])),
      graph: {background: graph.backgroundColor, image: graph.backgroundImage, font: graph.fontFamily,
        filter: graph.filter, backdropFilter: graph.backdropFilter},
      world: {willChange: world.willChange, filter: world.filter, transform: world.transform},
      panel: {background: panel.backgroundColor, radius: panel.borderTopLeftRadius, shadow: panel.boxShadow},
      inspectorBackground: inspector.backgroundColor,
      select: {height: select.getBoundingClientRect().height, appearance: getComputedStyle(select).appearance,
        radius: getComputedStyle(select).borderTopLeftRadius, font: getComputedStyle(select).fontFamily,
        image: getComputedStyle(select).backgroundImage},
      nodes: [...document.querySelectorAll("[data-topology-node]")].map(node => {
        const style = getComputedStyle(node), dot = getComputedStyle(node.querySelector(".topology-node-dot"));
        return {kind: node.classList.contains("is-hub") ? "hub" : node.classList.contains("kind-vless") ? "vless" : "awg",
          id: node.dataset.topologyNode, shape: node.dataset.topologyShape,
          color: style.color, background: style.backgroundColor, radius: style.borderTopLeftRadius, shadow: style.boxShadow,
          width: node.offsetWidth, height: node.offsetHeight,
          dot: {radius: dot.borderTopLeftRadius, display: dot.display}};
      })
    };
  }, sharedTokens);
  assert.equal(result.overflow, false);
  assert.deepEqual(result.tokens, reference.tokens, "The spatial scene keeps the homepage's shared sky-blue theme tokens");
  const [red, green, blue] = result.graph.background.match(/[\d.]+/g).map(Number);
  assert(blue > green && green > red, "The moon scene uses a cool blue sky in both appearances");
  assert.equal(result.graph.font, reference.font, "Canvas keeps the shared system typography");
  assert(!result.graph.image.includes("url("), "No raster scene or external background on a functional graph");
  assert.equal(result.graph.filter, "none");
  assert.equal(result.graph.backdropFilter, "none");
  assert.equal(result.world.willChange, "auto");
  assert.equal(result.world.filter, "none");
  assert(!result.world.transform.startsWith("matrix3d"));
  assert.equal(result.panel.background, reference.panel, `Panel matches home: ${JSON.stringify(result)}`);
  assert.equal(result.panel.radius, reference.panelRadius);
  assert.equal(result.panel.shadow, "none");
  assert.equal(result.inspectorBackground, reference.panel);
  assert(result.select.height >= 44, "Node picker keeps a full-size touch target in WebKit as well as Chromium");
  assert.equal(result.select.appearance, "none", "Native menu skin cannot shrink the shared control");
  assert.equal(result.select.radius, reference.controlRadius, "The node picker retains the homepage control radius");
  assert.equal(result.select.font, reference.font, "The node picker uses the same shared system font");
  assert(result.select.image.includes("linear-gradient"), "The picker retains a visible disclosure arrow");
  assert(result.nodes.length > 1);
  assert.deepEqual([...new Set(result.nodes.map(node => node.kind))].sort(), ["awg", "hub", "vless"]);
  for (const node of result.nodes) {
    assert.doesNotMatch(node.shadow, /0px 0px 0px [24]px/, "No second outer frame is added to the spatial cards or moon");
    if (node.kind === "hub") {
      assert.equal(node.id, "hub"); assert.equal(node.shape, "moon");
      assert.equal(node.radius, "50%", "The real VPS is a round moon, not an extra decorative node");
      assert.equal(node.width, node.height, "The moon remains circular even when it contains permission ports");
      assert(node.width >= 120, "The central moon stays a legible full-size node on phones");
      assert.equal(node.dot.display, "none", "The moon replaces the tiny hub dot instead of duplicating it");
    } else {
      assert.notEqual(node.shape, "moon");
      assert.equal(node.radius, reference.panelRadius, "Leaf cards use the shared panel's restrained rounded corners");
      assert.equal(node.dot.radius, node.kind === "vless" ? "2px" : "50%", "AWG and VLESS retain distinct shape cues as well as color");
    }
  }
  const expectedIds = await page.locator("#topology-data").evaluate(element => JSON.parse(element.textContent).nodes.map(node => node.id));
  const cosmos = await auditCosmos(page, expectedIds);
  report.surfaceAudits.push({overview, nodes: cosmos.ids.length, contrast: cosmos.contrast, occludedSamples: cosmos.occludedSamples});
  return result;
}

async function verifyLunarViews(page, label) {
  const expectedIds = await page.locator("#topology-data").evaluate(element => JSON.parse(element.textContent).nodes.map(node => node.id));
  const orientation = () => page.locator("svg.topology-lunar-surface").evaluate(surface =>
    [Number(surface.dataset.orientationYaw), Number(surface.dataset.orientationPitch)]);
  const initial = await orientation();
  assert(initial.every(value => Number.isFinite(value)), "The real lunar renderer supplies both orientation coordinates");
  for (const direction of ["right", "up", "left"]) {
    await page.locator('[data-topology-orbit="reset"]').click();
    await orbit(page,direction);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertFixedControls(page);
    const rendered = await orientation();
    assert.notDeepEqual(rendered, initial, `${direction}: orbit changes the actual moon surface, not just the surrounding nodes`);
    // Keep all lunar features/shading painted during the pixel audit. The
    // unchanged 4.5 text / 3 frame requirements apply to each new orientation.
    const cosmos = await auditCosmos(page, expectedIds);
    await page.locator('[data-topology-node="hub"]').screenshot({
      path: path.join(directory, `${label}-moon-${direction}.png`),
      style: ".skip-link:not(:focus), .mobile-nav, .topology-touch-controls { visibility: hidden !important; }"});
    report.surfaceAudits.push({label, direction, orientation: rendered, nodes: cosmos.ids.length, contrast: cosmos.contrast, occludedSamples: cosmos.occludedSamples});
  }
  await page.locator('[data-topology-orbit="reset"]').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await orientation(), initial, "Reset restores the same lunar face without replacing its node");
}

async function main() {
  for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch();
    try {
      for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({viewport: {width, height: 1000}, deviceScaleFactor: 2, reducedMotion: "reduce"});
        await context.route("**/*", route => {
          if (new URL(route.request().url()).origin === base.origin) return route.continue();
          report.external.push(route.request().url()); return route.abort();
        });
        await context.addInitScript(value => localStorage.setItem("server-kit-theme", value), theme);
        const page = await context.newPage();
        page.on("pageerror", error => report.errors.push(error.message));
        await page.goto(base.href);
        const reference = await page.evaluate(tokens => {
          const body = getComputedStyle(document.body), panel = getComputedStyle(document.querySelector(".moon-links"));
          return {background: body.backgroundColor, font: body.fontFamily, panel: panel.backgroundColor,
            tokens: Object.fromEntries(tokens.map(token => [token, getComputedStyle(document.documentElement).getPropertyValue(token).trim()])),
            panelRadius: panel.borderTopLeftRadius, controlRadius: getComputedStyle(document.querySelector(".moon-start")).borderTopLeftRadius};
        }, sharedTokens);
        await page.goto(new URL("login/", base).href);
        await page.locator('[name="username"]').fill("preview");
        await page.locator('[name="password"]').fill("Preview-only-2026!");
        await Promise.all([page.waitForURL(new URL("overview/", base).href), page.locator('button[type="submit"]').click()]);
        await page.goto(new URL("network/topology/", base).href);
        await page.locator("[data-topology-node]").first().waitFor();
        await page.waitForFunction(() => document.querySelector("[data-topology-graph]").dataset.projection === "3d");
        for (const mode of ["overview", "relations"]) {
          if (mode === "relations") {
            const id = await page.locator(".topology-node.kind-awg").first().getAttribute("data-topology-node");
            await page.locator("[data-topology-select]").selectOption(id);
            await page.waitForFunction(selected => document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode === selected, id);
          }
          // Inspect a painted frame. WebKit may report a stale transparent
          // ancestor background immediately after cross-document navigation.
          await page.evaluate(() => document.activeElement?.blur());
          await page.locator(".topology-panel").screenshot({path: path.join(directory, `${engineName}-${width}-${theme}-${mode}.png`),
            style: ".skip-link:not(:focus) { visibility: hidden !important; }"});
          const result = await verify(page, reference, mode === "overview");
          if (theme === "dark") {
            await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
            assert.deepEqual(await verify(page, reference, mode === "overview"), result, "Missing theme defaults to the same dark node colors");
            await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
          }
          await verifyLunarViews(page, `${engineName}-${width}-${theme}-${mode}`);
          report.checks.push({engine: engineName, width, theme, mode, nodes: result.nodes.length});
        }
        await context.close();
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
}
main().catch(error => { report.failure = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({...report, checks: report.checks.length}, null, 2));
});
