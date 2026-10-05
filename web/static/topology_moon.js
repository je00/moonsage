(() => {
  "use strict";

  const svgNS = "http://www.w3.org/2000/svg";
  const tau = Math.PI * 2;
  const defaultYaw = -.36, defaultPitch = -.22;
  const discRadius = 49;

  function orientation(value, fallback) {
    if (!Number.isFinite(value)) return fallback;
    const wrapped = ((value + Math.PI) % tau + tau) % tau - Math.PI;
    // Canonical angles make a full turn deterministic, including the cache.
    return Math.round(wrapped * 1e12) / 1e12;
  }
  function rotate(point, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x = cy * point.x + sy * point.z, z = -sy * point.x + cy * point.z;
    return {x, y: cp * point.y - sp * z, z: sp * point.y + cp * z};
  }
  function initialWorld(point) {
    const cy = Math.cos(defaultYaw), sy = Math.sin(defaultYaw), cp = Math.cos(defaultPitch), sp = Math.sin(defaultPitch);
    const y = cp * point.y + sp * point.z, z = -sp * point.y + cp * point.z;
    return {x: cy * point.x - sy * z, y, z: sy * point.x + cy * z};
  }
  function feature(kind, index, longitude, latitude, radius, phase = 0) {
    const cl = Math.cos(longitude), sl = Math.sin(longitude), ct = Math.cos(latitude), st = Math.sin(latitude);
    const center = {x: sl * ct, y: st, z: cl * ct};
    const east = {x: cl, y: 0, z: -sl}, south = {x: -sl * st, y: ct, z: -cl * st};
    const count = kind === "maria" ? 22 : 12;
    const vertices = Array.from({length: count}, (_, sample) => {
      const angle = sample * tau / count;
      // Small geodesic rings sit on the sphere, not on a rotating flat SVG.
      const contour = kind === "maria" ? 1 + .13 * Math.sin(3 * angle + phase) + .08 * Math.cos(5 * angle - phase) : 1;
      const localX = Math.cos(angle), localY = Math.sin(angle) * (kind === "maria" ? .8 : 1);
      const distance = Math.hypot(localX, localY), arc = radius * contour * distance;
      const radial = Math.cos(arc), tangent = Math.sin(arc) / distance;
      return initialWorld({x: radial * center.x + tangent * (localX * east.x + localY * south.x),
        y: radial * center.y + tangent * (localX * east.y + localY * south.y),
        z: radial * center.z + tangent * (localX * east.z + localY * south.z)});
    });
    return {kind, id: `${kind === "maria" ? "mare" : "crater"}-${index}`, center: initialWorld(center), vertices};
  }

  // A fixed, deliberately asymmetric surface. The far side has its own
  // landmarks, so half a turn never leaves an unexplained blank moon.
  const features = [
    [-.72, -.4, .34, .8], [-.18, -.97, .22, 2.3], [.70, .47, .26, 1.6], [.17, 1.13, .18, 3.8],
    [2.4, -.34, .29, 2.7], [-2.0, .58, .24, .3], [2.85, .93, .20, 4.6],
  ].map((values, index) => feature("maria", index, ...values));
  [
    [-.95, .05, .045], [-.65, -.93, .033], [.12, -.98, .048], [1.02, .12, .038], [.54, 1.12, .035],
    [1.8, -.7, .050], [-2.45, -.12, .045], [2.95, .33, .055], [-1.7, .95, .040],
  ].forEach((values, index) => features.push(feature("crater", index, ...values)));

  function horizon(first, second) {
    const t = first.z / (first.z - second.z);
    const x = first.x + (second.x - first.x) * t, y = first.y + (second.y - first.y) * t;
    const length = Math.hypot(x, y) || 1;
    // Intersect the short great-circle edge with the visible hemisphere.
    return {x: x / length, y: y / length, z: 0};
  }
  function coordinate(point) {
    return `${(50 + point.x * discRadius).toFixed(3)} ${(50 + point.y * discRadius).toFixed(3)}`;
  }
  function surfacePath(vertices, filled) {
    const firstVisible = vertices.findIndex(point => point.z >= 0);
    if (firstVisible === -1) return "";
    if (vertices.every(point => point.z >= 0)) {
      return `M ${coordinate(vertices[0])} ${vertices.slice(1).map(point => `L ${coordinate(point)}`).join(" ")} Z`;
    }
    // Filled terrain follows the lunar limb between exit and entry; crater
    // outlines stay open there, never drawing an invented line on the rim.
    const start = filled ? firstVisible : vertices.findIndex(point => point.z < 0);
    const commands = filled ? [`M ${coordinate(vertices[start])}`] : [];
    let exit;
    for (let offset = 0; offset < vertices.length; offset++) {
      const first = vertices[(start + offset) % vertices.length], second = vertices[(start + offset + 1) % vertices.length];
      const front = first.z >= 0, nextFront = second.z >= 0;
      if (front && nextFront) commands.push(`L ${coordinate(second)}`);
      else if (front) {
        exit = horizon(first, second);
        commands.push(`L ${coordinate(exit)}`);
      } else if (nextFront) {
        const entry = horizon(first, second);
        if (filled) {
          const sweep = exit.x * entry.y - exit.y * entry.x >= 0 ? 1 : 0;
          commands.push(`A ${discRadius} ${discRadius} 0 0 ${sweep} ${coordinate(entry)}`);
        } else commands.push(`M ${coordinate(entry)}`);
        commands.push(`L ${coordinate(second)}`);
      }
    }
    if (filled) commands.push("Z");
    return commands.join(" ");
  }
  function svgElement(tag, attributes) {
    const node = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  function create() {
    const element = svgElement("svg", {class: "topology-lunar-surface", viewBox: "0 0 100 100",
      "aria-hidden": "true", focusable: "false", "pointer-events": "none"});
    element.dataset.vertexCount = String(features.reduce((total, item) => total + item.vertices.length, 0));
    const paths = features.map(item => {
      const path = svgElement("path", {class: `topology-lunar-${item.kind}`, "data-lunar-feature": item.id});
      if (item.kind === "crater") path.setAttribute("fill", "none");
      element.append(path);
      return path;
    });
    let previousYaw, previousPitch;
    function render(yaw = defaultYaw, pitch = defaultPitch) {
      yaw = orientation(yaw, defaultYaw); pitch = orientation(pitch, defaultPitch);
      if (yaw === previousYaw && pitch === previousPitch) return;
      previousYaw = yaw; previousPitch = pitch;
      let visible = 0;
      features.forEach((item, index) => {
        const path = paths[index], center = rotate(item.center, yaw, pitch);
        const shape = surfacePath(item.vertices.map(point => rotate(point, yaw, pitch)), item.kind === "maria");
        path.setAttribute("d", shape);
        path.setAttribute("visibility", shape ? "visible" : "hidden");
        path.dataset.centerX = center.x.toFixed(6); path.dataset.centerY = center.y.toFixed(6); path.dataset.centerDepth = center.z.toFixed(6);
        if (shape) visible++;
      });
      element.dataset.orientationYaw = String(yaw); element.dataset.orientationPitch = String(pitch);
      element.dataset.visibleFeatures = String(visible);
    }
    render();
    return {element, render};
  }
  window.MoonsageLunarSurface = Object.freeze({create});
})();
