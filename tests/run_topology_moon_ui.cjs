"use strict";

// Pure local renderer geometry: no server, external assets, or management writes.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {chromium, webkit} = require("playwright");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-lunar-geometry-"));
const source = fs.readFileSync(path.join(__dirname, "../web/static/topology_moon.js"), "utf8");
const report = {directory, engines: [], errors: [], external: []};
(async () => {
  try {
    for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        page.on("pageerror", error => report.errors.push(error.message));
        await page.route("**/*", route => { report.external.push(route.request().url()); return route.abort(); });
        await page.setContent("<!doctype html><html><body></body></html>"); await page.addScriptTag({content: source});
        const result = await page.evaluate(async () => {
          const fail = message => { throw new Error(message); }, check = (condition, message) => { if (!condition) fail(message); };
          const close = (a, b, label) => check(Math.abs(a - b) < .000002, `${label}: ${a} vs ${b}`);
          const renderer = window.MoonsageLunarSurface.create(); document.body.append(renderer.element);
          const svg = renderer.element, paths = [...svg.querySelectorAll("[data-lunar-feature]")];
          check(paths.length >= 12 && new Set(paths.map(path => path.dataset.lunarFeature)).size === paths.length, "Distinct permanent near- and far-side terrain");
          check(svg.getAttribute("aria-hidden") === "true" && svg.getAttribute("pointer-events") === "none", "Texture is purely decorative");
          const state = () => paths.map(path => ({id: path.dataset.lunarFeature, d: path.getAttribute("d"), visible: path.getAttribute("visibility"),
            x: Number(path.dataset.centerX), y: Number(path.dataset.centerY), z: Number(path.dataset.centerDepth)}));
          const serialize = () => svg.outerHTML;
          renderer.render(0, 0); const world = state();
          world.forEach(point => close(Math.hypot(point.x, point.y, point.z), 1, "Feature center lives on the unit sphere"));
          let cases = 0, partiallyClipped = 0, front = 0, rear = 0;
          const allVisible = new Set();
          for (let yi = 0; yi < 36; yi++) for (let pi = 0; pi < 20; pi++) {
            const yaw = (yi - 18) * Math.PI / 18, pitch = (pi - 10) * Math.PI / 10;
            renderer.render(yaw, pitch); const current = state();
            check(Number(svg.dataset.orientationYaw) >= -Math.PI - 1e-11 && Number(svg.dataset.orientationYaw) < Math.PI,
              "Canonical yaw remains normalized");
            check(Number(svg.dataset.orientationPitch) >= -Math.PI - 1e-11 && Number(svg.dataset.orientationPitch) < Math.PI,
              "Canonical pitch remains normalized");
            current.forEach((point, index) => {
              const original = world[index], x = Math.cos(yaw) * original.x + Math.sin(yaw) * original.z;
              const z = -Math.sin(yaw) * original.x + Math.cos(yaw) * original.z;
              close(point.x, x, "True spherical yaw X");
              close(point.y, Math.cos(pitch) * original.y - Math.sin(pitch) * z, "True spherical pitch Y");
              close(point.z, Math.sin(pitch) * original.y + Math.cos(pitch) * z, "True depth, not planar rotation");
              if (point.z < -.5) { check(!point.d && point.visible === "hidden", "Rear terrain cannot show through the sphere"); rear++; }
              if (point.z > .5) { check(point.d && point.visible === "visible", "Near terrain is visible"); front++; }
              check(!/NaN|Infinity/.test(point.d), "Finite horizon clipping");
              check((point.visible === "visible") === !!point.d, "Hidden paths and geometry agree");
              if (point.d) allVisible.add(point.id);
              for (const command of point.d.matchAll(/([MLA])\s+([^MLAZ]+)/g)) {
                const values = command[2].trim().split(/\s+/).map(Number), coords = command[1] === "A" ? values.slice(-2) : values;
                check(coords.length === 2 && coords.every(Number.isFinite), "Path endpoint is a finite coordinate pair");
                check(Math.hypot(coords[0] - 50, coords[1] - 50) <= 49.002, "Clipped terrain remains inside the lunar limb");
                if (command[1] === "A") partiallyClipped++;
              }
            });
            check(Number(svg.dataset.visibleFeatures) === current.filter(point => point.d).length, "Visibility metadata matches actual paths");
            const exact = serialize(); renderer.render(yaw + Math.PI * 2, pitch + Math.PI * 2);
            check(serialize() === exact, "Full 360-degree turns close exactly without crawling or reseeding texture");
            renderer.render(yaw, pitch); check(serialize() === exact, "Repeated orientations are deterministic"); cases++;
          }
          check(allVisible.size === paths.length && front > 0 && rear > 0 && partiallyClipped > 0, "Coverage exercises both hemispheres and actual horizon clipping");
          renderer.render(-.36, -.22); const defaultState = serialize(); renderer.render(NaN, Infinity);
          check(serialize() === defaultState, "Nonfinite input safely falls back to the default view");
          let mutations = 0; const observer = new MutationObserver(changes => { mutations += changes.length; });
          observer.observe(svg, {attributes: true, subtree: true});
          renderer.render(-.36, -.22); renderer.render(-.36 + Math.PI * 2, -.22 + Math.PI * 2);
          await new Promise(resolve => setTimeout(resolve, 50)); observer.disconnect();
          check(mutations === 0, "Identical/whole-turn orientations do not redraw or keep animating at rest");
          return {cases, features: paths.length, vertexCount: Number(svg.dataset.vertexCount), partiallyClipped, front, rear, stableMutations: mutations};
        });
        assert.equal(result.cases, 720); report.engines.push({name, ...result});
      } finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
})();
