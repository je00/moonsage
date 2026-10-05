"use strict";

const assert = require("node:assert/strict");
const compactScope = scope => scope === "全部协议 · 全部端口" ? "全协议 · 全端口" : scope.replaceAll(" · ", " ").replaceAll(", ", ",");

async function inlineSnapshot(page) {
  return page.locator("[data-topology-graph]").evaluate(graph => {
    const rect = node => { const box = node.getBoundingClientRect(); return {left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height}; };
    const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden" && !node.closest("[hidden]"));
    return {box: rect(graph), scale: Number(graph.dataset.viewportScale), floating: graph.querySelectorAll("[data-topology-edge-label], .topology-edge-label").length,
      nodes: [...graph.querySelectorAll("[data-topology-node]")].map(node => {
        const ports = node.querySelector("[data-topology-node-ports]"), marker = node.querySelector(".topology-node-selected"), peerMarker = node.querySelector(".topology-node-peer"), more = node.querySelector(".topology-node-ports-more"), rates = node.querySelector(".topology-node-rates");
        const name = node.querySelector("strong"), address = node.querySelector("[data-topology-node-address]"), heightWithBadge = node.offsetHeight;
        const badgeStates = [marker, peerMarker].filter(Boolean).map(badge => [badge, badge.hidden]);
        for (const [badge] of badgeStates) if (visible(badge)) badge.hidden = true;
        const heightWithoutBadge = node.offsetHeight;
        for (const [badge, hidden] of badgeStates) badge.hidden = hidden;
        return {id: node.dataset.topologyNode, shape: node.dataset.topologyShape, selected: node.getAttribute("aria-pressed") === "true", box: rect(node),
          localBox: {width: node.offsetWidth, height: node.offsetHeight}, aria: node.getAttribute("aria-label") || "",
          name: rect(node.querySelector("strong")), state: rect(node.querySelector(".topology-node-state")),
          marker: {visible: visible(marker), text: marker?.textContent, box: marker ? rect(marker) : null,
            clipped: marker ? marker.scrollWidth > marker.clientWidth + 1 : false},
          peerMarker: {exists: Boolean(peerMarker), visible: visible(peerMarker), text: peerMarker?.textContent || "", box: peerMarker ? rect(peerMarker) : null,
            clipped: peerMarker ? peerMarker.scrollWidth > peerMarker.clientWidth + 1 : false},
          heightWithBadge, heightWithoutBadge, nameFont: parseFloat(getComputedStyle(name).fontSize), nameEllipsis: getComputedStyle(name).textOverflow,
          nameText: name.textContent, title: node.title,
          address: {exists: Boolean(address), visible: visible(address), text: address?.textContent || "", box: address ? rect(address) : null,
            height: address?.offsetHeight || 0, clipped: address ? address.scrollWidth > address.clientWidth + 1 : false},
          rates: {exists: Boolean(rates), visible: visible(rates), text: rates?.textContent || "", box: rates ? rect(rates) : null,
            font: rates ? parseFloat(getComputedStyle(rates).fontSize) : null, clipped: rates ? rates.scrollWidth > rates.clientWidth + 1 : false},
          ports: {exists: Boolean(ports), visible: visible(ports), title: ports?.getAttribute("title") || "", box: ports ? rect(ports) : null,
            lines: [...node.querySelectorAll(".topology-node-port")].map(line => ({text: line.textContent, scope: line.dataset.topologyScope,
              title: line.getAttribute("title"), visible: visible(line), box: rect(line), font: parseFloat(getComputedStyle(line).fontSize),
              clipped: line.scrollWidth > line.clientWidth + 1, ellipsis: getComputedStyle(line).textOverflow})),
            more: {visible: visible(more), text: more?.textContent || "", box: more ? rect(more) : null}}};
      })};
  });
}

