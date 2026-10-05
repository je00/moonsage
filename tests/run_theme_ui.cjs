"use strict";

// Synthetic preview only: shared palette, contrast and cross-page persistence.
const {chromium, webkit} = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const base = new URL(process.argv[2] || "http://127.0.0.1:8875/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password
  && base.pathname === "/" && !base.search && !base.hash, "Use an isolated loopback preview.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-blue-theme-"));
const report = {directory, checks: [], errors: [], external: []};
const colors = {light: "#f0f6f8", dark: "#101d27"};
const pairs = [["text", "bg"], ["muted", "bg"], ["text-soft", "panel"],
  ["text-subtle", "panel"], ["accent-text", "panel"], ["on-accent", "button-start"],
  ["nav-text", "sidebar-bg"], ["nav-accent", "sidebar-bg"],
  ["success-text", "panel"], ["danger-text", "panel"], ["warning-text", "panel"]];
function luminance(hex) {
  let value = hex.replace("#", "");
  if (value.length === 3) value = [...value].map(part => part + part).join("");
  assert.match(value, /^[a-f0-9]{6}$/i);
  const rgb = [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
async function facts(page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const tokens = Object.fromEntries([...style].filter(name => name.startsWith("--"))
      .map(name => [name.slice(2), style.getPropertyValue(name).trim()]));
    return {theme: document.documentElement.dataset.theme, tokens,
      scheme: style.colorScheme, saved: localStorage.getItem("server-kit-theme"),
      meta: document.querySelector('meta[name="theme-color"]').content,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      pickers: [...document.querySelectorAll("[data-theme-picker]")].map(picker =>
        [...picker.querySelectorAll("[data-theme-value]")].map(button =>
          ({value: button.dataset.themeValue, selected: button.getAttribute("aria-pressed")})))};
  });
}
async function main() {
  for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch();
    try {
      for (const width of [390, 1440]) {
        const context = await browser.newContext({viewport: {width, height: width === 390 ? 844 : 900},
          reducedMotion: "reduce", deviceScaleFactor: 2});
        await context.route("**/*", route => {
          if (new URL(route.request().url()).origin === base.origin) return route.continue();
          report.external.push(route.request().url());
          return route.abort();
        });
        const page = await context.newPage();
        page.on("pageerror", error => report.errors.push(error.message));
        await page.goto(new URL("login/", base).href);
        await page.locator('[name="username"]').fill("preview");
        await page.locator('[name="password"]').fill("Preview-only-2026!");
        await Promise.all([page.waitForURL(new URL("overview/", base).href),
          page.locator('button[type="submit"]').click()]);
        for (const theme of ["light", "dark"]) {
          await page.goto(base.href);
          await page.locator(`[data-theme-value="${theme}"]`).click();
          for (const route of ["/", "/overview/", "/network/nodes/", "/network/topology/"]) {
            const response = await page.goto(new URL(route, base).href);
            assert.equal(response.status(), 200);
            const result = await facts(page);
            assert.equal(result.theme, theme);
            assert.equal(result.saved, theme);
            assert.equal(result.scheme, theme);
            assert.equal(result.tokens.bg, colors[theme]);
            assert.equal(result.meta, colors[theme]);
            assert.equal(result.overflow, false);
            assert(result.pickers.length > 0);
            for (const picker of result.pickers) {
              assert.deepEqual(picker.map(button => button.value), ["light", "dark"]);
              assert.deepEqual(picker.filter(button => button.selected === "true").map(button => button.value), [theme]);
            }
            const contrast = pairs.map(([foreground, background]) => {
              const a = luminance(result.tokens[foreground]), b = luminance(result.tokens[background]);
              const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
              assert(ratio >= 4.5, `${theme} ${foreground}/${background}: ${ratio.toFixed(2)}`);
              return {foreground, background, ratio};
            });
            const name = route === "/" ? "home" : route.replaceAll("/", "-").slice(1, -1);
            await page.screenshot({path: path.join(directory, `${engineName}-${width}-${theme}-${name}.png`), fullPage: true});
            report.checks.push({engine: engineName, width, theme, route, contrast});
          }
        }
        await context.close();
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
}
main().catch(error => { report.failure = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({directory, checks: report.checks.length,
    errors: report.errors, external: report.external, failure: report.failure || null}, null, 2));
});
