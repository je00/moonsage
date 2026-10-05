"use strict";

// Run only against tests/run_web_preview.py, never against a live server.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {chromium, webkit} = require("playwright");
const base = new URL(process.argv[2] || "http://127.0.0.1:8881/");
assert(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password && base.pathname === "/"
  && !base.search && !base.hash, "Use an isolated loopback preview");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-network-buttons-"));
const report = {directory, cases: [], screenshots: [], errors: [], external: []};
const routes = ["nodes", "subscriptions", "proxy", "topology"];

async function inspect(page, scope = "main") {
  return page.locator(scope).evaluate(root => {
    const visible = element => !!element.getClientRects().length
      && !element.closest("[hidden], .sr-only") && getComputedStyle(element).visibility !== "hidden";
    const controls = [...root.querySelectorAll("button, summary, a[class*=button], .page-shortcuts a, "
      + ".country-picker label, .exit-input-mode label, .check-row, .toggle-row")]
      .filter(element => visible(element) && !element.closest("[data-topology-world]")
        && !element.classList.contains("qr-backdrop"));
    const boxes = controls.map(element => {
      const box = element.getBoundingClientRect();
      return {text: element.textContent.trim().replace(/\s+/g, " ").slice(0, 70),
        layer: element.closest(".topology-view-options-body") ? "search-popover" : "flow",
        className: element.className, x: box.x, y: box.y, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height, clipped: element.scrollWidth > element.clientWidth + 2};
    });
    const overlaps = [];
    boxes.forEach((a, index) => boxes.slice(index + 1).forEach(b => {
      // The opaque search popover intentionally covers the canvas toolbar.
      if (a.layer === b.layer && Math.min(a.right, b.right) - Math.max(a.x, b.x) > 2
        && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 2) overlaps.push([a.text, b.text]);
    }));
    return {count: boxes.length, pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      bad: boxes.filter(box => box.x < -1 || box.right > innerWidth + 1 || box.clipped
        || (innerWidth <= 900 && (box.width < 43.9 || box.height < 43.9))), overlaps};
  });
}

function verify(result, label) {
  assert(result.count > 0, `${label}: no controls were inspected`);
  assert(result.pageWidth <= result.viewport + 1, `${label}: horizontal page overflow`);
  assert.deepEqual(result.bad, [], `${label}: clipped or undersized controls`);
  assert.deepEqual(result.overlaps, [], `${label}: overlapping controls`);
}

async function screenshot(locator, filename) {
  const target = path.join(directory, filename);
  await locator.screenshot({path: target}); report.screenshots.push(target);
}

(async () => {
  console.log(`Network button layout QA: ${directory}`);
  for (const [engineName, engine] of Object.entries({chromium, webkit})) {
    const browser = await engine.launch();
    for (const width of [320, 390, 768, 1440]) for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({viewport: {width, height: 900}, reducedMotion: "reduce"});
      const page = await context.newPage();
      page.on("pageerror", error => report.errors.push(error.message));
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin === base.origin) return route.continue();
        report.external.push(route.request().url()); return route.abort();
      });
      await page.goto(new URL("login/", base).href);
      await page.locator("[name=username]").fill("preview");
      await page.locator("[name=password]").fill("Preview-only-2026!");
      await page.locator("button[type=submit]").click();
      await page.waitForURL("**/overview/");
      await page.evaluate(value => localStorage.setItem("server-kit-theme", value), theme);
      for (const route of routes) {
        const label = `${engineName}-${width}-${theme}-${route}`;
        await page.goto(new URL(`network/${route}/`, base).href);
        await page.locator("main details").evaluateAll(elements => elements.forEach(element => {element.open = true;}));
        if (route === "subscriptions") await page.locator("[name=provider]").selectOption("dnspod");
        if (route === "nodes") await page.locator("[data-permission-add]").first().click();
        if (route === "topology") await page.waitForFunction(() => !document.querySelector("[data-topology-root]").hasAttribute("aria-busy"));
        const result = await inspect(page); verify(result, label);
        report.cases.push({label, controls: result.count});
        if (route === "proxy") {
          const defaultForm = page.locator(".exit-default-form");
          assert.equal(await defaultForm.count(), 1, `${label}: missing default-exit layout`);
          assert.equal(await defaultForm.evaluate(element => getComputedStyle(element).display), "grid");
          const password = await defaultForm.locator("[name=password]").boundingBox();
          assert(password.height >= 44, `${label}: default-exit password field is unstyled`);
          const ids = await defaultForm.locator("[name=operation]").inputValue();
          assert.equal(ids, "exit_set_default", `${label}: layout must not alter the action`);
          if (engineName === "webkit" && [320, 1440].includes(width) && theme === "dark") {
            await screenshot(defaultForm, `${label}-default-exit.png`);
            await screenshot(page.locator(".exit-edit-actions").first(), `${label}-edit-actions.png`);
          }
          if (engineName === "webkit" && width === 390 && theme === "light") {
            await page.locator('[data-secret-action="view"][data-endpoint$="/exit/"]').first().click();
            const secret = page.locator("[data-secret-modal]:not([hidden]) .qr-dialog");
            await secret.waitFor(); verify(await inspect(page, "[data-secret-modal] .qr-dialog"), `${label}-secret`);
            await screenshot(secret, `${label}-synthetic-secret.png`);
            await secret.locator(".qr-close").click();
            const editor = page.locator("[data-exit-edit-form]").first();
            // Loading credentials temporarily restores YAML before selecting fields.
            await editor.locator('[name=exit_input_mode][value=fields]').click();
            await editor.locator('[data-exit-input-panel=fields]').waitFor();
            verify(await inspect(page), `${label}-loaded-fields`);
          }
        }
        if (engineName === "webkit" && width === 390 && theme === "light" && route === "nodes") {
          await screenshot(page.locator(".node-publication-settings").first(), `${label}-subscription-actions.png`);
          await page.locator("[data-secret-action=qr]").first().click();
          const modal = page.locator("[data-sensitive-auth-modal]:not([hidden]) .qr-dialog");
          await modal.waitFor(); verify(await inspect(page, "[data-sensitive-auth-modal] .qr-dialog"), `${label}-auth`);
          await screenshot(modal, `${label}-auth.png`);
          await modal.locator("[data-sensitive-auth-password]").fill("Preview-only-2026!");
          await modal.locator("button[type=submit]").click();
          const qr = page.locator("[data-qr-modal]:not([hidden]) .qr-dialog");
          await qr.waitFor(); verify(await inspect(page, "[data-qr-modal] .qr-dialog"), `${label}-qr`);
          await screenshot(qr, `${label}-synthetic-qr.png`);
          await qr.locator(".qr-close").click();
        }
      }
      await context.close();
    }
    await browser.close();
  }
  assert.deepEqual(report.errors, [], "Browser errors");
  assert.deepEqual(report.external, [], "Unexpected external requests");
  assert.equal(report.cases.length, 64);
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(`PASS: ${report.cases.length} expanded page states; no overlap, clipping or undersized mobile controls`);
})().catch(error => {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify({...report, failure: error.message}, null, 2));
  console.error(error); process.exit(1);
});
