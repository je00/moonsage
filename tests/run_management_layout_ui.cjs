"use strict";

// Read-only UI coverage of the management pages. Run a dedicated synthetic
// preview instance; login/preview generation never executes a management task.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync} = require("node:child_process");
const {chromium, webkit} = require("playwright");
const base = new URL(process.argv[2] || "http://127.0.0.1:8883/");
assert.ok(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && base.port && Number(base.port) >= 1024 && base.pathname === "/"
  && !base.username && !base.password && !base.search && !base.hash,
"Only an isolated loopback preview is allowed.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-management-layout-"));
const report = {directory, checks: [], errors: [], blocked: [], mutations: []};
const routes = ["overview/", "accounts/", "backups/", "files/", "deploy/", "audit/", "security/transactions/"];

// Render the real installation template using missing-service fake data, with
// every inherited production path isolated before Django setup. No agent call.
const rendered = spawnSync(process.env.MANAGEMENT_TEST_PYTHON || "python3", ["-c", `
import os, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
with tempfile.TemporaryDirectory(prefix="management-layout-", dir="/tmp") as temporary:
    os.environ.update(SERVER_KIT_TESTING="1", SERVER_KIT_WEB_STATE=temporary,
        SERVER_KIT_AGENT_SOCKET=temporary+"/never-used.sock", SERVER_KIT_SECRET_KEY_FILE=temporary+"/no-secret",
        SERVER_KIT_BACKUP_DIR=temporary+"/backups", DJANGO_SETTINGS_MODULE="server_kit_web.settings")
    sys.path.insert(0, str(Path.cwd()/"web"))
    import django
    django.setup()
    from django.test import RequestFactory
    from django.template.loader import render_to_string
    request = RequestFactory().get("/deploy/")
    request.user = SimpleNamespace(is_superuser=True, is_staff=True, is_authenticated=True, username="preview")
    services = {key: {"state":"未安装"} for key in ("vless","clash","mosh","file")}
    print(render_to_string("dashboard/deployment_wizard.html", {"services":services,"active_page":"deploy"}, request=request))
`], {cwd: path.resolve(__dirname, ".."), encoding: "utf8"});
assert.equal(rendered.status, 0, rendered.stderr);

async function capture(page, engine, width, label, scope = "main") {
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  const result = await page.evaluate(scope => {
    const host = document.querySelector(scope);
    const visible = element => {
      if (!element.getClientRects().length || element.closest("[hidden]")) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches("details:not([open])") && !parent.querySelector(":scope > summary")?.contains(element)) return false;
      }
      return true;
    };
    const controls = [...host.querySelectorAll("button:not(.qr-backdrop), summary, a.action-button, a.secondary-button, a.copy-button, .deployment-tabs a, a.guide-step-open, .guide-step-apps a")].filter(visible);
    const escaping = controls.filter(element => {
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > innerWidth + 1;
    }).map(element => element.textContent.trim());
    const undersized = controls.filter(element => element.getBoundingClientRect().height < 43.9)
      .map(element => ({text: element.textContent.trim(), height: element.getBoundingClientRect().height}));
    const escapedForms = [...host.querySelectorAll(".account-actions details[open] form, .backup-actions details[open] form")]
      .filter(element => { const r = element.getBoundingClientRect(), row = element.closest("article").getBoundingClientRect();
        return r.left < row.left - 1 || r.right > row.right + 1 || r.bottom > row.bottom + 1;
      }).length;
    const mismatchedDisclosureWidths = [...host.querySelectorAll(".account-actions details[open], .backup-actions details[open]")]
      .filter(element => Math.abs(element.querySelector("summary").getBoundingClientRect().width
        - element.querySelector("form").getBoundingClientRect().width) > 1).length;
    return {overflow: document.documentElement.scrollWidth > innerWidth + 1, escaping, undersized, escapedForms, mismatchedDisclosureWidths};
  }, scope);
  report.checks.push({engine, width, label, ...result});
  await page.screenshot({path: path.join(directory, `${engine}-${width}-${label}.png`), fullPage: scope === "main"});
  if (scope !== "main") {
    const dialog = page.locator(`${scope} [role="dialog"]`);
    const box = await dialog.boundingBox();
    assert.ok(box.y >= -1 && box.y + box.height <= page.viewportSize().height + 1,
      `${engine}/${width}/${label}: dialog outside the viewport`);
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
      `${engine}/${width}/${label}: horizontal dialog overflow`);
    for (const control of await dialog.locator("button:visible, a:visible").all()) {
      await control.scrollIntoViewIfNeeded();
      assert.ok(await control.evaluate(element => {
        const r = element.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return element === target || element.contains(target);
      }), `${engine}/${width}/${label}: dialog control cannot be reached after scrolling`);
    }
  }
}