function geometryFindings(snapshot, fit = true) {
  const tolerance = snapshot.scale;
  const outside = (one, two) => one.left < two.left - tolerance || one.right > two.right + tolerance || one.top < two.top - tolerance || one.bottom > two.bottom + tolerance;
  const overlaps = (one, two) => Math.min(one.right, two.right) - Math.max(one.left, two.left) > tolerance && Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) > tolerance;
  const findings = [];
  for (const [index, node] of snapshot.nodes.entries()) {
    if (fit && outside(node.box, snapshot.box)) findings.push({kind: "card-outside-canvas", node: node.id});
    for (const [kind, box] of [["name", node.name], ["state", node.state]]) if (outside(box, node.box)) findings.push({kind: kind + "-outside-own-card", node: node.id});
    for (const other of snapshot.nodes.slice(index + 1)) if (overlaps(node.box, other.box)) findings.push({kind: "cards-overlap", nodes: [node.id, other.id]});
    // The single type-colored border is already included in the card box.
    // There is no external ring or shadow to inflate its painted geometry.
    const markers = [["current", node.marker], ["peer", node.peerMarker]].filter(([, marker]) => marker?.visible);
    if (markers.length > 1) findings.push({kind: "current-and-peer-both-visible", node: node.id});
    for (const [role, marker] of markers) {
      // The leaf role tab may overhang only the top edge by at most 6 local px.
      // The lunar hub keeps its existing strict internal badge geometry.
      const envelope = {...node.box, top: node.box.top - (node.id === "hub" || node.shape === "moon" ? 0 : 6 * snapshot.scale)};
      if (outside(marker.box, envelope)) findings.push({kind: role + "-outside-own-card", node: node.id});
      if (fit && outside(marker.box, snapshot.box)) findings.push({kind: role + "-outside-canvas", node: node.id});
      for (const [kind, box] of [["name", node.name], ["state", node.state]]) if (overlaps(marker.box, box)) findings.push({kind: role + "-covers-" + kind, node: node.id});
      for (const other of snapshot.nodes) {
        if (other.id === node.id) continue;
        if (overlaps(marker.box, other.box)) findings.push({kind: role + "-overlaps-neighbor-card", nodes: [node.id, other.id]});
        for (const otherMarker of [other.marker, other.peerMarker].filter(badge => badge?.visible)) {
          if (overlaps(marker.box, otherMarker.box)) findings.push({kind: role + "-overlaps-neighbor-badge", nodes: [node.id, other.id]});
        }
      }
    }
    if (node.rates.visible) {
      if (outside(node.rates.box, node.box)) findings.push({kind: "rates-outside-own-card", node: node.id});
      for (const [kind, box] of [["name", node.name], ["state", node.state], ...markers.map(([role, marker]) => [role, marker.box])]) {
        if (overlaps(node.rates.box, box)) findings.push({kind: "rates-cover-" + kind, node: node.id});
      }
      if (node.rates.clipped) findings.push({kind: "rates-clipped", node: node.id, text: node.rates.text});
    }
    if (node.address?.visible) {
      if (outside(node.address.box, node.box)) findings.push({kind: "address-outside-own-card", node: node.id});
      const fields = [["name", node.name], ...markers.map(([role, marker]) => [role, marker.box]),
        ...(node.id === "hub" ? [] : [["state", node.state], ["rates", node.rates.box]])];
      for (const [kind, box] of fields) if (box && overlaps(node.address.box, box)) findings.push({kind: "address-covers-" + kind, node: node.id});
      if (node.address.clipped) findings.push({kind: "address-clipped", node: node.id});
    }
    const items = node.ports.lines.filter(line => line.visible).map(line => ({kind: "scope", ...line}));
    if (node.ports.more.visible) items.push({kind: "more", ...node.ports.more});
    for (const [lineIndex, line] of items.entries()) {
      if (outside(line.box, node.box)) findings.push({kind: "port-outside-own-card", node: node.id, text: line.text});
      if (node.address?.visible && overlaps(line.box, node.address.box)) findings.push({kind: "port-covers-address", node: node.id});
      for (const [kind, box] of [["name", node.name], ["state", node.state], ...markers.map(([role, marker]) => [role, marker.box]), ...(node.rates.visible ? [["rates", node.rates.box]] : [])]) {
        if (overlaps(line.box, box)) findings.push({kind: "port-covers-" + kind, node: node.id, text: line.text});
      }
      for (const other of items.slice(lineIndex + 1)) if (overlaps(line.box, other.box)) findings.push({kind: "port-rows-overlap", node: node.id});
    }
  }
  return findings;
}

