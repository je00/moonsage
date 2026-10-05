"use strict";

// Optional browser QA. Requires Playwright + a Chromium browser installation.
// Run the isolated preview first; this script refuses non-loopback origins.
const {chromium} = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function buttonLayout(page) {
  return page.evaluate(() => {
    const selector = 'button, input[type="submit"], input[type="button"], a.primary-button, a.action-button, a.secondary-button, a.copy-button, summary';
    const controls = [...document.querySelectorAll(selector)].filter(node => {
      const style = getComputedStyle(node);
      if (!node.getClientRects().length || style.visibility === "hidden" || node.closest("[hidden]")) return false;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS" && !parent.open && !parent.querySelector(":scope > summary")?.contains(node)) return false;
      }
      return true;
    });
    const findings = [];
    for (const node of controls) {
      const box = node.getBoundingClientRect(), label = (node.innerText || node.value || node.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 90);
      const issue = reason => findings.push({label, tag: node.tagName, classes: node.className, reason, width: box.width, height: box.height});
      if (box.left < -1 || box.right > innerWidth + 1) issue("outside viewport");
      if (innerWidth <= 900 && node.tagName !== "SUMMARY" && box.height < 43.5) issue("touch target shorter than 44px");
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim() || text.parentElement.closest("svg, .sr-only, .visually-hidden")) continue;
        // Native-size topology cards deliberately ellipsize long names while
        // retaining the complete label in their details/accessible name.
        let clippedLabel = false;
        for (let parent = text.parentElement; parent && parent !== node; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.textOverflow === "ellipsis" && style.overflowX === "hidden") clippedLabel = true;
        }
        if (clippedLabel) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
        if (rects.some(rect => rect.left < box.left - 2 || rect.right > box.right + 2 || rect.top < box.top - 2 || rect.bottom > box.bottom + 2)) {
          issue("label outside control"); break;
        }
      }
    }
    return {controlCount: controls.length, controlFindings: findings};
  });
}

async function main() {
  const base = new URL(process.argv[2] || "http://127.0.0.1:8765/");
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname)
    || base.username || base.password || base.pathname !== "/") {
    throw new Error("Use an isolated http://127.0.0.1:PORT/ preview, never a production host.");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "server-kit-visual-audit-"));
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const blocked = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === base.origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  const checks = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(new URL("login/", base).href);
    await page.screenshot({path: path.join(directory, "login-desktop.png"), fullPage: true});
    await page.locator('[name="username"]').fill("preview");
    await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("/overview/", base).href), page.locator('button[type="submit"]').click()]);
    await page.goto(new URL("__preview__/", base).href);
    const routes = await page.locator('a[href^="/"]').evaluateAll(links => [...new Set(links
      .map(link => link.getAttribute("href"))
      .filter(href => !href.startsWith("/__preview__/scenario/")))]);
    if (routes.length < 30) throw new Error("Expected the complete preview-only route inventory.");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({width, height: width >= 768 ? 1000 : 844});
      for (const route of routes) {
        const response = await page.goto(new URL(route, base).href);
        await page.evaluate(() => document.activeElement?.blur());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const metrics = await page.evaluate(() => ({
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          mainCount: document.querySelectorAll("main#main-content").length,
          titleCount: document.querySelectorAll("main h1").length,
        }));
        const name = route === "/" ? "home" : route.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "");
        await page.screenshot({path: path.join(directory, `${width}-${name}.png`), fullPage: true});
        checks.push({route, width, status: response.status(), ...metrics, ...await buttonLayout(page)});
      }
    }
    const failures = checks.filter(check => check.status !== 200 || check.horizontalOverflow
      || check.mainCount !== 1 || check.titleCount !== 1 || check.controlFindings.length);
    const report = {base: base.origin, checks, failures, errors, blocked};
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({directory, pages: routes.length, screenshots: checks.length + 1,
      layoutFailures: failures.length, scriptErrors: errors.length, externalRequests: blocked.length}, null, 2));
    if (!process.argv.includes("--report-only") && (failures.length || errors.length || blocked.length)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
