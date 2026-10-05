"use strict";

const assert = require("node:assert/strict");

async function fixedView(page) {
  return page.locator("[data-topology-graph]").evaluate(graph => {
    const hub = graph.querySelector('[data-topology-node="hub"]'), box = graph.getBoundingClientRect(), moon = hub.getBoundingClientRect();
    const skyInset = Number(graph.dataset.skyInset || 0);
    const center = [moon.left + moon.width / 2 - box.left - graph.clientLeft,
      moon.top + moon.height / 2 - box.top - graph.clientTop];
    return {projection: graph.dataset.projection, scale: Number(graph.dataset.viewportScale),
      camera: [Number(graph.dataset.cameraYaw), Number(graph.dataset.cameraPitch)],
      skyInset, height: graph.clientHeight, exits: graph.parentElement.querySelectorAll("[data-topology-galaxy]").length,
      center, pivot: [Number(graph.dataset.viewportX), Number(graph.dataset.viewportY)],
      offset: [center[0] - graph.clientWidth / 2, center[1] - (graph.clientHeight + skyInset) / 2],
      xyz: ["spaceX", "spaceY", "spaceZ"].map(key => Number(hub.dataset[key]))};
  });
}
async function assertFixedCenter(page) {
  const view = await fixedView(page);
  assert.equal(view.projection, "3d", "Only the genuine 3D projection remains");
  assert.equal(view.scale, 1, "All graph interactions preserve the native 1:1 scale");
  assert(Number.isFinite(view.skyInset) && view.skyInset >= 0 && view.skyInset < view.height,
    "Sky reserve is finite, nonnegative, and smaller than the complete canvas");
  if (!view.exits) assert.equal(view.skyInset, 0, "No exits leave no inherited sky reserve");
  assert(view.offset.every(value => Math.abs(value) < 1.1),
    `VPS stays horizontally centered and at the internal scene center below the one-sided sky reserve (${view.offset})`);
  assert(view.center.every((value, axis) => Math.abs(value - view.pivot[axis]) < 1.1),
    "The rendered VPS, not only viewport metadata, is the immutable rotation pivot");
  assert.deepEqual(view.xyz, [0, 0, 0], "VPS is the immutable world-space origin");
  return view;
}
async function assertFixedControls(page) {
  assert.equal(await page.locator("[data-topology-projection], [data-topology-zoom], [data-topology-zoom-in], [data-topology-zoom-out], [data-topology-zoom-reset], [data-topology-fit]").count(), 0,
    "Removed plane/zoom/fit controls are absent, not merely hidden");
  assert.equal(await page.locator('[data-topology-orbit="left"], [data-topology-orbit="right"], [data-topology-orbit="up"], [data-topology-orbit="down"]').count(), 0,
    "Removed direction arrows are absent from the DOM, never hidden test-only controls");
  assert.equal(await page.locator('[data-topology-orbit="reset"]').count(), 1, "A single view-reset action remains available");
  assert.equal(await page.locator('[data-topology-rotate-pad]').count(), 0, "The removed rotation pad is absent; gestures act on the canvas itself");
  const reset = page.locator("[data-topology-reset]");
  assert.equal(await reset.count(), 1);
  assert(await reset.isVisible(), "Auto-arrange is immediately available in the header");
  assert.equal(await reset.evaluate(el => Boolean(el.closest("details"))), false, "Auto-arrange never hides in a disclosure");
  await assertFixedCenter(page);
}

async function assertDepthOcclusion(page, capture) {
  const graph = page.locator("[data-topology-graph]");
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const checkRanks = () => graph.evaluate(graph => [...graph.querySelectorAll("[data-topology-node]")].map(node => ({
    id: node.dataset.topologyNode, depth: Number(node.dataset.cameraDepth), z: Number(getComputedStyle(node).zIndex),
    rank: Number(getComputedStyle(node).getPropertyValue("--topology-depth-index"))})));
  const checkHit = async (id, near, label) => {
    const nodes = await checkRanks();
    for (const node of nodes) {
      assert.equal(node.z, 20 + node.rank, label + ": no status-specific stacking override");
      for (const other of nodes) if (node.depth > other.depth + .000001) assert(node.z > other.z, label + ": depth is monotonic");
    }
    const hit = await graph.evaluate(graph => { const hub = graph.querySelector('[data-topology-node="hub"]'), box = hub.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("[data-topology-node]")?.dataset.topologyNode; });
    assert.equal(hit, near ? id : "hub", label + ": actual hit testing follows the visible near surface");
    await assertFixedCenter(page);
  };
  for (const near of [true, false]) {
    await page.locator("[data-topology-reset]").click(); await settle();
    const nodes = await checkRanks(), candidate = nodes.filter(node => node.id !== "hub" && (near ? node.depth > .01 : node.depth < -.01))
      .sort((a, b) => near ? b.depth - a.depth : a.depth - b.depth)[0];
    assert(candidate, "The fixture includes real leaves on both sides of the central VPS");
    const id = candidate.id, node = page.locator(`[data-topology-node="${id}"]`);
    await page.locator("[data-topology-select]").selectOption(id);
    await page.waitForFunction(id => document.querySelector('[data-topology-node][aria-pressed="true"]')?.dataset.topologyNode === id, id);
    await page.locator('[data-topology-node="hub"]').scrollIntoViewIfNeeded(); await settle();
    await node.evaluate(node => {
      const graph = node.closest("[data-topology-graph]"), box = node.getBoundingClientRect(), moon = graph.querySelector('[data-topology-node="hub"]').getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      node.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, pointerId:804, pointerType:"mouse", button:0, buttons:1, clientX:x, clientY:y}));
      graph.dispatchEvent(new PointerEvent("pointermove", {bubbles:true, cancelable:true, pointerId:804, pointerType:"mouse", buttons:1,
        clientX:moon.left + moon.width / 2, clientY:moon.top + moon.height / 2}));
    });
    await settle(); assert(await node.evaluate(node => node.classList.contains("is-dragging")));
    await checkHit(id, near, "Selected leaf during drag");
    await graph.dispatchEvent("pointerup", {pointerId:804, pointerType:"mouse", button:0}); await settle();
    await checkHit(id, near, "Selected leaf after release");
    if (capture) await capture(near ? "foreground-leaf-over-moon" : "moon-over-background-leaf");
    await page.keyboard.press("Tab"); await node.focus(); await checkHit(id, near, "Keyboard-focused leaf");
    await page.locator("[data-topology-select]").selectOption("hub");
    await page.waitForFunction(() => document.querySelector('[data-topology-node="hub"]').getAttribute("aria-pressed") === "true");
    await page.locator('[data-topology-node="hub"]').scrollIntoViewIfNeeded(); await settle();
    await checkHit(id, near, "Selected VPS and permission-styled leaf");
  }
  await page.locator("[data-topology-reset]").click(); await settle();
}

module.exports = {assertFixedCenter, assertFixedControls, fixedView, assertDepthOcclusion};
