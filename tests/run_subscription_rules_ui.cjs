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
const dnsPaths = {
  PROXY: {label: "走出口", path: "设备 → 所选出口 → DNS", help: "跟随客户端 PROXY 选择。", example: "https://8.8.8.8/dns-query"},
  MID: {label: "走 VPS（MID）", path: "设备 → VPS → DNS", help: "VPS 直出，不走出口节点。", example: "https://1.1.1.1/dns-query"},
  DIRECT: {label: "本机直连", path: "设备 → DNS", help: "不经过客户端代理。", example: "https://223.5.5.5/dns-query"},
};

async function checkDNSPath(row, route) {
  assert.equal(await row.locator('[name="dns_route"]').inputValue(), route);
  assert.equal(await row.locator('[name="dns_route"] option:checked').innerText(), dnsPaths[route].label);
  assert.equal(await row.locator("[data-rule-route-preview]").innerText(), dnsPaths[route].path);
  assert.equal(await row.locator("[data-rule-route-preview]").isVisible(), true);
  assert.equal(await row.locator("[data-rule-route-help]").innerText(), dnsPaths[route].help);
  assert.equal(await row.locator("[data-rule-route-help]").isVisible(), true);
  assert.equal(await row.locator('[name="dns_servers"]').getAttribute("placeholder"), dnsPaths[route].example);
  assert.deepEqual(await row.locator('[name="dns_route"] option').evaluateAll(options => options.map(option => option.value)), ["PROXY", "MID", "DIRECT"]);
}

async function checkRuleTarget(row, kind, match) {
  const isIP = match === "cidr";
  assert.equal(await row.locator(`[name="${kind}_match"]`).inputValue(), match);
  assert.equal(await row.locator("[data-rule-match-fallback]").isVisible(), false);
  assert.equal(await row.locator("[data-rule-value-label]").innerText(), isIP ? "IP / 网段" : "域名");
  assert.equal(await row.locator("[data-rule-value-help]").innerText(), isIP
    ? "网段示例：192.168.50.0/24"
    : match === "suffix" ? "同时匹配此域名及其子域名。" : "只匹配填写的域名。");
  const toggle = row.locator("[data-rule-subdomains-toggle]");
  assert.equal(await toggle.getAttribute("name"), null);
  assert.equal(await toggle.isVisible(), !isIP);
  assert.equal(await toggle.isDisabled(), isIP);
  assert.equal(await toggle.isChecked(), match === "suffix");
  assert.equal(await row.locator("[data-rule-type]").count(), kind === "direct" ? 2 : 0);
  if (kind === "direct") {
    for (const type of ["domain", "cidr"]) {
      const button = row.locator(`[data-rule-type="${type}"]`);
      assert.equal(await button.isVisible(), true);
      assert.equal(await button.getAttribute("type"), "button");
      assert.equal(await button.getAttribute("aria-pressed"), String(isIP === (type === "cidr")));
      assert.equal(await button.innerText(), type === "domain" ? "域名" : "IP / 网段");
    }
  }
}

