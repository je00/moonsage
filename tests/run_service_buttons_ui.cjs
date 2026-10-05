"use strict";

// Isolated, synthetic preview only. No real service changes or remote requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {chromium, webkit} = require("playwright");
const base = new URL(process.argv[2] || "http://127.0.0.1:8882/");
if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname)
    || base.username || base.password || base.pathname !== "/") throw new Error("Only an isolated loopback preview is allowed.");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-service-buttons-"));
const services = ["amneziawg", "management", "vless", "clash", "file", "mosh", "ssh", "firewall"];
const confirms = ["service", "network", "subscription", "proxy", "firewall", "managed-port", "ssh-key", "file", "backup", "security", "legacy-network", "legacy-ssh", "legacy-file"];
const taskPath = index => `tasks/task-${index.toString(16).padStart(32, "0")}/`;
const report = {output, cases: [], screenshots: [], errors: [], blocked: []};

async function inspect(page, label, width) {
  const result = await page.locator("main").evaluate((main, width) => {
    const controls = [...main.querySelectorAll('button, summary, .action-button, .secondary-button, input:not([type="hidden"]), select, textarea')]
      .filter(element => element.getClientRects().length && !["checkbox", "radio"].includes(element.type));
    const metrics = controls.map(element => {
      const rect = element.getBoundingClientRect();
      return {element, rect, label: element.getAttribute("aria-label") || element.textContent.trim() || element.name || element.tagName};
    });
    const failures = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) failures.push("horizontal page overflow");
    for (const item of metrics) {
      if (item.rect.left < -1 || item.rect.right > innerWidth + 1) failures.push(`outside viewport: ${item.label}`);
      if (width < 768 && (item.rect.height < 43.9 || item.rect.width < 43.9)) failures.push(`small touch target: ${item.label}`);
      if (["BUTTON", "SUMMARY", "A"].includes(item.element.tagName) && item.element.scrollWidth > item.element.clientWidth + 1)
        failures.push(`clipped button label: ${item.label}`);
    }
    for (let i = 0; i < metrics.length; i += 1) {
      for (const other of metrics.slice(i + 1)) {
        const item = metrics[i];
        if (item.element.contains(other.element) || other.element.contains(item.element)) continue;
        if (Math.min(item.rect.right, other.rect.right) - Math.max(item.rect.left, other.rect.left) > 2
            && Math.min(item.rect.bottom, other.rect.bottom) - Math.max(item.rect.top, other.rect.top) > 2)
          failures.push(`overlapping controls: ${item.label} / ${other.label}`);
      }
    }
    return {failures, controls: metrics.length};
  }, width);
  assert.deepEqual(result.failures, [], `${label}: ${result.failures.join("; ")}`);
  report.cases.push({label, controls: result.controls});
}

async function screenshot(page, label) {
  const file = path.join(output, `${label}.png`);
  await page.evaluate(() => window.scrollTo({top: 0, behavior: "instant"}));
  await page.screenshot({path: file, fullPage: true});
  report.screenshots.push(file);
}

async function checkHits(page, locator, label) {
  for (const control of await locator.all()) {
    await control.evaluate(element => element.scrollIntoView({block: "center", behavior: "instant"}));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const hit = await control.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {ok: element.contains(target), target: target?.outerHTML.slice(0, 200), top: rect.top, left: rect.left};
    });
    assert.equal(hit.ok, true, `${label}: control covered ${JSON.stringify(hit)}`);
  }
}

