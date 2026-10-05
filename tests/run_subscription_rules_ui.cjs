"use strict";

// Synthetic loopback preview only; never connects to the production agent.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {chromium, webkit} = require("playwright");
const base = new URL(process.argv[2] || "http://127.0.0.1:8791/");
if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname)
    || base.username || base.password || base.pathname !== "/") throw new Error("Loopback preview required");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-rules-ui-"));
const report = {directory, checks: [], screenshots: [], errors: []};

async function check(browser, label, width, theme, user = "preview") {
  const context = await browser.newContext({viewport: {width, height: width < 768 ? 844 : 1100},
    ...(width < 768 ? {isMobile: true, hasTouch: true} : {})});
  await context.route("**/*", route => new URL(route.request().url()).origin === base.origin
    ? route.continue() : route.abort());
  await context.addInitScript(value => localStorage.setItem("server-kit-theme", value), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => report.errors.push(error.message));
  try {
    await page.goto(new URL("login/", base).href);
    await page.locator('[name="username"]').fill(user);
    await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL("**/overview/"), page.locator('button[type="submit"]').click()]);
    assert.equal((await context.request.get(new URL("__preview__/scenario/rich/", base).href)).status(), 200);
    await page.goto(new URL("network/subscriptions/#subscription-rules", base).href);
    const region = page.locator("#subscription-rules");
    const navigations = [];
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    if (user === "viewer") {
      assert.equal(await region.locator("form").count(), 0);
      assert.match(await region.innerText(), /只读/);
    } else {
      const form = region.locator("form");
      assert.equal(await form.locator("[data-rules-save]").isDisabled(), true);
      await form.locator('[data-rule-add="direct"]').click();
      await form.locator('[data-rule-row="direct"]').last().locator('[name="direct_value"]').fill("added-office.example");
      await form.locator('[data-rule-add="dns"]').click();
      const dns = form.locator('[data-rule-row="dns"]').last();
      await dns.locator('[name="dns_value"]').fill("added-resolver.example");
      await dns.locator('[name="dns_servers"]').fill("https://8.8.8.8/dns-query");
      assert.equal(await dns.locator('[name="dns_route"]').inputValue(), "PROXY");
      const otherDraft = page.locator('.custom-host-create-form [name="domains"]');
      await otherDraft.fill("unsaved-host.example");
      await form.locator("[data-rules-save]").click();
      const modal = page.locator("[data-inline-task-modal]");
      await modal.locator("[data-inline-confirm]").waitFor({state: "visible"});
      assert.doesNotMatch(await modal.innerText(), /added-office|added-resolver/);
      await modal.locator("[data-inline-edit]").click();
      assert.equal(await dns.locator('[name="dns_value"]').inputValue(), "added-resolver.example");
      await form.locator("[data-rules-save]").click();
      await modal.locator("[data-inline-confirm]").click();
      await modal.locator("[data-inline-done]").waitFor({state: "visible"});
      assert.match(await modal.locator("[data-inline-status]").innerText(), /已保存/);
      await modal.locator("[data-inline-done]").click();
      await modal.waitFor({state: "hidden"});
      assert.equal(await region.locator('[name="direct_value"][value="added-office.example"]').count(), 1);
      assert.equal(await otherDraft.inputValue(), "unsaved-host.example");
      assert.equal(await region.locator("[data-rules-save]").isDisabled(), true);
      // Delete all entries in one operation; an empty configuration is intentional.
      while (await region.locator("[data-rule-remove]").count()) await region.locator("[data-rule-remove]").last().click();
      await region.locator("[data-rules-save]").click();
      await modal.locator("[data-inline-confirm]").click();
      await modal.locator("[data-inline-done]").waitFor({state: "visible"});
      await modal.locator("[data-inline-done]").click();
      await modal.waitFor({state: "hidden"});
      assert.equal(await region.locator("[data-rule-row]").count(), 0);
      assert.deepEqual(navigations, []);
      // Restore synthetic rows for a representative visual capture.
      await context.request.get(new URL("__preview__/scenario/rich/", base).href);
      await page.reload();
    }
    await region.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    for (const button of await region.locator("button:visible").all()) {
      assert.equal(await button.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    }
    const filename = `${label}-${width}-${theme}-${user}.png`;
    await region.screenshot({path: path.join(directory, filename)});
    report.screenshots.push(filename);
    report.checks.push(`${label} ${width} ${theme} ${user}: no overflow, batch save/delete, draft preservation and no navigation`);
  } finally { await context.close(); }
}

(async () => {
  for (const [label, type] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await type.launch({headless: true});
    try {
      await check(browser, label, 1440, "dark");
      await check(browser, label, 390, "light");
      await check(browser, label, 320, "dark");
      await check(browser, label, 390, "dark", "viewer");
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []);
})().catch(error => { report.failure = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
