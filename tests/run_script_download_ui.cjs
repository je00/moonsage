"use strict";

// Download scripts from the isolated fixture; never execute downloaded code.
const {chromium, webkit} = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const base = new URL(process.argv[2] || "http://127.0.0.1:8876/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password
  && base.pathname === "/" && !base.search && !base.hash, "Use an isolated loopback preview.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-script-downloads-"));
const report = {directory, downloads: [], errors: [], external: []};
const expected = {
  windows: ["server-kit-ssh.cmd", "# server-kit Windows SSH 综合管理器"],
  linux: ["server-kit-node-linux.sh", "# server-kit Debian/Ubuntu SSH 综合管理器"],
  macos: ["server-kit-ssh.sh", "# server-kit macOS SSH 综合管理器"],
  android: ["server-kit-ssh.sh", "# server-kit Termux SSH 综合管理器"],
};
async function main() {
  for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({acceptDownloads: true, reducedMotion: "reduce"});
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
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({width, height: 900});
        for (const theme of ["light", "dark"]) {
          await page.goto(base.href);
          await page.locator(`[data-theme-value="${theme}"]`).click();
          await page.goto(new URL("guides/nodes/", base).href);
          assert.equal(await page.locator('a[href="/guides/nodes/scripts/download/"]').count(), 0);
          for (const [platform, [filename, marker]] of Object.entries(expected)) {
            await page.locator(`[data-platform-button="${platform}"]`).click();
            const panel = page.locator(`[data-platform-panel="${platform}"]`);
            assert(await panel.isVisible());
            const href = `/guides/nodes/sshd/${platform}/download/`;
            const link = panel.locator(`a[href="${href}"]`);
            assert.equal(await link.count(), 1);
            const step = panel.locator(".guide-steps > li").filter({has: page.locator(`a[href="${href}"]`)});
            const text = await step.innerText();
            assert(text.includes("无需解压"));
            if (platform === "android") {
              assert(text.includes("VLESS 不提供入站 SSH"));
              assert(!text.includes("5 分钟") && !text.includes("仅公钥认证"));
            }
            assert(!/\.\/linux\/|\.\/macos\/|windows\\/.test(text));
            const response = await context.request.get(new URL(href, base).href);
            assert.equal(response.status(), 200);
            assert.match(response.headers()["cache-control"], /no-store/);
            assert.equal(response.headers()["x-content-type-options"], "nosniff");
            assert(!response.headers()["content-type"].includes("zip"));
            const pending = page.waitForEvent("download");
            await link.click();
            const download = await pending;
            assert.equal(download.suggestedFilename(), filename);
            assert.equal(await download.failure(), null);
            const payload = fs.readFileSync(await download.path());
            assert.deepEqual(payload, await response.body());
            assert(!payload.subarray(0, 2).equals(Buffer.from("PK")));
            const script = payload.toString("utf8");
            assert(script.includes(marker));
            for (const [other, [, otherMarker]] of Object.entries(expected)) {
              if (platform !== other) assert(!script.includes(otherMarker));
            }
            assert.equal(new URL(page.url()).pathname, "/guides/nodes/");
            assert(await panel.isVisible(), "Download must keep the selected platform open");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await step.screenshot({path: path.join(directory, `${engineName}-${width}-${theme}-${platform}.png`)});
            report.downloads.push({browser: engineName, width, theme, platform, filename, bytes: payload.length});
          }
          await page.locator('[data-platform-button="iphone"]').click();
          assert.equal(await page.locator('[data-platform-panel="iphone"] a[href*="/sshd/"]').count(), 0);
        }
      }
      const legacy = await context.request.get(new URL("guides/nodes/scripts/download/", base).href, {maxRedirects: 0});
      assert.equal(legacy.status(), 302);
      assert.equal(legacy.headers().location, "/guides/nodes/");
      const anonymous = await browser.newContext();
      const linux = await anonymous.request.get(new URL("guides/nodes/scripts/linux/server-kit-node-linux.sh", base).href);
      assert.equal(linux.status(), 200);
      assert((await linux.text()).includes("###SERVER_KIT_AWG_PAYLOAD###"));
      for (const platform of Object.keys(expected)) {
        const response = await anonymous.request.get(new URL(`guides/nodes/sshd/${platform}/download/`, base).href, {maxRedirects: 0});
        assert.equal(response.status(), 302);
        assert(response.headers().location.startsWith("/login/?next="));
      }
      await anonymous.close();
      await context.close();
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
}
main().catch(error => { report.failure = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({directory, downloads: report.downloads.length,
    errors: report.errors, external: report.external, failure: report.failure || null}, null, 2));
});