function assertCompactCards(snapshot) {
  assert.ok(Number.isFinite(snapshot.scale) && snapshot.scale > 0, "the canvas exposes a finite positive whole-graph scale");
  for (const node of snapshot.nodes) {
    const count = node.ports.lines.length, more = node.ports.more.visible;
    const extra = node.id === "hub" ? 0 : 16 + (node.address?.visible ? node.address.height + 2 : 0);
    const [minimum, maximum] = (more ? [92, 102] : count === 2 ? [78, 92] : count === 1 ? [64, 78] : [48, 60]).map(value => value + extra);
    assert.equal(node.rates.exists, node.id !== "hub", "only real nodes have a node ↔ VPS rate row, never a misleading hub sum");
    assert.equal(node.rates.visible, node.id !== "hub", "every real node retains its dedicated compact rate row");
    if (node.rates.visible) assert.ok(node.rates.font >= 11, "rates remain readable instead of shrinking to fit");
    if (node.shape === "moon") assert.ok(node.localBox.width >= 124 && node.localBox.height >= node.localBox.width,
      "The fixed central moon retains enough space for all inline permission rows");
    else assert.ok(node.localBox.height >= minimum && node.localBox.height <= maximum,
      `${node.id}: ${count} inline rows${more ? " plus extra count" : ""} use compact local content height (${node.localBox.height}px, expected ${minimum}–${maximum})`);
    for (const dimension of ["width", "height"]) assert.ok(Math.abs(node.box[dimension] - node.localBox[dimension] * snapshot.scale) <= .55 * snapshot.scale + .05,
      `${node.id}: rendered ${dimension} scales with the entire graph (${node.box[dimension]}px, local ${node.localBox[dimension]}px × ${snapshot.scale})`);
  }
}

async function assertCardEdges(page, shapeAware = true) {
  const endpoints = await page.locator("[data-topology-graph]").evaluate((graph, shapeAware) => {
    const scale = Number(graph.dataset.viewportScale);
    const cards = new Map([...graph.querySelectorAll("[data-topology-node]")].map(node => [node.dataset.topologyNode, node.getBoundingClientRect()]));
    const edges = [...graph.querySelectorAll("[data-topology-edge], [data-topology-spoke]")];
    return edges.flatMap(edge => {
      if (shapeAware && getComputedStyle(edge).visibility === "hidden") return [];
      const source = cards.get(edge.dataset.source), target = cards.get(edge.dataset.target);
      // User-created overlaps and the intentionally compressed 40-node stress
      // fixture cannot offer a visible endpoint between two intersecting cards.
      if (source.left < target.right + 20 * scale && source.right > target.left - 20 * scale && source.top < target.bottom + 20 * scale && source.bottom > target.top - 20 * scale) return [];
      const matrix = edge.getScreenCTM();
      return [["source", source, 0], ["target", target, edge.getTotalLength()]].map(([kind, box, length]) => {
        const point = edge.getPointAtLength(length).matrixTransform(matrix);
        const id = edge.dataset[kind], node = graph.querySelector(`[data-topology-node="${id}"]`);
        return {source: edge.dataset.source, target: edge.dataset.target, kind, scale,
          ellipse: shapeAware && node.dataset.topologyShape === "moon",
          ellipseRadius: Math.hypot((point.x - (box.left + box.right) / 2) / (box.width / 2 + 7 * scale),
            (point.y - (box.top + box.bottom) / 2) / (box.height / 2 + 7 * scale)),
          distance: Math.max(box.left - point.x, point.x - box.right, box.top - point.y, point.y - box.bottom)};
      });
    });
  }, shapeAware);
  for (const endpoint of endpoints) {
    if (endpoint.ellipse) assert.ok(Math.abs(endpoint.ellipseRadius - 1) < .035,
      `${endpoint.source}→${endpoint.target} ${endpoint.kind}: moon endpoint lies on its actual ellipse expanded by 7 local px (${endpoint.ellipseRadius})`);
    else assert.ok(endpoint.distance >= 5 * endpoint.scale && endpoint.distance <= 9 * endpoint.scale,
      `${endpoint.source}→${endpoint.target} ${endpoint.kind}: endpoint stays 7 local px outside the actual content-sized card (${endpoint.distance}px at ${endpoint.scale}×)`);
  }
}

