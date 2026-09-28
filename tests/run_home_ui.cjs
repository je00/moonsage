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
      scene: scene ? {...bounds(scene), viewBox: scene.getAttribute("viewBox")} : null,
      viewport: {width: innerWidth, height: innerHeight},
    };
  });
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
      assert.equal(await page.locator("html").getAttribute("data-theme"), "light", "New visitors use the console's light default");
      for (const [saved, expected] of [["sky", "light"], ["dark", "dark"], ["unexpected", "light"], ["light", "light"]]) {
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
        verifyHome(await homeFacts(highDensity), {lang: "zh", theme: "light"});
        await highDensity.screenshot({path: path.join(directory, `${name}-${width}x${height}-zh-light-2x.png`), fullPage: true});
        report.checks.push({browser: name, width, height, deviceScaleFactor: 2, theme: "light"});
      }
      await sharp.close();
      const noScript = await browser.newContext({javaScriptEnabled: false, viewport: {width: 390, height: 844}});
      await protectContext(noScript);
      const plain = await noScript.newPage();
      await plain.goto(base.href);
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
