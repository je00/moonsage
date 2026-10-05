"use strict";

const assert = require("node:assert/strict");

// Exercise supported keyboard controls; never retain hidden direction buttons
// or change private camera data just to set up a visual audit.
async function orbit(page, direction, count = 1) {
  assert(Number.isInteger(count) && count > 0);
  if (direction === "reset") {
    assert.equal(count, 1);
    await page.locator('[data-topology-orbit="reset"]').click();
  } else {
    const key = {left:"ArrowLeft", right:"ArrowRight", up:"ArrowUp", down:"ArrowDown"}[direction];
    assert(key, "A supported keyboard orbit direction is required");
    await page.locator("[data-topology-graph]").evaluate(graph => graph.focus({preventScroll:true}));
    for (let step = 0; step < count; step += 1) await page.keyboard.press(key);
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function measureOrbitStep(page) {
  await orbit(page, "reset");
  const yaw = () => page.locator("[data-topology-graph]").evaluate(graph => Number(graph.dataset.cameraYaw));
  const before = await yaw();
  await orbit(page, "right");
  const after = await yaw(), step = Math.atan2(Math.sin(after - before), Math.cos(after - before));
  assert(step > 0 && step < Math.PI / 2, "Keyboard orbit advances by a measurable bounded angle");
  await orbit(page, "reset");
  return step;
}

module.exports = {orbit, measureOrbitStep};