async function assertMarkerGeometry(page, fit = true, shapeAware = true) {
  const arrows = await page.locator("[data-topology-graph]").evaluate((graph, shapeAware) => {
    const rect = element => { const box = element.getBoundingClientRect(); return {left: box.left, right: box.right, top: box.top, bottom: box.bottom}; };
    const graphBox = rect(graph), scale = Number(graph.dataset.viewportScale);
    return [...graph.querySelectorAll("[data-topology-edge], [data-topology-spoke]")].flatMap(edge => {
      if (Number(getComputedStyle(edge).opacity) === 0) return [];
      if (shapeAware && getComputedStyle(edge).visibility === "hidden") return [];
      return ["start", "end"].flatMap(end => {
        const ref = edge.getAttribute(`marker-${end}`), id = ref?.match(/#([^)]*)\)/)?.[1];
        if (!id) return [];
        const marker = document.getElementById(id), glyph = marker.querySelector("path"), length = edge.getTotalLength();
        const endpoint = edge.getPointAtLength(end === "start" ? 0 : length);
        const near = edge.getPointAtLength(end === "start" ? Math.min(.01, length) : Math.max(0, length - .01));
        let angle = end === "start" ? Math.atan2(near.y - endpoint.y, near.x - endpoint.x) : Math.atan2(endpoint.y - near.y, endpoint.x - near.x);
        if (end === "start" && marker.getAttribute("orient") === "auto-start-reverse") angle += Math.PI;
        const refX = Number(marker.getAttribute("refX")), refY = Number(marker.getAttribute("refY"));
        const markerScale = Number(marker.getAttribute("markerWidth")) / marker.viewBox.baseVal.width;
        const matrix = edge.getScreenCTM();
        const vertices = [[1, 1], [8, 5], [1, 9]].map(([x, y]) => {
          const dx = (x - refX) * markerScale, dy = (y - refY) * markerScale;
          return new DOMPoint(endpoint.x + dx * Math.cos(angle) - dy * Math.sin(angle), endpoint.y + dx * Math.sin(angle) + dy * Math.cos(angle)).matrixTransform(matrix);
        });
        const stroke = parseFloat(getComputedStyle(glyph).strokeWidth) / 2 * scale * markerScale;
        const nodeId = end === "start" ? edge.dataset.source : edge.dataset.target;
        const node = graph.querySelector(`[data-topology-node="${nodeId}"]`), box = rect(node);
        const tip = vertices[1], tail = {x: (vertices[0].x + vertices[2].x) / 2, y: (vertices[0].y + vertices[2].y) / 2};
        const towardNode = (tip.x - tail.x) * ((box.left + box.right) / 2 - tip.x) + (tip.y - tail.y) * ((box.top + box.bottom) / 2 - tip.y);
        const bounds = {left: Math.min(...vertices.map(point => point.x)) - stroke, right: Math.max(...vertices.map(point => point.x)) + stroke,
          top: Math.min(...vertices.map(point => point.y)) - stroke, bottom: Math.max(...vertices.map(point => point.y)) + stroke};
        const ellipse = shapeAware && node.dataset.topologyShape === "moon";
        const normalized = vertices.map(point => ({x: (point.x - (box.left + box.right) / 2) / ((box.right - box.left) / 2 + stroke),
          y: (point.y - (box.top + box.bottom) / 2) / ((box.bottom - box.top) / 2 + stroke)}));
        const outsideEllipse = normalized.slice(0, -1).every((a, i) => {
          const b = normalized[i + 1], dx = b.x - a.x, dy = b.y - a.y;
          const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy)));
          return Math.hypot(a.x + t * dx, a.y + t * dy) >= 1;
        });
        // Test the actual V strokes, not their rectangular bounding box, against
        // the terminal card's rounded role tab. Cross-node occlusion is allowed
        // by depth, but a card must not obscure its own access arrow with a tab.
        const badgeCollisions = [...node.querySelectorAll(".topology-node-selected, .topology-node-peer")].flatMap(badge => {
          const style = getComputedStyle(badge);
          if (badge.hidden || style.display === "none" || style.visibility === "hidden") return [];
          const badgeBox = rect(badge), radius = Math.min(parseFloat(style.borderTopLeftRadius) * scale || 0,
            (badgeBox.right - badgeBox.left) / 2, (badgeBox.bottom - badgeBox.top) / 2);
          for (let i = 0; i < vertices.length - 1; i += 1) {
            const a = vertices[i], b = vertices[i + 1], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / .2));
            for (let step = 0; step <= steps; step += 1) {
              const point = {x: a.x + (b.x - a.x) * step / steps, y: a.y + (b.y - a.y) * step / steps};
              const coreX = Math.max(badgeBox.left + radius, Math.min(badgeBox.right - radius, point.x));
              const coreY = Math.max(badgeBox.top + radius, Math.min(badgeBox.bottom - radius, point.y));
              if (Math.hypot(point.x - coreX, point.y - coreY) <= radius + stroke) {
                return [{role: badge.textContent, point, badgeBox, stroke}];
              }
            }
          }
          return [];
        });
        return [{nodeId, id, end, scale, graphBox, bounds, towardNode, badgeCollisions, glyph: glyph.getAttribute("d"),
          matrixScale: Math.hypot(matrix.a, matrix.b), markerScale,
          outsideNode: ellipse ? outsideEllipse : bounds.right <= box.left || bounds.left >= box.right || bounds.bottom <= box.top || bounds.top >= box.bottom}];
      });
    });
  }, shapeAware);
  for (const arrow of arrows) {
    assert.equal(arrow.glyph, "M 1 1 L 8 5 L 1 9", "the geometry audit covers the complete actual arrow glyph including its stroke");
    assert.equal(arrow.markerScale, 1, "marker viewport never counteracts whole-graph zoom");
    assert.ok(Math.abs(arrow.matrixScale - arrow.scale) < .001, "the arrow's full geometry follows the graph's screen scale");
    assert.ok(arrow.towardNode > 0, `${arrow.nodeId}: the rendered arrowhead points toward its terminal card, not back toward the route origin`);
    assert.ok(arrow.outsideNode, `${arrow.nodeId}: terminal arrow remains outside the card and its single colored border`);
    assert.deepEqual(arrow.badgeCollisions, [], `${arrow.nodeId}: its own role tab cannot obscure a terminal arrow (${arrow.end})`);
    if (fit) assert.ok(arrow.bounds.left >= arrow.graphBox.left && arrow.bounds.right <= arrow.graphBox.right
      && arrow.bounds.top >= arrow.graphBox.top && arrow.bounds.bottom <= arrow.graphBox.bottom,
      `${arrow.nodeId}: fitting the graph keeps the entire terminal arrow inside the canvas`);
  }
}

