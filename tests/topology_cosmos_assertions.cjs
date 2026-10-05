"use strict";

const assert = require("node:assert/strict");
const {PNG} = require("pngjs");
const rgba = value => {
  const channels = value.match(/[\d.]+/g).map(Number);
  return [...channels.slice(0, 3).map(number => value.startsWith("color(srgb ") ? number * 255 : number), channels[3] ?? 1];
};
const blend = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3]));
const luminance = rgb => rgb.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; })
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
const contrast = (first, second) => (Math.max(luminance(first), luminance(second)) + .05) / (Math.min(luminance(first), luminance(second)) + .05);

async function auditCosmos(page, expectedIds, requireContrast = true, {normalMoonRim = false} = {}) {
  const graph = page.locator("[data-topology-graph]");
  const facts = await graph.evaluate(graph => {
    const rect = element => { const box = element.getBoundingClientRect(), canvas = graph.getBoundingClientRect(); return {x: box.left - canvas.left, y: box.top - canvas.top, width: box.width, height: box.height}; };
    const opacity = element => { let alpha = 1; for (let el = element; el; el = el.parentElement) alpha *= Number(getComputedStyle(el).opacity); return alpha; };
    const forbidden = element => { const css = getComputedStyle(element); return {transform: css.transform, filter: css.filter, backdrop: css.backdropFilter, perspective: css.perspective, willChange: css.willChange}; };
    const visible = element => !!element.getClientRects().length && getComputedStyle(element).visibility !== "hidden" && !element.closest("[hidden]");
    const cosmos = graph.querySelector(".topology-cosmos"), scene = cosmos?.querySelector("svg.topology-cosmos-scene");
    const nodes = [...graph.querySelectorAll("[data-topology-node]")];
    const decorations = [...(cosmos ? [cosmos, ...cosmos.querySelectorAll("*")] : []),
      ...nodes.flatMap(node => [...node.querySelectorAll(".topology-moon-disc, .topology-moon-disc *")])];
    const inspector = document.querySelector("[data-topology-inspector]");
    return {ids: nodes.map(node => node.dataset.topologyNode), width: graph.getBoundingClientRect().width, height: graph.getBoundingClientRect().height, scale: Number(graph.dataset.viewportScale),
      rootProjection: document.querySelector("[data-topology-root]").dataset.projection, projection: graph.dataset.projection,
      canvas: forbidden(graph), world: forbidden(graph.querySelector("[data-topology-world]")),
      cosmosCount: graph.querySelectorAll(".topology-cosmos").length, hidden: cosmos?.getAttribute("aria-hidden"), viewBox: scene?.getAttribute("viewBox"),
      fakeSemantics: cosmos?.querySelectorAll("[data-topology-node], [data-topology-edge], [data-topology-spoke], marker, button, a, input, [tabindex], [role=button]").length,
      oldGuides: graph.querySelectorAll(".topology-orbit-guide").length,
      decorations: decorations.map(el => ({tag: el.tagName, pointerEvents: getComputedStyle(el).pointerEvents, animation: getComputedStyle(el).animationName, ...forbidden(el)})),
      ongoingAnimations: document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity).length,
      inspector: inspector && visible(inspector) ? {top: inspector.getBoundingClientRect().top, graphBottom: graph.getBoundingClientRect().bottom} : null,
      moons: nodes.flatMap(node => [...node.querySelectorAll(".topology-moon-disc")].map(disc => ({id: node.dataset.topologyNode, hidden: disc.getAttribute("aria-hidden"), pointerEvents: getComputedStyle(disc).pointerEvents, box: rect(disc)}))),
      nodes: nodes.map(node => {
        const css = getComputedStyle(node);
        return {id: node.dataset.topologyNode, shape: node.dataset.topologyShape, peer: node.classList.contains("is-peer"), selected: !!node.querySelector(".topology-node-selected:not([hidden])"),
          width: parseFloat(css.borderTopWidth), border: css.borderTopColor, bg: css.backgroundColor, image: css.backgroundImage, box: rect(node), z: Number(css.zIndex),
          depth: Number(node.dataset.cameraDepth), rank: Number(css.getPropertyValue("--topology-depth-index")), radius: parseFloat(css.borderTopLeftRadius),
          shadow: css.boxShadow, opacity: opacity(node), ...forbidden(node),
          text: [...node.querySelectorAll("strong, .topology-node-state, .topology-node-activity, .topology-node-port, .topology-node-ports-more, .topology-node-rates, .topology-node-peer, .topology-node-selected")]
            .filter(el => visible(el) && el.textContent.trim()).map(el => ({kind: el.className || el.tagName, color: getComputedStyle(el).color,
              opacity: opacity(el), bg: getComputedStyle(el).backgroundColor, box: rect(el)}))};
      }),
      edges: [...graph.querySelectorAll("[data-topology-edge], [data-topology-spoke]")].filter(visible).map(edge => {
        const css = getComputedStyle(edge), matrix = edge.getScreenCTM(), box = graph.getBoundingClientRect(), length = edge.getTotalLength();
        return {kind: edge.hasAttribute("data-topology-edge") ? "permission" : edge.classList.contains("is-route") ? "route" : "structure",
          source: edge.dataset.source, target: edge.dataset.target, color: css.stroke, opacity: opacity(edge),
          points: [.2, .4, .6, .8].map(t => { const p = edge.getPointAtLength(length * t).matrixTransform(matrix); return {x: p.x - box.left, y: p.y - box.top}; })};
      }).filter(edge => edge.opacity > 0)};
  });
  assert.deepEqual(facts.ids.slice().sort(), expectedIds.slice().sort(), "The moon and all cards are exactly the real backend nodes; no decorative fake nodes");
  assert.equal(facts.projection, "3d"); assert.equal(facts.rootProjection, "3d");
  assert.equal(facts.cosmosCount, 1); assert.equal(facts.hidden, "true"); assert.equal(facts.viewBox, "0 0 1000 700");
  assert.equal(facts.fakeSemantics, 0); assert.equal(facts.oldGuides, 0, "The old orbital cage is removed rather than layered under the scene");
  assert.equal(facts.ongoingAnimations, 0, "The normal-motion preference still has no perpetual animation");
  for (const layer of [facts.canvas, facts.world, ...facts.nodes, ...facts.decorations]) {
    assert(!layer.transform.startsWith("matrix3d")); assert.equal(layer.filter, "none"); assert.equal(layer.backdrop, "none");
    assert.equal(layer.perspective, "none"); assert.equal(layer.willChange, "auto");
  }
  for (const element of facts.decorations) { assert.equal(element.pointerEvents, "none"); assert.equal(element.animation, "none"); }
  assert.equal(facts.moons.length, 1); assert.equal(facts.moons[0].id, "hub"); assert.equal(facts.moons[0].hidden, "true");
  assert.equal(facts.moons[0].pointerEvents, "none");
  assert(facts.moons[0].box.width > 0 && facts.moons[0].box.height > 0, "A visible moon belongs inside the real VPS node");
  if (facts.inspector) assert(facts.inspector.top >= facts.inspector.graphBottom - 1, "The spatial canvas has full width; details sit underneath");
  for (const target of facts.nodes.filter(node => node.peer)) {
    assert.equal(target.width, 2, "The target retains one precise frame instead of concentric neon rings");
    assert.doesNotMatch(target.shadow, /0px 0px 0px [24]px/);
  }
  for (const node of facts.nodes) {
    assert.equal(node.z, 20 + node.rank, "Selection, targets, focus, and the VPS share the actual depth ordering");
    for (const other of facts.nodes) if (node.depth > other.depth + .000001)
      assert(node.z > other.z, "Near nodes paint above far nodes, including the central moon");
  }
  if (!requireContrast) return facts;
  // Obtain actual gradients/stars/reflections beneath the graph. No source or
  // image is edited: browser capture temporarily hides the real scene layer.
  // Whole-element captures of the tall dense graph stitch across viewports.
  // Fixed app navigation/sticky sibling controls must not be mistaken for
  // the canvas's pixels at their incidental capture-time scroll position.
  const canvasOnly = ".mobile-nav, .topology-touch-controls, .skip-link:not(:focus) { visibility:hidden !important; }";
  const box = await graph.evaluate(graph => { const b = graph.getBoundingClientRect(); return {x:b.left + scrollX,y:b.top + scrollY,width:b.width,height:b.height}; });
  // Locator screenshots round fractional clip edges outwards. Scaling their
  // enlarged bitmap back onto the unrounded element silently shifts pixels
  // in tall mobile graphs. Use an explicit integer clip and retain its offset.
  const clip = {x:Math.floor(box.x),y:Math.floor(box.y),width:Math.ceil(box.x + box.width) - Math.floor(box.x),height:Math.ceil(box.y + box.height) - Math.floor(box.y)};
  const offset = {x:box.x - clip.x,y:box.y - clip.y};
  const background = PNG.sync.read(await page.screenshot({fullPage:true,clip,style: "[data-topology-world] { visibility: hidden !important; } " + canvasOnly}));
  const colorsOnly = PNG.sync.read(await page.screenshot({fullPage:true,clip,style: "[data-topology-node] strong, [data-topology-node] .topology-node-state, [data-topology-node] .topology-node-activity, [data-topology-node] .topology-node-port, [data-topology-node] .topology-node-ports-more, [data-topology-node] .topology-node-rates, [data-topology-node] .topology-node-peer, [data-topology-node] .topology-node-selected { color: transparent !important; text-shadow:none !important; } " + canvasOnly}));
  const pixel = (png, point) => {
    const x = Math.max(0, Math.min(png.width - 1, Math.round((point.x + offset.x) * png.width / clip.width))), y = Math.max(0, Math.min(png.height - 1, Math.round((point.y + offset.y) * png.height / clip.height)));
    return [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  };
  const ratioFor = (color, alpha, bg) => { const fg = rgba(color); fg[3] *= alpha; return contrast(blend(fg, bg), bg); };
  const ratios = {text: [], frames: [], moonSilhouette: [], normalMoonRim: [], routes: [], structure: []};
  // A physically nearer opaque card can cover a distant label. Its pixels
  // are not that label's background. Audit every visible sample, and report
  // covered samples explicitly instead of measuring the occluder's border.
  const occludedSamples = {text: 0, frames: 0, routes: 0, nativeHitText: 0};
  const nativeHitOcclusions = [];
  const contains = (node, point) => {
    const b = node.box, x = point.x - b.x, y = point.y - b.y;
    if (x < 0 || y < 0 || x > b.width || y > b.height) return false;
    if (node.shape === "moon") return ((x - b.width / 2) / (b.width / 2)) ** 2 + ((y - b.height / 2) / (b.height / 2)) ** 2 <= 1;
    const r = Math.min(node.radius, b.width / 2, b.height / 2), dx = Math.max(r - x, 0, x - b.width + r), dy = Math.max(r - y, 0, y - b.height + r);
    return dx * dx + dy * dy <= r * r;
  };
  const covered = (point, node) => facts.nodes.some(other => other.id !== node?.id && (!node || other.z > node.z) && contains(other, point));
  const paintOwner = (point, node) => {
    const px = Math.round((point.x + offset.x) * colorsOnly.width / clip.width), py = Math.round((point.y + offset.y) * colorsOnly.height / clip.height);
    // The bitmap value represents a whole physical pixel. At a fractional
    // card edge its footprint can include a near border even if its nominal
    // CSS center is just outside. Inspect that exact footprint, not a margin.
    const footprint = [point, ...[.001, .5, .999].flatMap(x => [.001, .5, .999].map(y =>
      ({x:(px + x) * clip.width / colorsOnly.width - offset.x, y:(py + y) * clip.height / colorsOnly.height - offset.y})))];
    return graph.evaluate(async (graph, {footprint, node}) => {
      const previous = {x:scrollX,y:scrollY}, top = graph.getBoundingClientRect().top + scrollY;
      try {
        scrollTo(0, top + footprint[0].y - innerHeight / 2);
        await new Promise(resolve => requestAnimationFrame(resolve)); const box = graph.getBoundingClientRect();
        const hits = footprint.map(point => {
          const hit = document.elementFromPoint(box.left + point.x, box.top + point.y), owner = hit?.closest("[data-topology-node]");
          const css = owner && getComputedStyle(owner);
          return {owner:owner?.dataset.topologyNode,z:css ? Number(css.zIndex) : null,
            rank:css ? Number(css.getPropertyValue("--topology-depth-index")) : null,hit:hit?.getAttribute("class"),at:point};
        });
        return hits.find(hit => hit.owner && hit.owner !== node.id && hit.z > node.z) || hits[0];
      } finally {
        scrollTo(previous.x, previous.y); await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }, {footprint,node:{id:node.id,z:node.z}});
  };
  for (const node of facts.nodes) {
    for (const text of node.text) {
      const points = [.2, .5, .8].flatMap(x => [.25, .5, .75].map(y => ({x: text.box.x + text.box.width * x, y: text.box.y + text.box.height * y})));
      const visible = points.filter(point => { if (!covered(point, node)) return true; occludedSamples.text++; return false; });
      if (!visible.length) continue;
      const samples = [];
      for (const point of visible) {
        const bg = pixel(colorsOnly, point), ratio = ratioFor(text.color, text.opacity, bg);
        let owner;
        if (ratio < 4.5) {
          // Native rounded-edge hit regions include fractional painted border
          // pixels beyond the ideal radius equation. Resolve those pixels with
          // the browser's actual top layer, never by inflating a rectangle.
          owner = await paintOwner(point, node);
          if (owner.owner && owner.owner !== node.id && owner.z > node.z) {
            occludedSamples.text++; occludedSamples.nativeHitText++;
            nativeHitOcclusions.push({node:node.id,kind:text.kind,sample:point,pixel:bg,foreground:owner}); continue;
          }
        }
        samples.push({point, bg, ratio, owner});
      }
      if (!samples.length) continue;
      const worst = samples.sort((a, b) => a.ratio - b.ratio)[0], value = worst.ratio; ratios.text.push(value);
      assert(value >= 4.5, `${node.id}/${text.kind}: text remains readable over its actual painted background (${value.toFixed(2)}; rgb(${worst.bg}); ${JSON.stringify(worst.owner)})`);
    }
    if (normalMoonRim && node.shape === "moon" && !node.peer && !node.selected) {
      // The ordinary bright moon needs a visible outside contour on the
      // light sky, independently of the stronger authorization-state frame.
      // Sample the real painted exterior, including its restrained shadow.
      for (const point of [{x:node.box.x + node.box.width / 2,y:node.box.y - 2},
        {x:node.box.x - 2,y:node.box.y + node.box.height / 2},
        {x:node.box.x + node.box.width + 2,y:node.box.y + node.box.height / 2},
        {x:node.box.x + node.box.width / 2,y:node.box.y + node.box.height + 2}]) {
        if (covered(point,node)) { occludedSamples.frames++; continue; }
        const value=ratioFor(node.border,node.opacity,pixel(colorsOnly,point));
        ratios.normalMoonRim.push(value);
        assert(value>=3,`${node.id}: ordinary lunar rim remains distinct against the actual exterior (${value.toFixed(2)})`);
      }
    }
    if (node.peer || node.selected) {
      // Stay inside the frame but before the 10px content column; a type dot
      // is foreground information, not the surface behind the target border.
      const inset = 6 * facts.scale;
      const points = [[{x: node.box.x + node.box.width / 2, y: node.box.y - 2}, {x: node.box.x + node.box.width / 2, y: node.box.y + inset}],
        [{x: node.box.x - 2, y: node.box.y + node.box.height / 2}, {x: node.box.x + inset, y: node.box.y + node.box.height / 2}],
        [{x: node.box.x + node.box.width + 2, y: node.box.y + node.box.height / 2}, {x: node.box.x + node.box.width - inset, y: node.box.y + node.box.height / 2}],
        [{x: node.box.x + node.box.width / 2, y: node.box.y + node.box.height + 2}, {x: node.box.x + node.box.width / 2, y: node.box.y + node.box.height - inset}]];
      for (const [outer, inner] of points) {
        if (covered(inner, node) || covered(outer, node)) { occludedSamples.frames++; continue; }
        const inside = pixel(colorsOnly, inner), outside = pixel(facts.nodes.some(other => other.id !== node.id && contains(other, outer)) ? colorsOnly : background, outer);
        const innerValue = ratioFor(node.border, node.opacity, inside); ratios.frames.push(innerValue);
        assert(innerValue >= 3, `${node.id}: single frame contrasts against its actual card/moon surface (${innerValue.toFixed(2)})`);
        if (node.shape === "moon") {
          // The bright moon disc itself supplies the exterior silhouette;
          // its dark target frame is on that disc, not a second glowing ring.
          // On the light sea the dark frame supplies the outside contour;
          // on the dark sea the bright disc supplies it. Either must remain
          // >=3, while the internal frame-to-disc requirement above is fixed.
          const silhouette = Math.max(contrast(inside, outside), ratioFor(node.border, node.opacity, outside));
          ratios.moonSilhouette.push(silhouette);
          assert(silhouette >= 3, `The real moon silhouette remains distinct from the sky/sea (${silhouette.toFixed(2)})`);
        } else {
          const value = ratioFor(node.border, node.opacity, outside); ratios.frames.push(value);
          assert(value >= 3, `${node.id}: target/current frame contrasts against the actual sky or sea (${value.toFixed(2)})`);
        }
      }
    }
  }
  for (const edge of facts.edges) for (const point of edge.points) {
    if (point.x < 0 || point.x > facts.width || point.y < 0 || point.y > facts.height) continue;
    if (covered(point)) { occludedSamples.routes++; continue; }
    const backdrop = pixel(background, point), value = ratioFor(edge.color, edge.opacity, backdrop);
    if (edge.kind === "structure") ratios.structure.push(value);
    else { ratios.routes.push(value); assert(value >= 3, `${edge.kind} ${edge.source}>${edge.target}: permission path contrasts against the actual background (${value.toFixed(2)}; ${edge.color} at opacity ${edge.opacity}, backdrop rgb(${backdrop.join(",")}) at ${point.x.toFixed(1)},${point.y.toFixed(1)})`); }
  }
  return {...facts, capture:{clip,offset,pixels:{width:colorsOnly.width,height:colorsOnly.height}}, occludedSamples, nativeHitOcclusions,
    contrast: Object.fromEntries(Object.entries(ratios).map(([key, values]) => [key, values.length ? Math.min(...values) : null]))};
}

module.exports = {auditCosmos};