async function ruleValues(row) {
  return row.locator("input, select, textarea").evaluateAll(nodes => nodes.map(node =>
    [node.name, node.value, node.type === "checkbox" ? node.checked : null]));
}

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
    await page.goto(new URL("network/subscriptions/", base).href);
    assert.equal(await page.locator("[data-subscription-rules]").count(), 0);
    assert.equal(await page.locator('script[src*="subscription_rules.js"]').count(), 0);
    const rulesPath = "/network/subscription-rules/";
    await page.locator(`#main-content a[href="${rulesPath}"]`).click();
    await page.waitForURL(new URL(rulesPath, base).href);
    assert.equal(await page.locator("h1").innerText(), "直连与 DNS");
    assert.equal(await page.locator(`.sidebar a[href="${rulesPath}"].active`).count(), 1);
    assert.equal(await page.locator(`.mobile-menu-links a[href="${rulesPath}"].active`).count(), 1);
    const region = page.locator("#subscription-rules");
    const navigations = [];
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    if (user === "viewer") {
      assert.equal(await region.locator("form").count(), 0);
      assert.match(await region.innerText(), /只读/);
      for (const route of ["DIRECT", "MID"]) {
        assert.equal((await region.innerText()).includes(dnsPaths[route].label), true);
        assert.equal((await region.innerText()).includes(dnsPaths[route].path), true);
        assert.equal((await region.innerText()).includes(dnsPaths[route].help), true);
      }
      assert.doesNotMatch(await region.innerText(), /跟随选中出口|直连（显式例外）/);
    } else {
      const form = region.locator("form");
      assert.equal(await form.locator("[data-rules-save]").isDisabled(), true);
      assert.equal((await form.innerText()).includes("只改变 DNS 查询路径，不改变网站流量。"), true);
      const existingDNS = form.locator('[data-rule-row="dns"]').first();
      await checkDNSPath(existingDNS, "DIRECT");
      await checkRuleTarget(existingDNS, "dns", "suffix");
      const existingMID = form.locator('[data-rule-row="dns"]').nth(1);
      await checkDNSPath(existingMID, "MID");
      await checkRuleTarget(existingMID, "dns", "exact");
      const existingDomain = form.locator('[data-rule-row="direct"]').first();
      const existingIP = form.locator('[data-rule-row="direct"]').nth(1);
      await checkRuleTarget(existingDomain, "direct", "suffix");
      await checkRuleTarget(existingIP, "direct", "cidr");
      assert.equal((await existingDNS.locator(".subscription-rule-route").innerText()).startsWith("DNS 路径"), true);
      const existingDNSValues = await ruleValues(existingDNS);
      const existingMIDValues = await ruleValues(existingMID);
      const existingDomainValues = await ruleValues(existingDomain);
      const existingIPValues = await ruleValues(existingIP);
      const submissions = [];
      page.on("request", request => { if (request.method() === "POST") submissions.push(request.url()); });
      await form.locator('[data-rule-add="direct"]').click();
      const direct = form.locator('[data-rule-row="direct"]').nth(2);
      await checkRuleTarget(direct, "direct", "suffix");
      await direct.locator('[name="direct_value"]').fill("added-office.example");
      // Native keyboard semantics and independent domain/IP drafts.
      await direct.locator("[data-rule-subdomains-toggle]").focus();
      await page.keyboard.press("Space");
      await checkRuleTarget(direct, "direct", "exact");
      await direct.locator('[data-rule-type="cidr"]').focus();
      await page.keyboard.press("Space");
      await checkRuleTarget(direct, "direct", "cidr");
      assert.equal(await direct.locator('[name="direct_value"]').inputValue(), "");
      await direct.locator('[name="direct_value"]').fill("192.168.60.10");
      await direct.locator('[data-rule-type="domain"]').focus();
      await page.keyboard.press("Enter");
      await checkRuleTarget(direct, "direct", "exact");
      assert.equal(await direct.locator('[name="direct_value"]').inputValue(), "added-office.example");
      await direct.locator('[data-rule-type="cidr"]').click();
      await checkRuleTarget(direct, "direct", "cidr");
      assert.equal(await direct.locator('[name="direct_value"]').inputValue(), "192.168.60.10");
      await direct.locator('[data-rule-type="domain"]').click();
      await checkRuleTarget(direct, "direct", "exact");
      await form.locator('[data-rule-add="direct"]').click();
      const singleIP = form.locator('[data-rule-row="direct"]').nth(3);
      await singleIP.locator('[data-rule-type="cidr"]').click();
      await singleIP.locator('[name="direct_value"]').fill("192.168.60.11");
      await checkRuleTarget(singleIP, "direct", "cidr");
      await form.locator('[data-rule-add="dns"]').click();
      const dns = form.locator('[data-rule-row="dns"]').last();
      await checkDNSPath(dns, "PROXY");
      await checkRuleTarget(dns, "dns", "suffix");
      assert.equal(await dns.locator('[name="dns_servers"]').inputValue(), "");
      await dns.locator('[name="dns_value"]').fill("added-resolver.example");
      await dns.locator('[name="dns_servers"]').fill("https://9.9.9.9/dns-query");
      await dns.locator("[data-rule-subdomains-toggle]").focus();
      await page.keyboard.press("Space");
      await checkRuleTarget(dns, "dns", "exact");
      await checkDNSPath(dns, "PROXY");
      // Switching the explanatory path is local-only and leaves other rows untouched.
      for (const route of ["MID", "DIRECT", "PROXY", "MID"]) {
        await dns.locator('[name="dns_route"]').selectOption(route);
        await checkDNSPath(dns, route);
        assert.equal(await dns.locator('[name="dns_servers"]').inputValue(), "https://9.9.9.9/dns-query");
        assert.deepEqual(submissions, []);
        await checkDNSPath(existingDNS, "DIRECT");
        await checkDNSPath(existingMID, "MID");
        assert.deepEqual(await ruleValues(existingDNS), existingDNSValues);
        assert.deepEqual(await ruleValues(existingMID), existingMIDValues);
        assert.deepEqual(await ruleValues(existingDomain), existingDomainValues);
        assert.deepEqual(await ruleValues(existingIP), existingIPValues);
      }
      assert.equal(await page.locator(".custom-host-create-form").count(), 0);
      await form.locator("[data-rules-save]").click();
      const modal = page.locator("[data-inline-task-modal]");
      await modal.locator("[data-inline-confirm]").waitFor({state: "visible"});
      assert.doesNotMatch(await modal.innerText(), /added-office|added-resolver/);
      await modal.locator("[data-inline-edit]").click();
      assert.equal(await dns.locator('[name="dns_value"]').inputValue(), "added-resolver.example");
      await checkDNSPath(dns, "MID");
      await checkDNSPath(existingDNS, "DIRECT");
      await checkDNSPath(existingMID, "MID");
      await checkRuleTarget(dns, "dns", "exact");
      await checkRuleTarget(direct, "direct", "exact");
      assert.equal(await direct.locator('[name="direct_value"]').inputValue(), "added-office.example");
      await direct.locator('[data-rule-type="cidr"]').click();
      assert.equal(await direct.locator('[name="direct_value"]').inputValue(), "192.168.60.10");
      await direct.locator('[data-rule-type="domain"]').click();
      await checkRuleTarget(direct, "direct", "exact");
      await checkRuleTarget(singleIP, "direct", "cidr");
      assert.equal(await singleIP.locator('[name="direct_value"]').inputValue(), "192.168.60.11");
      await form.locator("[data-rules-save]").click();
      await modal.locator("[data-inline-confirm]").click();
      await modal.locator("[data-inline-done]").waitFor({state: "visible"});
      assert.match(await modal.locator("[data-inline-status]").innerText(), /已保存/);
      await modal.locator("[data-inline-done]").click();
      await modal.waitFor({state: "hidden"});
      assert.equal(await region.locator('[name="direct_value"][value="added-office.example"]').count(), 1);
      await checkRuleTarget(region.locator('[data-rule-row="direct"]').nth(2), "direct", "exact");
      await checkRuleTarget(region.locator('[data-rule-row="direct"]').nth(3), "direct", "cidr");
      assert.equal(await region.locator('[data-rule-row="direct"]').nth(3).locator('[name="direct_value"]').inputValue(), "192.168.60.11/32");
      await checkDNSPath(region.locator('[data-rule-row="dns"]').first(), "DIRECT");
      await checkDNSPath(region.locator('[data-rule-row="dns"]').nth(1), "MID");
      await checkDNSPath(region.locator('[data-rule-row="dns"]').last(), "MID");
      assert.equal(await region.locator('[name="dns_value"]').last().inputValue(), "added-resolver.example");
      await checkRuleTarget(region.locator('[data-rule-row="dns"]').last(), "dns", "exact");
      assert.equal(page.url(), new URL(rulesPath, base).href);
      assert.equal(await region.locator("[data-rules-save]").isDisabled(), true);
      const midFilename = `${label}-${width}-${theme}-${user}-mid-path.png`;
      await region.locator('[data-rule-row="dns"]').last().screenshot({path: path.join(directory, midFilename)});
      report.screenshots.push(midFilename);
      for (const [index, type] of [[2, "domain"], [3, "ip"]]) {
        const targetFilename = `${label}-${width}-${theme}-${user}-${type}-target.png`;
        await region.locator('[data-rule-row="direct"]').nth(index).screenshot({path: path.join(directory, targetFilename)});
        report.screenshots.push(targetFilename);
      }
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
    // After in-place saves/reload, don't photograph a retained keyboard skip-link focus.
    await page.evaluate(() => document.activeElement?.blur());
    await region.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    for (const button of await region.locator("button:visible").all()) {
      assert.equal(await button.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    }
    const filename = `${label}-${width}-${theme}-${user}.png`;
    await region.screenshot({path: path.join(directory, filename)});
    report.screenshots.push(filename);
    await page.evaluate(() => scrollTo(0, 0));
    const pageFilename = `${label}-${width}-${theme}-${user}-page.png`;
    await page.screenshot({path: path.join(directory, pageFilename)});
    report.screenshots.push(pageFilename);
    if (width < 768) {
      const menu = page.locator("[data-mobile-menu]");
      await menu.locator("summary").click();
      const selected = menu.locator(`a[href="${rulesPath}"].active`);
      await selected.waitFor({state: "visible"});
      assert.equal(await selected.getAttribute("aria-current"), "page");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.equal(await menu.locator(".mobile-menu-panel").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      const menuFilename = `${label}-${width}-${theme}-${user}-menu.png`;
      await page.screenshot({path: path.join(directory, menuFilename)});
      report.screenshots.push(menuFilename);
      await menu.locator("[data-mobile-menu-close]").click();
    }
    report.checks.push(`${label} ${width} ${theme} ${user}: domain/IP controls, checkbox semantics, keyboard activation, independent type drafts, single-IP normalization, no overflow, DNS paths, local preview, batch save/delete, cancel preserves drafts, save stays on page`);
  } finally { await context.close(); }
}

async function checkNoJavaScript(browser, label) {
  const context = await browser.newContext({javaScriptEnabled: false, viewport: {width: 390, height: 844}});
  await context.route("**/*", route => new URL(route.request().url()).origin === base.origin
    ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto(new URL("login/", base).href);
    await page.locator('[name="username"]').fill("preview");
    await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL("**/overview/"), page.locator('button[type="submit"]').click()]);
    assert.equal((await context.request.get(new URL("__preview__/scenario/rich/", base).href)).status(), 200);
    await page.goto(new URL("network/subscription-rules/", base).href);
    const form = page.locator("[data-rules-form]");
    const direct = form.locator('[data-rule-row="direct"]').first();
    const dns = form.locator('[data-rule-row="dns"]').first();
    for (const row of [direct, dns]) {
      assert.equal(await row.locator("[data-rule-match-fallback]").isVisible(), true);
      assert.equal(await row.locator("[data-rule-subdomains-toggle]").isVisible(), false);
    }
    for (const button of await direct.locator("[data-rule-type]").all()) assert.equal(await button.isVisible(), false);
    assert.equal(await form.locator('[data-rule-add="direct"]').isVisible(), false);
    assert.deepEqual(await dns.locator('[name="dns_match"] option').evaluateAll(options => options.map(option => option.value)), ["suffix", "exact"]);
    await direct.locator('[name="direct_match"]').selectOption("cidr");
    await direct.locator('[name="direct_value"]').fill("192.168.60.12");
    await Promise.all([
      page.waitForURL("**/network/subscription-rules/preview/"),
      form.locator("[data-rules-save]").click(),
    ]);
    assert.equal(await page.locator("h1").innerText(), "更新指定直连与 DNS");
    await Promise.all([
      page.waitForURL(/\/tasks\/task-[^/]+\/$/),
      page.getByRole("button", {name: "确认保存", exact: true}).click(),
    ]);
    await page.goto(new URL("network/subscription-rules/", base).href);
    const saved = page.locator('[data-rule-row="direct"]').first();
    assert.equal(await saved.locator('[name="direct_match"]').inputValue(), "cidr");
    assert.equal(await saved.locator('[name="direct_value"]').inputValue(), "192.168.60.12/32");
    assert.equal(await saved.locator("[data-rule-match-fallback]").isVisible(), true);
    assert.equal(await page.locator('[data-rule-row="dns"]').first().locator('[name="dns_match"]').inputValue(), "suffix");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const filename = `${label}-390-no-javascript.png`;
    await saved.screenshot({path: path.join(directory, filename)});
    report.screenshots.push(filename);
    report.checks.push(`${label} no JavaScript: visible named fallback controls, enhanced controls hidden, existing rule preview/save, single IP normalized, no overflow`);
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
      await checkNoJavaScript(browser, label);
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []);
})().catch(error => { report.failure = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
