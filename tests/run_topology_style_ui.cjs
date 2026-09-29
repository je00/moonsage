"use strict";

// Compare the real home and connection canvas in an isolated synthetic preview.
const {chromium, webkit} = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const base = new URL(process.argv[2] || "http://127.0.0.1:8877/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password
  && base.pathname === "/" && !base.search && !base.hash, "Use an isolated loopback preview.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-topology-style-"));
const report = {directory, checks: [], errors: [], external: []};

async function verify(page, reference, overview) {
  await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => {
    const css = selector => getComputedStyle(document.querySelector(selector));
    const graph = css(".topology-graph"), panel = css(".topology-panel");
    const world = css(".topology-world"), inspector = css(".topology-inspector");
    const select = document.querySelector("[data-topology-select]");
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      graph: {background: graph.backgroundColor, image: graph.backgroundImage, font: graph.fontFamily,
        filter: graph.filter, backdropFilter: graph.backdropFilter},
      world: {willChange: world.willChange, filter: world.filter, transform: world.transform},
      panel: {background: panel.backgroundColor, radius: panel.borderTopLeftRadius, shadow: panel.boxShadow},
      inspectorBackground: inspector.backgroundColor,
      select: {height: select.getBoundingClientRect().height, appearance: getComputedStyle(select).appearance,
        image: getComputedStyle(select).backgroundImage},
      nodes: [...document.querySelectorAll("[data-topology-node]")].map(node => {
        const style = getComputedStyle(node), dot = getComputedStyle(node.querySelector(".topology-node-dot"));
        return {kind: node.classList.contains("is-hub") ? "hub" : node.classList.contains("kind-vless") ? "vless" : "awg",
          color: style.color, background: style.backgroundColor, radius: style.borderTopLeftRadius, shadow: style.boxShadow,
          width: node.offsetWidth, height: node.offsetHeight,
          dot: {radius: dot.borderTopLeftRadius, border: dot.borderTopWidth, background: dot.backgroundColor}};
      })
    };
  });
  assert.equal(result.overflow, false);
  assert.equal(result.graph.background, reference.background, "Canvas and homepage use the same sky-blue surface");
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
  assert(result.select.image.includes("linear-gradient"), "The picker retains a visible disclosure arrow");
  assert(result.nodes.length > 1);
  assert.deepEqual([...new Set(result.nodes.map(node => node.kind))].sort(), ["awg", "hub", "vless"]);
  for (const node of result.nodes) {
    assert.equal(node.radius, reference.controlRadius, "Cards use the same corner radius as home controls");
    assert.equal(node.shadow, "none", "No decorative layers or double outer frames");
    if (overview) assert.equal(node.background, reference.panel, "Overview cards stay quiet and flat");
    if (node.kind === "vless") assert.equal(node.dot.radius, "2px", "VLESS also has a shape cue");
    else assert.equal(node.dot.radius, "50%");
    if (node.kind === "hub") {
      assert.equal(node.dot.border, "1px");
      assert.equal(node.dot.background, "rgba(0, 0, 0, 0)", "VPS uses a hollow moon-like mark");
    }
  }
  return result;
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
        const reference = await page.evaluate(() => {
          const body = getComputedStyle(document.body), panel = getComputedStyle(document.querySelector(".moon-links"));
          return {background: body.backgroundColor, font: body.fontFamily, panel: panel.backgroundColor,
            panelRadius: panel.borderTopLeftRadius, controlRadius: getComputedStyle(document.querySelector(".moon-start")).borderTopLeftRadius};
        });
        await page.goto(new URL("login/", base).href);
        await page.locator('[name="username"]').fill("preview");
        await page.locator('[name="password"]').fill("Preview-only-2026!");
        await Promise.all([page.waitForURL(new URL("overview/", base).href), page.locator('button[type="submit"]').click()]);
        await page.goto(new URL("network/topology/", base).href);
        await page.locator("[data-topology-node]").first().waitFor();
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
          if (theme === "light") {
            await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
            assert.deepEqual(await verify(page, reference, mode === "overview"), result, "Missing theme defaults to light, not dark node colors");
            await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
          }
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