async function main() {
  for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await launcher.launch({headless: true});
    try {
      const context = await browser.newContext({viewport: {width: 390, height: 844}});
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base.origin) { report.blocked.push(request.url()); return route.abort(); }
        if (request.method() !== "GET" && !["/login/", "/network/proxy/"].includes(url.pathname)
          && !/^\/files\/file-[a-f0-9]+\/link\/$/.test(url.pathname)) {
          report.mutations.push(url.pathname); return route.abort();
        }
        if (url.pathname === "/deploy/" && url.searchParams.has("layout"))
          return route.fulfill({status: 200, contentType: "text/html", body: rendered.stdout});
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on("pageerror", error => report.errors.push(error.message));
      await page.goto(new URL("login/", base).href);
      await page.locator('[name="username"]').fill("preview");
      await page.locator('[name="password"]').fill("Preview-only-2026!");
      await Promise.all([page.waitForURL("**/overview/"), page.locator('button[type="submit"]').click()]);
      await page.goto(new URL("__preview__/", base).href);
      assert.equal(await page.title(), "Local visual preview");

      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({width, height: width < 768 ? 844 : 1000});
        await context.request.get(new URL("__preview__/scenario/rich/", base).href);
        for (const route of routes) {
          await page.goto(new URL(route, base).href);
          const label = route.replaceAll("/", "-");
          await capture(page, engine, width, label + "default");
          if (await page.locator("main details").count()) {
            await page.locator("main details").evaluateAll(elements => elements.forEach(element => element.open = true));
            await capture(page, engine, width, label + "expanded");
          }
        }
        await page.goto(new URL("deploy/?layout=uninstalled", base).href);
        await page.locator("main details").evaluateAll(elements => elements.forEach(element => element.open = true));
        assert.equal(await page.locator(".wizard-form").count(), 4);
        await capture(page, engine, width, "deploy-install");
        await page.goto(new URL("guides/nodes/", base).href);
        for (const platform of await page.locator("[data-platform-button]").evaluateAll(elements => elements.map(element => element.dataset.platformButton))) {
          await page.locator(`[data-platform-button="${platform}"]`).click();
          await page.locator("main details").evaluateAll(elements => elements.forEach(element => element.open = true));
          await capture(page, engine, width, "guide-" + platform);
        }
        await context.request.get(new URL("__preview__/scenario/pending/", base).href);
        for (const route of ["backups/", "security/transactions/"]) {
          await page.goto(new URL(route, base).href);
          await capture(page, engine, width, route.replaceAll("/", "-") + "pending");
        }
        await context.request.get(new URL("__preview__/scenario/rich/", base).href);
        await page.goto(new URL("files/", base).href);
        await page.locator('[data-secret-action="copy"]').first().click();
        await page.locator("[data-sensitive-auth-modal]").waitFor({state: "visible"});
        await capture(page, engine, width, "sensitive-auth", "[data-sensitive-auth-modal]");
        await page.keyboard.press("Escape");
        await page.goto(new URL("network/proxy/", base).href);
        const form = page.locator('form:has([name="operation"][value="airport_delete"])').first();
        await form.evaluate(element => { for (let p = element.parentElement; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true; });
        await form.locator('[name="password"]').fill("Preview-only-2026!");
        await form.locator('[name="confirmed"]').check();
        await form.locator('button[type="submit"]').click();
        await page.locator("[data-inline-confirm]").waitFor({state: "visible"});
        await capture(page, engine, width, "inline-confirm", "[data-inline-task-modal]");
        await page.setViewportSize({width, height: 480});
        await capture(page, engine, width, "inline-confirm-short", "[data-inline-task-modal]");
        await page.locator("[data-inline-edit]").click();
        if ([320, 1440].includes(width)) {
          await page.setViewportSize({width, height: width < 768 ? 844 : 1000});
          for (const scenario of ["empty", "error"]) {
            await context.request.get(new URL(`__preview__/scenario/${scenario}/`, base).href);
            for (const route of routes) {
              await page.goto(new URL(route, base).href);
              await capture(page, engine, width, route.replaceAll("/", "-") + scenario);
            }
          }
        }
      }
      await context.close();
    } finally { await browser.close(); }
  }
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  const failures = report.checks.filter(check => check.overflow || check.escaping.length || check.escapedForms || check.mismatchedDisclosureWidths
    || check.width <= 768 && check.undersized.length);
  console.log(JSON.stringify({directory, checks: report.checks.length, failures, errors: report.errors, blocked: report.blocked, mutations: report.mutations}, null, 2));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.mutations, []);
  assert.deepEqual(failures, []);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
