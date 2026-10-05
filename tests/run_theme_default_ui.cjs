"use strict";

// Read-only synthetic preview: default appearance and unavailable-storage fallbacks.
const {chromium, webkit} = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const base = new URL(process.argv[2] || "http://127.0.0.1:8877/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password
  && base.pathname === "/" && !base.search && !base.hash, "Use an isolated loopback preview.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-dark-default-"));
const report = {directory, checks: [], errors: [], external: []};
const cases = [
  {name: "fresh", expected: "dark"},
  {name: "invalid", saved: "retired-theme", expected: "dark"},
  {name: "saved-light", saved: "light", expected: "light"},
  {name: "saved-dark", saved: "dark", expected: "dark"},
  {name: "legacy-sky", saved: "sky", expected: "light"},
  {name: "read-only-sky", saved: "sky", readOnly: true, expected: "light"},
  {name: "storage-unavailable", unavailable: true, expected: "dark"},
  {name: "script-unavailable", blockScript: true, expected: "dark"},
  {name: "no-javascript", noJavaScript: true, expected: "dark"},
];

async function guard(context, testCase = {}) {
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) {
      report.external.push(url.href);
      return route.abort();
    }
    if (testCase.blockScript && /\/theme(?:\.[a-f0-9]+)?\.js$/.test(url.pathname)) return route.abort();
    return route.continue();
  });
}

async function appearance(page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    let saved;
    try { saved = localStorage.getItem("server-kit-theme"); } catch (_) { saved = "unavailable"; }
    return {theme: document.documentElement.dataset.theme, saved,
      background: style.getPropertyValue("--bg").trim(), scheme: style.colorScheme,
      meta: document.querySelector('meta[name="theme-color"]').content,
      selected: [...document.querySelectorAll('[data-theme-value][aria-pressed="true"]')]
        .map(button => button.dataset.themeValue)};
  });
}

async function main() {
  for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch();
    try {
      const login = await browser.newContext();
      await guard(login);
      const loginPage = await login.newPage();
      await loginPage.goto(new URL("login/", base).href);
      await loginPage.locator('[name="username"]').fill("preview");
      await loginPage.locator('[name="password"]').fill("Preview-only-2026!");
      await Promise.all([loginPage.waitForURL(new URL("overview/", base).href),
        loginPage.locator('button[type="submit"]').click()]);
      const {cookies} = await login.storageState();
      await login.close();
      for (const width of [390, 1440]) {
        for (const testCase of cases) {
          const context = await browser.newContext({viewport: {width, height: width === 390 ? 844 : 900},
            reducedMotion: "reduce", colorScheme: "light", deviceScaleFactor: 2,
            javaScriptEnabled: !testCase.noJavaScript, storageState: {cookies, origins: []}});
          await guard(context, testCase);
          await context.addInitScript(({saved, unavailable, readOnly}) => {
            if (saved !== undefined) localStorage.setItem("server-kit-theme", saved);
            if (unavailable) Object.defineProperty(window, "localStorage", {
              get() { throw new DOMException("Storage blocked", "SecurityError"); },
            });
            if (readOnly) Storage.prototype.setItem = function () {
              throw new DOMException("Storage read-only", "QuotaExceededError");
            };
          }, testCase);
          const page = await context.newPage();
          page.on("pageerror", error => report.errors.push(error.message));
          for (const route of ["/", "/login/", "/overview/"]) {
            // Authenticated users are redirected away from login: exercise the real form.
            if (route === "/login/") await context.clearCookies();
            else await context.addCookies(cookies);
            const response = await page.goto(new URL(route, base).href);
            assert.equal(response.status(), 200);
            assert.equal(new URL(page.url()).pathname, route);
            const result = await appearance(page);
            assert.equal(result.theme, testCase.expected, `${engineName} ${testCase.name} ${route}`);
            assert.equal(result.scheme, testCase.expected);
            assert.equal(result.background, testCase.expected === "dark" ? "#101d27" : "#f0f6f8");
            assert.equal(result.meta, result.background);
            assert(result.selected.length > 0 && result.selected.every(value => value === testCase.expected));
            if (testCase.name === "fresh") assert.equal(result.saved, null, "Do not persist an implicit default");
            if (testCase.name === "legacy-sky") assert.equal(result.saved, "light");
            if (testCase.name === "read-only-sky") assert.equal(result.saved, "sky");
            if (testCase.name === "fresh") {
              const name = route === "/" ? "home" : route.split("/")[1];
              await page.screenshot({path: path.join(directory, `${engineName}-${width}-${name}.png`), fullPage: true});
            }
            report.checks.push({engine: engineName, width, scenario: testCase.name, route, ...result});
          }
          if (testCase.unavailable) {
            // A denied write should not prevent an explicit choice for this page.
            await page.locator('[data-theme-value="light"]').first().dispatchEvent("click");
            assert.equal((await appearance(page)).theme, "light");
            await page.reload();
            assert.equal((await appearance(page)).theme, "dark");
          }
          if (testCase.name === "fresh") {
            await page.evaluate(() => delete document.documentElement.dataset.theme);
            assert.equal((await appearance(page)).background, "#101d27", "CSS root fallback must also be dark");
          }
          await context.close();
        }
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