async function assertInlinePorts(page, links, selectedId, direction, overview = false) {
  const snapshot = await inlineSnapshot(page);
  assertCompactCards(snapshot);
  return assertInlinePortContents(snapshot, links, selectedId, direction, overview);
}

// Compact leaves and the spacious central moon share exactly the same
// permission/access semantics; shape must never discard a port or role.
function assertInlinePortContents(snapshot, links, selectedId, direction, overview = false) {
  assert.equal(snapshot.floating, 0, "SVG floating port labels are completely removed");
  const selectedMarkers = snapshot.nodes.filter(node => node.marker.visible);
  assert.deepEqual(selectedMarkers.map(node => node.id), overview ? [] : [selectedId], "only the selected relation node displays the current marker");
  if (!overview) assert.equal(selectedMarkers[0].marker.text, "当前");
  const expected = overview ? [] : links.filter(link => direction === "forward" ? link.source === selectedId : link.target === selectedId);
  for (const node of snapshot.nodes) {
    const link = expected.find(link => (direction === "forward" ? link.target : link.source) === node.id);
    const scopes = link?.scopes || [];
    assert.ok(node.peerMarker.exists, "each node has one direction-aware peer marker");
    assert.equal(node.peerMarker.visible, Boolean(link), "only confirmed peers display a role marker; overview/current/unknown/disabled/unrelated do not");
    assert.equal(node.peerMarker.text, link ? direction === "forward" ? "目标" : "来源" : "", "peer role text follows direction and is cleared on every non-peer");
    assert.ok(!(node.marker.visible && node.peerMarker.visible), "current and counterpart roles are mutually exclusive");
    assert.equal(node.marker.clipped, false, "the current badge is not truncated");
    assert.equal(node.peerMarker.clipped, false, "the two-character counterpart badge is not truncated");
    assert.equal(node.heightWithBadge, node.heightWithoutBadge, "role badges never increase card height");
    assert.ok(node.nameFont >= 13 && node.nameEllipsis === "ellipsis", "badges cannot be paid for by shrinking name text or wrapping cards taller");
    assert.ok(node.aria.includes(node.nameText) && node.title.includes(node.nameText), "the complete name remains available when the compact header is truncated");
    assert.ok(node.ports.exists, "each card has its inline port container");
    assert.deepEqual(node.ports.lines.map(line => line.scope), scopes.slice(0, 2), "card scopes preserve every directed authorization, including leaf-to-leaf access without a path, with no stale ports");
    assert.deepEqual(node.ports.lines.map(line => line.text), scopes.slice(0, 2).map(compactScope), "the visible compact scope never changes its protocol or port values");
    assert.equal(node.ports.lines.every(line => line.visible), true);
    assert.equal(node.ports.visible, scopes.length > 0, "overview, selected, unknown, and unrelated cards have no visible port block");
    if (!scopes.length) assert.equal(node.ports.title, "", "unrelated cards retain no stale permission tooltip");
    for (const line of node.ports.lines) {
      assert.equal(line.title, line.scope, "each displayed scope keeps its full text in the title");
      if (line.clipped) assert.equal(line.ellipsis, "ellipsis", "long scope overflow uses visual ellipsis, not lost DOM text");
      if (line.text.length <= 14) assert.equal(line.clipped, false, "common short protocol/port scopes are completely visible");
    }
    for (const scope of scopes) {
      assert.ok(node.aria.includes(scope), "button accessibility text includes every full scope, including extra rows");
      assert.ok(node.ports.title.includes(scope), "port block tooltip includes every full scope");
    }
    if (scopes.length) assert.ok(node.ports.title.includes(direction === "forward" ? "当前节点可访问此节点" : "此节点可访问当前节点"), "port tooltip identifies the correct access direction");
    assert.equal(node.ports.more.visible, scopes.length > 2, "an overflow count appears only when more than two scopes exist");
    if (scopes.length > 2) assert.match(node.ports.more.text, new RegExp(`另\\s*${scopes.length - 2}\\s*项.*见详情`));
  }
  return snapshot;
}

module.exports = {assertCardEdges, assertCompactCards, assertInlinePorts, assertInlinePortContents, assertMarkerGeometry, compactScope, geometryFindings, inlineSnapshot};
