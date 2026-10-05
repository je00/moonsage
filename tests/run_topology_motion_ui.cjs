"use strict";

// Synthetic local-only regression for bounded user-initiated camera motion.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {chromium, webkit} = require("playwright");
const {assertFixedCenter} = require("./topology_fixed_contract.cjs");
const {orbit} = require("./topology_gestures.cjs");
const base = new URL(process.argv[2] || "http://127.0.0.1:8878/");
assert(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)
  && Number(base.port) >= 1024 && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moonsage-topology-motion-"));
const report = {directory, cases: [], screenshots: [], errors: [], external: []};
const hook = (page, name) => page.locator(`[data-topology-${name}]`);
const camera = value => [value.yaw, value.pitch];
const sleep = (page, milliseconds) => page.waitForTimeout(milliseconds);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function snapshot(page) {
  await assertFixedCenter(page);
  return hook(page, "graph").evaluate(graph => ({yaw: Number(graph.dataset.cameraYaw), pitch: Number(graph.dataset.cameraPitch),
    inertia: graph.dataset.inertia, dragging: graph.dataset.dragging === "true",
    xyz: [...graph.querySelectorAll("[data-topology-node]")].map(node => [node.dataset.topologyNode, node.dataset.spaceX, node.dataset.spaceY, node.dataset.spaceZ]),
    raf: {pending: window.__motionRAF.pending.size, executed: window.__motionRAF.executed},
    moon: (() => { const svg = graph.querySelector(".topology-lunar-surface"); return {yaw: Number(svg?.dataset.orientationYaw), pitch: Number(svg?.dataset.orientationPitch),
      paths: [...(svg?.querySelectorAll("[data-lunar-feature]") || [])].map(el => [el.dataset.lunarFeature, el.getAttribute("d"), el.getAttribute("display")])}; })()}));
}
async function background(page) {
  await hook(page, "graph").evaluate(graph => scrollTo(0, graph.getBoundingClientRect().top + scrollY - 140));
  await settle(page);
  const point = await hook(page, "graph").evaluate(graph => {
    const box = graph.getBoundingClientRect();
    for (let y = Math.max(200, box.top + 30); y < Math.min(innerHeight - 190, box.bottom - 60); y += 24)
      for (let x = box.left + 35; x < box.right - 95; x += 24) {
        const el = document.elementFromPoint(x, y);
        if (el && graph.contains(el) && !el.closest("[data-topology-node]")) return {x, y};
      }
    return null;
  });
  assert(point, "Motion starts over a genuinely visible blank part of the canvas"); return point;
}
async function reset(page) { await hook(page, "reset").click(); await settle(page); assert.equal((await snapshot(page)).inertia, "idle"); }
async function installCoastProbe(page) {
  await page.evaluate(() => {
    const graph = document.querySelector("[data-topology-graph]");
    window.__coastProbe = {result:null};
    graph.addEventListener("pointerup", () => {
      const releasedAt = performance.now(), releasedYaw = Number(graph.dataset.cameraYaw), running = graph.dataset.inertia === "running";
      let previousYaw = releasedYaw, travel = 0;
      const samples = [{at:0,travel:0}];
      const step = () => {
        const at = performance.now() - releasedAt, yaw = Number(graph.dataset.cameraYaw);
        travel += Math.atan2(Math.sin(yaw - previousYaw), Math.cos(yaw - previousYaw)); previousYaw = yaw;
        samples.push({at,travel});
        if (graph.dataset.inertia !== "running" || at > 2500) {
          const early = samples.find(sample => sample.at >= 80) || samples.at(-1);
          window.__coastProbe.result = {running,stopped:graph.dataset.inertia === "idle",duration:running ? at : 0,
            travel,earlySpeed:early.at ? early.travel / early.at : 0,samples};
        } else requestAnimationFrame(step);
      };
      step();
    }, {once:true});
  });
}
async function readCoast(page) {
  await page.waitForFunction(() => window.__coastProbe?.result, undefined, {timeout:3000});
  const result = await page.evaluate(() => window.__coastProbe.result);
  assert(result.stopped, "Every measured release actually reaches idle, never just the probe timeout");
  await assertFixedCenter(page);
  return result;
}
async function measuredTrack(page, {pixelsPerMs, interval = 16, pause = 0, trusted = false}) {
  await reset(page); const start = await background(page), before = await snapshot(page); await installCoastProbe(page);
  if (trusted) {
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    for (let index = 1; index <= 12; index++) {
      await sleep(page,16); await page.mouse.move(start.x + index * pixelsPerMs * 16,start.y);
    }
    if (pause) await sleep(page,pause); await page.mouse.up();
  } else await page.evaluate(async ({start,pixelsPerMs,interval,pause}) => {
    const graph = document.querySelector("[data-topology-graph]"), started = performance.now(), touch = matchMedia("(pointer:coarse)").matches;
    const target = document.elementFromPoint(start.x,start.y);
    if(!target||!graph.contains(target))throw new Error("Motion must begin on the visible canvas");
    const send = (type,elapsed) => (type === "pointerdown" ? target : graph).dispatchEvent(new PointerEvent(type,{pointerId:921,pointerType:touch?"touch":"mouse",isPrimary:true,button:0,
      buttons:type === "pointerup" ? 0 : 1,bubbles:true,cancelable:true,clientX:start.x + elapsed * pixelsPerMs,clientY:start.y}));
    send("pointerdown",0); let elapsed = 0;
    while (elapsed < 240) { await new Promise(resolve => setTimeout(resolve,interval)); elapsed = performance.now() - started; send("pointermove",elapsed); }
    if (pause) await new Promise(resolve => setTimeout(resolve,pause)); send("pointerup",elapsed);
  },{start,pixelsPerMs,interval,pause});
  const result = await readCoast(page), after = await snapshot(page);
  assert.deepEqual(after.xyz,before.xyz,"Camera speed and event cadence never move a real node");
  if(page.viewportSize().width<768)assert.equal(after.pitch,before.pitch,"Measured touch speed changes yaw only, including its release inertia");
  return {pixelsPerMs,interval,trusted,...result};
}
async function speedCurves(page, desktop) {
  const tracks = [];
  for (const pixelsPerMs of [.08,.32,1.2]) tracks.push(await measuredTrack(page,{pixelsPerMs,trusted:desktop}));
  assert(tracks.every(track => track.running && track.earlySpeed > 0), "Slow, medium, and fast deliberate drags all produce forward motion");
  for (let index = 1; index < tracks.length; index++) {
    assert(tracks[index].earlySpeed > tracks[index - 1].earlySpeed * 1.5,"Faster hand movement produces a materially faster release instead of hitting the same low cap");
    assert(tracks[index].duration > tracks[index - 1].duration + 30,"Faster hand movement takes strictly longer to come to rest");
    assert(tracks[index].travel > tracks[index - 1].travel,"Release distance increases with actual drag speed");
  }
  const cadence = [];
  if (desktop) {
    for (const interval of [8,16,33]) cadence.push(await measuredTrack(page,{pixelsPerMs:.32,interval}));
    for (const field of ["earlySpeed","duration","travel"]) {
      const values = cadence.map(track => track[field]);
      assert(Math.max(...values) / Math.min(...values) < 1.25, `${field}: 8/16/33ms events describe the same physical velocity, not different inertia`);
    }
  }
  const paused = await measuredTrack(page,{pixelsPerMs:1.2,pause:120});
  assert.equal(paused.running,false,"A short deliberate pause before release discards obsolete velocity");
  const extreme = await measuredTrack(page,{pixelsPerMs:20,interval:8});
  assert(extreme.running && extreme.travel > tracks.at(-1).travel,"An extreme flick remains faster than a normal fast drag");
  assert(extreme.duration < 1900 && extreme.travel < 1.4 && extreme.earlySpeed <= .0036,
    "Even extreme input stays within the 1800ms hard stop, capped speed and bounded angular distance");
  return {tracks,cadence,paused,extreme};
}
async function flick(page, {sign = 1, pause = 0, cancel = false, pointerType = null} = {}) {
  const start = await background(page), before = await snapshot(page);
  const released = await page.evaluate(async ({start, sign, pause, cancel, pointerType}) => {
    const graph = document.querySelector("[data-topology-graph]"), touch = matchMedia("(pointer:coarse)").matches;
    const target = document.elementFromPoint(start.x,start.y);
    if(!target||!graph.contains(target))throw new Error("Motion must begin on the visible canvas");
    const send = (type, index) => (type === "pointerdown" ? target : graph).dispatchEvent(new PointerEvent(type, {pointerId: 901, pointerType:pointerType || (touch?"touch":"mouse"), isPrimary: true, button: 0,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1, bubbles: true, cancelable: true,
      clientX: start.x + index * 6 * sign, clientY: start.y + index * 2 * sign}));
    send("pointerdown", 0);
    for (let i = 1; i <= 8; i++) { await new Promise(resolve => setTimeout(resolve, 16)); send("pointermove", i); }
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    send(cancel ? "pointercancel" : "pointerup", 8);
    return {yaw: Number(graph.dataset.cameraYaw), pitch: Number(graph.dataset.cameraPitch), inertia: graph.dataset.inertia};
  }, {start, sign, pause, cancel, pointerType});
  assert(sign * (released.yaw - before.yaw) > .15, "Active drag still rotates in the intended direction");
  if(page.viewportSize().width<768&&pointerType!=="mouse")assert.equal(released.pitch,before.pitch,"A dominant horizontal touch locks yaw without changing pitch");
  return {before, released, start};
}
async function staysStopped(page, label, wait = 180) {
  const stopped = await snapshot(page); assert.equal(stopped.inertia, "idle", label + ": cancels immediately");
  await sleep(page, wait); const after = await snapshot(page);
  assert.deepEqual(camera(after), camera(stopped), label + ": no late camera movement");
  assert.deepEqual(after.xyz, stopped.xyz, label + ": camera motion never changes node data");
  return after;
}
async function boundedDecay(page) {
  await reset(page); const {before, released} = await flick(page);
  assert.equal(released.inertia, "running", "A recent active blank drag starts slight inertia on release");
  await sleep(page, 90); const first = await snapshot(page);
  await sleep(page, 100); const second = await snapshot(page);
  const early = first.yaw - released.yaw, late = second.yaw - first.yaw;
  assert(early > .025 && late > .005, "Coast visibly continues in the last drag direction");
  assert(late < early * .95, `The later interval slows down (${early} then ${late}), rather than maintaining permanent spin`);
  if(page.viewportSize().width<768) {
    assert.equal(first.pitch,before.pitch);assert.equal(second.pitch,before.pitch,"Touch inertia has zero pitch velocity");
  } else assert(first.pitch < released.pitch && second.pitch < first.pitch, "Desktop pitch inertia preserves the last vertical drag direction");
  assert.deepEqual(first.xyz, before.xyz); assert.deepEqual(second.xyz, before.xyz);
  assert.notDeepEqual(first.moon.paths, before.moon.paths, "The moon surface geometry follows live camera orientation");
  await sleep(page, 950); const ended = await staysStopped(page, "Bounded release", 120);
  if(page.viewportSize().width<768)assert.equal(ended.pitch,before.pitch,"The entire touch coast keeps its initial pitch");
  assert(ended.yaw - released.yaw < .42, "Coast has a small bounded extent, not another uncontrolled revolution");
  assert.equal(ended.raf.pending, 0, "No animation frame remains scheduled at rest");
  const executed = ended.raf.executed; await sleep(page, 120);
  assert.equal((await snapshot(page)).raf.executed, executed, "A stopped scene has no permanent RAF loop");
  await reset(page); const reverse = await flick(page, {sign: -1}); await sleep(page, 100);
  assert((await snapshot(page)).yaw < reverse.released.yaw, "Negative drag coasts in the negative direction too");
  await reset(page);
  return {early, late, extent: ended.yaw - released.yaw};
}
async function discreteAndNodeMotion(page, desktop) {
  await reset(page);
  if (desktop) {
    const point = await background(page);
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await sleep(page, 16); await page.mouse.move(point.x + i * 6, point.y + i * 2); }
    await page.mouse.up(); const released = await snapshot(page);
    assert.equal(released.inertia, "running", "Trusted mouse release survives real lostcapture/click sequencing");
    await sleep(page, 90); assert((await snapshot(page)).yaw > released.yaw, "Trusted mouse drag really coasts");
    await reset(page);
  }
  for (const isHub of [false, true]) {
    const before = await snapshot(page);
    const node = page.locator(isHub ? '[data-topology-node="hub"]' : '[data-topology-node]:not(.is-hub)').first();
    await node.evaluate(async node => {
      const graph = node.closest("[data-topology-graph]"), box = node.getBoundingClientRect();
      const send = (type, step) => (type === "pointerdown" ? node : graph).dispatchEvent(new PointerEvent(type, {bubbles:true, cancelable:true,
        pointerId:911, pointerType:"mouse", button:0, buttons:type === "pointerup" ? 0 : 1,
        clientX:box.left + box.width / 2 + step * 4, clientY:box.top + box.height / 2 + step * 2}));
      send("pointerdown", 0);
      for (let step = 1; step <= 8; step++) { await new Promise(resolve => setTimeout(resolve, 16)); send("pointermove", step); }
      send("pointerup", 8);
    });
    const after = await staysStopped(page, isHub ? "Immutable VPS drag" : "Leaf drag never coasts");
    assert.deepEqual(camera(after), camera(before), "Moving a real node cannot rotate the camera");
    if (isHub) assert.deepEqual(after.xyz, before.xyz); else assert.notDeepEqual(after.xyz, before.xyz, "Leaf drag still changes real coordinates");
  }
  await reset(page); await hook(page, "graph").focus(); await page.keyboard.press("ArrowRight");
  await staysStopped(page, "Discrete keyboard orbit");
}
async function cancellationMatrix(page, mobile) {
  const actions = [
    ["new pointer", async start => {
      await hook(page, "graph").dispatchEvent("pointerdown", {pointerId: 903, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true, clientX: start.x, clientY: start.y});
    }, async () => hook(page, "graph").dispatchEvent("pointercancel", {pointerId: 903, pointerType: "mouse"})],
    ["node selection", async () => { const select = hook(page, "select"); const id = await select.evaluate(el => [...el.options].find(option => !option.disabled && option.value && option.value !== el.value).value); await select.selectOption(id); }],
    ["explicit keyboard rotation", async () => orbit(page,"left")],
    ["view reset", async () => page.locator('[data-topology-orbit="reset"]').click()],
    ["keyboard", async () => { await hook(page, "graph").focus(); await page.keyboard.press("ArrowRight"); }],
    ["automatic arrangement", async () => hook(page, "reset").click()],
    ["refresh", async () => hook(page, "refresh").click()],
    ["direction", async () => page.locator('[data-topology-direction="reverse"]').click()],
    ["window blur", async () => page.evaluate(() => window.dispatchEvent(new Event("blur")))],
    ["pointercancel without a held pointer", async () => hook(page, "graph").dispatchEvent("pointercancel", {pointerId:999, pointerType:"mouse"})],
    ["wheel", async () => hook(page, "graph").dispatchEvent("wheel", {deltaY:100, ctrlKey:true})],
    ["page hidden", async () => page.evaluate(() => { Object.defineProperty(document, "hidden", {configurable: true, get: () => true}); document.dispatchEvent(new Event("visibilitychange")); }),
      async () => page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); })],
    ["two fingers", async start => page.evaluate(start => {
      const graph = document.querySelector("[data-topology-graph]");
      for (const id of [906, 907]) graph.dispatchEvent(new PointerEvent("pointerdown", {pointerId: id, pointerType: "touch", isPrimary: id === 906,
        bubbles: true, cancelable: true, clientX: start.x + (id - 906) * 24, clientY: start.y}));
    }, start), async () => page.evaluate(() => { for (const id of [906, 907]) window.dispatchEvent(new PointerEvent("pointercancel", {pointerId: id, pointerType: "touch", bubbles: true})); })],
  ];
  if (mobile) actions.push(["exit mobile editing", async () => hook(page, "layout-edit").click(), async () => hook(page, "layout-edit").click()]);
  for (const [label, action, cleanup] of actions) {
    await reset(page);
    // Direction controls need a real selected relationship, not a hidden input.
    await page.locator('button[data-topology-mode="relations"]').click();
    const {released, start} = await flick(page); assert.equal(released.inertia, "running", label + ": test begins with actual coast");
    await action(start); await staysStopped(page, label); if (cleanup) await cleanup();
  }
  await reset(page); const paused = await flick(page, {pause: 180});
  assert.equal(paused.released.inertia, "idle", "Holding still before release discards stale drag velocity"); await staysStopped(page, "Paused release");
  await reset(page); const canceled = await flick(page, {cancel: true});
  assert.equal(canceled.released.inertia, "idle", "pointercancel never starts a coast"); await staysStopped(page, "Canceled drag");
}
async function reduceMotion(page) {
  await reset(page); await flick(page);
  await page.emulateMedia({reducedMotion: "reduce"}); await settle(page);
  await staysStopped(page, "Live reduced-motion change");
  const before = await snapshot(page), reduced = await flick(page);
  assert.equal(reduced.released.inertia, "idle", "Reduced motion disables release inertia");
  const after = await staysStopped(page, "Reduced-motion drag");
  assert.notDeepEqual(camera(after), camera(before), "Reduced motion preserves direct manual rotation");
  assert.notDeepEqual(after.moon.paths, before.moon.paths, "Reduced motion does not freeze the moon's real orientation");
  await page.emulateMedia({reducedMotion: "no-preference"}); await reset(page);
}
async function caseRun(browser, engine, width, theme) {
  const context = await browser.newContext({viewport: {width, height: 1000}, deviceScaleFactor: width === 390 ? 3 : width === 320 ? 2 : 1,
    reducedMotion: "no-preference", ...(width < 768 ? {isMobile: true, hasTouch: true} : {})});
  try {
    await context.addInitScript(theme => {
      localStorage.setItem("server-kit-theme", theme);
      const raf = requestAnimationFrame.bind(window), caf = cancelAnimationFrame.bind(window);
      const state = window.__motionRAF = {pending: new Set(), executed: 0};
      window.requestAnimationFrame = callback => { let id; id = raf(time => { state.pending.delete(id); state.executed++; callback(time); }); state.pending.add(id); return id; };
      window.cancelAnimationFrame = id => { state.pending.delete(id); return caf(id); };
    }, theme);
    await context.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin !== base.origin) { report.external.push(url.href); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(new URL("login/", base).href); await page.locator('[name="username"]').fill("preview"); await page.locator('[name="password"]').fill("Preview-only-2026!");
    await Promise.all([page.waitForURL(new URL("overview/", base).href), page.locator('button[type="submit"]').click()]);
    await context.request.get(new URL("__preview__/scenario/rich/", base).href);
    await page.goto(new URL("network/topology/", base).href); await hook(page, "node").first().waitFor(); await settle(page);
    const requests = []; page.on("request", request => requests.push(request.method()));
    if (width < 768) await hook(page, "layout-edit").click();
    const decay = await boundedDecay(page); await discreteAndNodeMotion(page, width >= 768); await cancellationMatrix(page, width < 768); await reduceMotion(page);
    const curves = theme === "light" && width !== 320 ? await speedCurves(page,width >= 768) : null;
    await orbit(page,"right"); const discrete = await snapshot(page);
    await staysStopped(page, "Discrete keyboard rotation");
    assert(Number.isFinite(discrete.moon.yaw) && Number.isFinite(discrete.moon.pitch));
    await page.evaluate(() => document.activeElement?.blur());
    await page.locator(".topology-panel").screenshot({path: path.join(directory, `${engine}-${width}-${theme}-oriented.png`),
      style: ".skip-link:not(:focus) { visibility:hidden !important; }"});
    report.screenshots.push(`${engine}-${width}-${theme}-oriented.png`);
    await flick(page); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", {persisted: true})));
    await staysStopped(page, "Pagehide"); assert.equal((await snapshot(page)).raf.pending, 0);
    assert(requests.every(method => method === "GET"), "Motion inspection never writes management state");
    report.cases.push({engine, width, theme, decay,curves});
  } finally { await context.close(); }
}
(async () => {
  try {
    for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await engine.launch();
      try { for (const width of [1440, 390, 320]) for (const theme of ["light", "dark"]) await caseRun(browser, name, width, theme); }
      finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({...report, cases: report.cases.length, screenshots: report.screenshots.length}, null, 2)); }
})();