async function run(engine, browserLabel, width, theme = "dark") {
  const label = `${browserLabel}-${theme}`;
  const browser = await engine.launch();
  const context = await browser.newContext({viewport: {width, height: width < 768 ? 568 : 900}, ...(width < 768 ? {isMobile: true, hasTouch: true} : {})});
  try {
    await context.addInitScript(theme => localStorage.setItem("server-kit-theme", theme), theme);
    await context.route("**/*", route => {
      const request = route.request();
      if (new URL(request.url()).origin !== base.origin || (request.method() !== "GET" && !request.url().endsWith("/login/"))) {
        report.blocked.push({url: request.url(), method: request.method()});
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(new URL("login/", base).href);
    await page.locator('[name="username"]').fill("preview");
    await page.locator('[name="password"]').fill("Preview-only-2026!");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(new URL("overview/", base).href);
    assert.equal((await context.request.get(new URL("__preview__/scenario/rich/", base).href)).status(), 200);
    for (const service of services) {
      await page.goto(new URL(`services/${service}/`, base).href);
      const name = `${label}-${width}-${service}`;
      await inspect(page, name, width);
      if (service === "ssh") {
        // Opening all editors must not cover later rows, their delete buttons,
        // or another editor. This previously failed on tablet and desktop.
        for (const summary of await page.locator(".ssh-key-actions summary").all()) await summary.click();
        await inspect(page, `${name}-expanded`, width);
        await checkHits(page, page.locator('.ssh-key-actions details[open] button, .ssh-key-actions details[open] input:not([type="hidden"])'), name);
        await screenshot(page, `${name}-expanded`);
      } else if (["clash", "firewall"].includes(service)) await screenshot(page, name);
    }
    for (const confirm of confirms) {
      await page.goto(new URL(`__preview__/confirm/${confirm}/`, base).href);
      const name = `${label}-${width}-confirm-${confirm}`;
      await inspect(page, name, width);
      const actions = page.locator(".confirm-actions, .confirmation-actions");
      assert.equal(await actions.count(), 1, name);
      assert.equal(await actions.locator("a, button").first().innerText(), "取消", `${name}: consistent cancel-first order`);
      await checkHits(page, actions.locator("a, button"), name);
      if (["security", "proxy"].includes(confirm)) await screenshot(page, name);
      if (confirm === "security") {
        // Synthetic text stress only, never submit a real or simulated task.
        await actions.locator("button").evaluate(button => { button.textContent = "确认提交安全事务并在后台校验配置"; });
        await inspect(page, `${name}-long-label`, width);
        await checkHits(page, actions.locator("a, button"), `${name}-long-label`);
      }
    }
    for (let index = 1; index <= 8; index += 1) {
      await page.goto(new URL(taskPath(index), base).href);
      await inspect(page, `${label}-${width}-task-${index}`, width);
      await checkHits(page, page.locator("main button, main .action-button, main .secondary-button"), `${label}-${width}-task-${index}`);
      if (index === 5) {
        await page.locator(".task-error p").evaluate(element => {
          element.textContent = "模拟任务校验失败；原有管理连接与网络策略已保留。请检查目标服务、访问权限与独立管理连接后，再重新生成影响预览。".repeat(8);
        });
        await inspect(page, `${label}-${width}-task-long-error`, width);
        await checkHits(page, page.locator("main button, main .action-button, main .secondary-button"), `${label}-${width}-task-long-error`);
      }
    }
    // A task's rollback warning links back to this two-action transaction page.
    assert.equal((await context.request.get(new URL("__preview__/scenario/pending/", base).href)).status(), 200);
    await page.goto(new URL("security/transactions/", base).href);
    const pending = page.locator(".transaction-card.pending");
    assert.equal(await pending.count(), 1);
    assert.equal(await pending.locator(".action-row button").count(), 2);
    assert.match(await pending.locator("[data-countdown-value]").innerText(), /^2\d\d$/);
    await inspect(page, `${label}-${width}-pending-transaction`, width);
    await checkHits(page, pending.locator("button"), `${label}-${width}-pending-transaction`);
    await screenshot(page, `${label}-${width}-pending-transaction`);
    // Generate only a local preview, render the real rollback-confirm template,
    // and never invoke its execute endpoint.
    const previewURL = new URL("security/transactions/firewall/preview/", base).href;
    const csrf = await pending.locator('[name="csrfmiddlewaretoken"]').first().inputValue();
    const response = await context.request.post(previewURL, {
      form: {csrfmiddlewaretoken: csrf, operation: "rollback"}, headers: {Referer: page.url()},
    });
    assert.equal(response.status(), 200);
    const html = await response.text();
    await page.route(previewURL, route => route.fulfill({status: 200, contentType: "text/html", body: html}), {times: 1});
    await page.goto(previewURL);
    assert.equal(await page.locator('.confirm-actions .danger-button').innerText(), "立即回滚");
    await inspect(page, `${label}-${width}-rollback-confirm`, width);
    await checkHits(page, page.locator(".confirm-actions a, .confirm-actions button"), `${label}-${width}-rollback-confirm`);
    await screenshot(page, `${label}-${width}-rollback-confirm`);
    assert.equal((await context.request.get(new URL("__preview__/scenario/error/", base).href)).status(), 200);
    await page.goto(new URL(taskPath(3), base).href);
    assert.match(await page.locator("main h1").innerText(), /暂时无法读取任务/);
    await inspect(page, `${label}-${width}-task-unavailable`, width);
    await checkHits(page, page.locator("main .action-row a"), `${label}-${width}-task-unavailable`);
    await screenshot(page, `${label}-${width}-task-unavailable`);
  } finally {
    await context.request.get(new URL("__preview__/scenario/rich/", base).href).catch(() => {});
    await browser.close();
  }
}

(async () => {
  for (const [label, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    for (const width of [320, 390, 768, 1440]) await run(engine, label, width);
  }
  await run(webkit, "webkit", 320, "light");
  assert.deepEqual(report.errors, [], "browser errors");
  assert.deepEqual(report.blocked, [], "no external requests or state-changing actions");
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({output, cases: report.cases.length, screenshots: report.screenshots.length, errors: report.errors}, null, 2));
})().catch(error => {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({...report, failure: error.stack}, null, 2));
  console.error(error.stack, `\nArtifacts: ${output}`);
  process.exitCode = 1;
});
