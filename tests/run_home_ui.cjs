"use strict";

// Isolated fixture preview only; never submit credentials to a live host.
const {chromium, webkit} = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const base = new URL(process.argv[2] || "http://127.0.0.1:8873/");
if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname)
    || !base.port || Number(base.port) < 1024 || base.username || base.password
    || base.pathname !== "/" || base.search || base.hash) {
  throw new Error("Use an isolated loopback preview with an unprivileged port.");
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-home-ui-"));
const report = {directory, checks: [], errors: [], external: [], dynamicRequests: []};
const sizes = [[320, 844], [390, 844], [390, 600], [768, 1000], [1024, 820],
  [1440, 900], [1920, 1080], [844, 390]];
const routes = ["/overview/", "/deploy/", "/network/nodes/", "/network/topology/", "/guides/nodes/"];
const themes = ["light", "dark"];
const palette = {light: "#f0f6f8", dark: "#101d27"};

async function protectContext(context) {
  await context.route("**/*", route => {
    const request = route.request();
    if (["fetch", "xhr", "websocket", "eventsource"].includes(request.resourceType())) {
      report.dynamicRequests.push({url: request.url(), kind: request.resourceType()});
    }
    if (new URL(request.url()).origin === base.origin) return route.continue();
    report.external.push(request.url());
    return route.abort();
  });
}

async function homeFacts(page) {
  return page.evaluate(() => {
    const scene = document.querySelector(".moon-art svg.moon-illustration[data-moon-scene]");
    const bounds = node => {
      const rect = node.getBoundingClientRect();
      return {x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom};
    };
    return {
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      chromeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
      savedTheme: localStorage.getItem("server-kit-theme"),
      main: document.querySelectorAll("main#main-content").length,
      headings: document.querySelectorAll("h1").length,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      scripts: [...document.scripts].map(script => script.getAttribute("src")),
      rasterElements: document.querySelectorAll("img, picture, svg image, canvas").length,
      rasterResources: performance.getEntriesByType("resource").map(entry => entry.name)
        .filter(name => /\.(webp|png|jpe?g|gif|avif)(?:$|[?#])/i.test(name)),
      controls: [...document.querySelectorAll(".moon-header a, .moon-entry-actions a, .moon-links a, [data-theme-value]")]
        .map(node => ({href: node.getAttribute("href"), label: node.textContent.trim(),
          theme: node.dataset.themeValue, pressed: node.getAttribute("aria-pressed"), ...bounds(node)})),
      scene: scene ? {...bounds(scene), viewBox: scene.getAttribute("viewBox"),
        nodes: [...scene.querySelectorAll("[data-home-node]")].map(node => ({
          environment: node.dataset.homeNode, x: Number(node.getAttribute("cx")), y: Number(node.getAttribute("cy"))})),
        moon: (() => { const moon = scene.querySelector("[data-home-moon]"); return moon ? {
          shape: moon.tagName, radius: Number(moon.getAttribute("r")), rim: getComputedStyle(moon).stroke,
          features: scene.querySelectorAll("[data-lunar-feature]").length} : null; })(),
        heavyEffects: scene.querySelectorAll("filter, pattern, animate, animateTransform").length,
        sky: getComputedStyle(document.documentElement).getPropertyValue("--scene-sky").trim(),
      } : null,
      viewport: {width: innerWidth, height: innerHeight},
    };
  });
}

async function scenePaint(page) {
  return page.locator("[data-moon-scene]").evaluate(scene => {
    const paint = selector => {
      const node = scene.querySelector(selector), style = getComputedStyle(node);
      return {fill: style.fill.replace(/.*#([^"')]+).*/, "#$1"), stroke: style.stroke,
        strokeWidth: Number.parseFloat(style.strokeWidth), opacity: Number(style.opacity)};
    };
    return {moon: paint("[data-home-moon]"), maria: paint(".moon-scene-maria"), crater: paint(".moon-scene-crater"),
      ripple: paint(".moon-scene-ripple"), water: paint(".moon-scene-water-shadow"), reflection: paint(".moon-scene-node-reflection"),
      sky: [...scene.querySelectorAll('[data-home-node="sky"]')].map((_, index) => paint(`.moon-scene-sky-node circle:nth-child(${index + 1})`)),
      sea: [...scene.querySelectorAll('[data-home-node="sea"]')].map((_, index) => paint(`.moon-scene-sea-node circle:nth-child(${index + 1})`)),
      terrain: [...scene.querySelectorAll("[data-lunar-feature]")].map(node => ({
        fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke,
        width: node.getBBox().width, height: node.getBBox().height})),
      lunarStops: [...scene.querySelectorAll("#home-lunar-shade stop")].map(stop => getComputedStyle(stop).stopColor)};
  });
}

function verifyScenePaint(paint, theme) {
  const rim = "rgb(71, 110, 137)", shadow = "rgb(143, 177, 200)", terrain = "rgb(83, 126, 156)", light = "rgb(241, 248, 253)";
  assert.deepEqual(paint.moon, {fill: "#home-lunar-shade", stroke: rim, strokeWidth: 1.2, opacity: 1});
  assert.deepEqual(paint.maria, {fill: terrain, stroke: "none", strokeWidth: 1, opacity: .16});
  assert.deepEqual(paint.crater, {fill: "none", stroke: terrain, strokeWidth: .7, opacity: .22});
  assert.deepEqual(paint.ripple, {fill: "none", stroke: theme === "light" ? rim : shadow,
    strokeWidth: .8, opacity: theme === "light" ? .22 : .25});
  assert.equal(paint.water.fill, terrain);
  assert.equal(paint.water.opacity, theme === "light" ? .035 : .05);
  assert.equal(paint.reflection.fill, light);
  assert.equal(paint.reflection.opacity, theme === "light" ? .6 : .25);
  assert.equal(paint.sky.length, 4); assert.equal(paint.sea.length, 4);
  assert(paint.sky.every(node => node.fill === light && node.stroke === (theme === "light" ? rim : shadow)));
  assert(paint.sea.every(node => node.fill === light && node.stroke === (theme === "light" ? "rgb(28, 112, 145)" : "rgb(99, 189, 231)")));
  assert.equal(paint.terrain.length, 9);
  assert(paint.terrain.every(feature => feature.width > 0 && feature.height > 0));
  assert(paint.terrain.slice(0, 4).every(feature => feature.fill === terrain));
  assert(paint.terrain.slice(4).every(feature => feature.stroke === terrain));
  assert.deepEqual(paint.lunarStops, [light, "rgb(209, 227, 239)", shadow]);
}

function verifyHome(facts, {lang, theme}) {
  assert.equal(facts.lang, lang === "en" ? "en" : "zh-Hans");
  assert.equal(facts.theme, theme);
  assert.equal(facts.background, palette[theme], "Home must share the console's theme palette");
  assert.equal(facts.chromeColor, palette[theme], "Browser chrome must match the selected appearance");
  assert(facts.main === 1 && facts.headings === 1 && !facts.overflow);
  assert.equal(facts.scripts.length, 1, "Only shared theme selection needs JavaScript");
  assert.match(facts.scripts[0], /\/(?:theme)(?:\.[a-f0-9]+)?\.js$/);
  assert.equal(facts.rasterElements, 0, "The simple illustration must stay resolution-independent");
  assert.deepEqual(facts.rasterResources, []);
  assert(facts.scene && facts.scene.width > 100 && facts.scene.height > 60 && facts.scene.viewBox);
  assert(facts.scene.x >= -1 && facts.scene.right <= facts.viewport.width + 1, "Illustration clipped");
  assert.equal(facts.scene.sky, theme === "light" ? "#e3f0f9" : "#07131f", "Home and spatial topology share the same sky");
  assert.equal(facts.scene.heavyEffects, 0, "Soft water is native gradients, not expensive filters or repetitive textures");
  assert.deepEqual(facts.scene.moon, {shape: "circle", radius: 49, rim: "rgb(71, 110, 137)", features: 9},
    "One full moon keeps a strong rim in light appearance and the same terrain as topology");
  for (const environment of ["sky", "sea"]) {
    const nodes = facts.scene.nodes.filter(node => node.environment === environment);
    assert.equal(nodes.length, 4, "Four sky and four sea nodes must remain present at every size");
    assert.equal(new Set(nodes.map(node => node.y)).size, 4, "Nodes should not form a regular row");
    assert(nodes.every(node => environment === "sky" ? node.y < 184 : node.y > 184));
  }
  for (const control of facts.controls) {
    assert(control.x >= -1 && control.right <= facts.viewport.width + 1, `Control clipped: ${control.label}`);
    assert(control.height >= 43.5, `Touch target too small: ${control.label}`);
  }
  for (let i = 0; i < facts.controls.length; i++) {
    for (let j = i + 1; j < facts.controls.length; j++) {
      const a = facts.controls[i], b = facts.controls[j];
      const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
      assert(overlap < 1, `Controls overlap: ${a.label} / ${b.label}`);
    }
  }
  for (const route of routes) assert(facts.controls.some(control => control.href === route));
  const consoleEntry = facts.controls.find(control => control.href === "/overview/");
  const deployEntry = facts.controls.find(control => control.href === "/deploy/");
  if (Math.min(consoleEntry.bottom, deployEntry.bottom) > Math.max(consoleEntry.y, deployEntry.y)) {
    assert(Math.abs(consoleEntry.y - deployEntry.y) <= 1
      && Math.abs(consoleEntry.height - deployEntry.height) <= 1,
    "Side-by-side entry buttons must keep equal heights, including wrapped English labels");
  }
  const themeControls = facts.controls.filter(control => control.theme);
  assert.deepEqual(themeControls.map(control => control.theme).sort(), [...themes].sort());
  assert.deepEqual(themeControls.filter(control => control.pressed === "true").map(control => control.theme), [theme]);
}

async function main() {
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({reducedMotion: "reduce"});
      await protectContext(context);
      const page = await context.newPage();
      page.on("pageerror", error => report.errors.push(error.message));
      await page.goto(base.href);
      assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "New visitors use the console's dark default");
      for (const [saved, expected] of [["sky", "light"], ["dark", "dark"], ["unexpected", "dark"], ["light", "light"]]) {
        await page.evaluate(value => localStorage.setItem("server-kit-theme", value), saved);
        await page.reload();
        const facts = await homeFacts(page);
        verifyHome(facts, {lang: "zh", theme: expected});
        assert.equal(facts.savedTheme, saved === "sky" ? "light" : saved);
        report.checks.push({browser: name, migration: saved, theme: expected});
      }
      for (const [width, height] of sizes) {
        await page.setViewportSize({width, height});
        for (const lang of ["zh", "en"]) {
          const response = await page.goto(new URL(`?lang=${lang}`, base).href);
          assert.equal(response.status(), 200);
          for (const theme of themes) {
            await page.locator(`[data-theme-value="${theme}"]`).click();
            const facts = await homeFacts(page);
            verifyHome(facts, {lang, theme});
            assert.equal(facts.savedTheme, theme);
            await page.screenshot({path: path.join(directory, `${name}-${width}x${height}-${lang}-${theme}.png`), fullPage: true});
            report.checks.push({browser: name, width, height, lang, theme, ...facts});
          }
        }
      }
      // CSS zoom checks reflow and vector sharpness at 200%, including long English labels.
      await page.setViewportSize({width: 1440, height: 900});
      await page.goto(new URL("?lang=en", base).href);
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      for (const theme of themes) {
        await page.locator(`[data-theme-value="${theme}"]`).click();
        const facts = await homeFacts(page);
        verifyHome(facts, {lang: "en", theme});
        await page.screenshot({path: path.join(directory, `${name}-200percent-en-${theme}.png`), fullPage: true});
        report.checks.push({browser: name, zoom: 2, lang: "en", theme, ...facts});
      }
      await page.setViewportSize({width: 390, height: 844});
      for (const theme of themes) {
        await page.goto(base.href);
        await page.locator(`[data-theme-value="${theme}"]`).click();
        await page.locator('a[href="/overview/"]').click();
        await page.waitForURL(url => url.pathname === "/login/", {waitUntil: "load"});
        assert.equal(new URL(page.url()).pathname, "/login/");
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), palette[theme]);
        await page.screenshot({path: path.join(directory, `${name}-login-${theme}.png`), fullPage: true});
        await page.goto(base.href);
        verifyHome(await homeFacts(page), {lang: "zh", theme});
        report.checks.push({browser: name, inheritance: "home → login → home", theme});
      }
      // Mobile intentionally hides the login illustration. Inspect its real
      // desktop paint as well, where home.css is deliberately not loaded.
      await page.setViewportSize({width: 1440, height: 900});
      for (const theme of themes) {
        await page.goto(base.href);
        await page.locator(`[data-theme-value="${theme}"]`).click();
        const homePaint = await scenePaint(page);
        verifyScenePaint(homePaint, theme);
        await page.locator('a[href="/overview/"]').click();
        await page.waitForURL(url => url.pathname === "/login/");
        assert(await page.locator(".moon-login-art [data-moon-scene]").isVisible());
        assert.equal(await page.locator('link[rel="stylesheet"][href*="moonsage/home.css"]').count(), 0);
        const loginPaint = await scenePaint(page);
        verifyScenePaint(loginPaint, theme);
        assert.deepEqual(loginPaint, homePaint, "Shared scene paint must not depend on the homepage stylesheet");
        await page.screenshot({path: path.join(directory, `${name}-1440-login-${theme}.png`), fullPage: true});
        report.checks.push({browser: name, sharedScene: "home ↔ desktop login", theme, paint: loginPaint});
      }
      for (const route of routes) {
        await page.goto(base.href);
        await page.locator(`a[href="${route}"]`).click();
        const destination = new URL(page.url());
        assert.equal(destination.pathname, "/login/");
        assert.equal(destination.searchParams.get("next"), route);
      }
      await page.goto(base.href);
      await page.keyboard.press("Tab");
      // WebKit on macOS follows the system's links-in-tab-order preference.
      if (await page.locator(":focus").count() === 0) await page.keyboard.press("Alt+Tab");
      assert.equal(await page.locator(":focus").textContent(), "跳到主要内容");
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(":focus").getAttribute("id"), "main-content");
      await context.close();
      const sharp = await browser.newContext({reducedMotion: "reduce", deviceScaleFactor: 2});
      await protectContext(sharp);
      const highDensity = await sharp.newPage();
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        await highDensity.setViewportSize({width, height});
        await highDensity.goto(base.href);
        verifyHome(await homeFacts(highDensity), {lang: "zh", theme: "dark"});
        await highDensity.screenshot({path: path.join(directory, `${name}-${width}x${height}-zh-dark-2x.png`), fullPage: true});
        report.checks.push({browser: name, width, height, deviceScaleFactor: 2, theme: "dark"});
      }
      await sharp.close();
      const noScript = await browser.newContext({javaScriptEnabled: false, viewport: {width: 390, height: 844}});
      await protectContext(noScript);
      const plain = await noScript.newPage();
      await plain.goto(base.href);
      assert.equal(await plain.locator("html").getAttribute("data-theme"), "dark");
      await plain.getByRole("link", {name: "English", exact: true}).click();
      assert.equal(await plain.locator("html").getAttribute("lang"), "en");
      await plain.locator('a[href="/overview/"]').click();
      assert.equal(new URL(plain.url()).pathname, "/login/");
      await noScript.close();
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
  assert.deepEqual(report.dynamicRequests, [], "Home and login must not poll the management plane");
}

main().catch(error => { report.failure = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({directory, checks: report.checks.length, errors: report.errors,
    external: report.external, dynamicRequests: report.dynamicRequests, failure: report.failure || null}, null, 2));
});
