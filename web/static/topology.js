(() => {
  "use strict";

  const root = document.querySelector("[data-topology-root]");
  const initial = document.getElementById("topology-data");
  if (!root || !initial) return;
  const graph = root.querySelector("[data-topology-graph]");
  const stage = root.querySelector("[data-topology-stage]");
  const exitRegion = root.querySelector("[data-topology-exit-region]");
  const exitList = root.querySelector("[data-topology-exit-list]");
  const exitDiagram = root.querySelector("[data-topology-exit-links]");
  const select = root.querySelector("[data-topology-select]");
  const form = root.querySelector("[data-topology-form]");
  const refresh = root.querySelector("[data-topology-refresh]");
  const search = root.querySelector("[data-topology-search]");
  const inspector = root.querySelector("[data-topology-inspector]");
  const findNext = root.querySelector("[data-topology-find-next]");
  const status = root.querySelector("[data-topology-status]");
  const details = root.querySelector("[data-topology-details]");
  const layoutEdit = root.querySelector("[data-topology-layout-edit]");
  const touchHint = root.querySelector("[data-topology-touch-hint]");
  const svgNS = "http://www.w3.org/2000/svg";
  const relationTypes = new Set(["mutual", "outbound", "inbound", "denied", "unknown", "not_applicable"]);
  const permissionTypes = new Set(["allowed", "partial", "denied", "inactive", "unknown", "not_applicable"]);
  const nodeKinds = new Set(["hub", "awg", "vless"]);
  const availabilityTypes = new Set(["hub", "enabled", "disabled", "pending", "unknown"]);
  const nodeStringKeys = ["id", "name", "kind", "kind_label", "address", "state", "availability", "online_label"];
  let snapshot;
  let controller = null;
  let generation = 0;
  let layoutFrame = null;
  let requestedId = null;
  // Rendering stays in a flat HTML/SVG plane. Only the model and camera are
  // three-dimensional; labels never become tilted, rasterized textures.
  const positions = new Map();
  const spacePositions = new Map();
  const defaultCamera = {yaw: -.36, pitch: -.22};
  const camera = {...defaultCamera};
  const cameraRadii = {x: 1, y: 1};
  const projection = "3d";
  const nodeMetrics = new Map();
  let baseNodeSize = {width: 148, height: 72};
  let baseHubSize = {width: 148, height: 148};
  const pointers = new Map();
  const activeTouches = new Set();
  let nativeMultiTouch = false;
  const view = {x: 0, y: 0, scale: 1, width: 0, height: 0};
  let scene = null;
  let drawingKey = "";
  let exitGeometryDirty = true;
  const exitMetrics = new Map();
  let exitInset = 0, exitLayoutKey = "", exitLayout = null;
  let gesture = null;
  let suppressClickUntil = 0;
  let searchIndex = 0;
  let pointerFrame = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const inertiaLimits = {maxSpeed: .0036, referenceSpeed: .0048, minSpeed: .000045,
    minDecayMs: 140, maxDecayMs: 380, durationMs: 1800, sampleWindowMs: 80, releaseIdleMs: 100};
  let inertia = null, inertiaFrame = null;
  let restoringFocus = false;
  let userAdjustedView = false;
  let layoutAspect = null;
  let displayMode = "overview";
  let direction = "forward";
  let layoutEditing = false;
  const dirtyNodes = new Set();
  const configCache = new Map();
  const configInterval = 30000;
  let configTimer = null, configStopped = false;

  function stringList(value) { return Array.isArray(value) && value.every(item => typeof item === "string"); }
  function validNode(node) {
    return node && nodeStringKeys.every(key => typeof node[key] === "string") && typeof node.protected === "boolean" &&
      stringList(node.exit_ids) && node.exit_ids.length <= 16 && new Set(node.exit_ids).size === node.exit_ids.length &&
      nodeKinds.has(node.kind) && availabilityTypes.has(node.availability) && node.online_label === "未检测" &&
      (node.kind === "hub" ? node.id === "hub" && node.availability === "hub" && !node.exit_ids.length : node.id.startsWith(`${node.kind}:`) && node.availability !== "hub");
  }
  function sameNode(first, second) {
    return validNode(first) && second && [...nodeStringKeys, "protected"].every(key => first[key] === second[key]) &&
      JSON.stringify(first.exit_ids) === JSON.stringify(second.exit_ids);
  }
  function validDirection(direction) {
    return direction && permissionTypes.has(direction.status) && typeof direction.label === "string" &&
      typeof direction.summary === "string" && stringList(direction.scopes) && stringList(direction.warnings);
  }
  function validSnapshot(value) {
    if (!value || !Array.isArray(value.nodes) || !value.nodes.every(validNode) ||
      value.nodes.filter(node => node.kind === "hub").length !== 1 || typeof value.selected_id !== "string" ||
      !Array.isArray(value.relations) || !Array.isArray(value.links) || !stringList(value.warnings) || typeof value.note !== "string" ||
      typeof value.observed_at !== "string" || !value.summary ||
      !["nodes", "awg", "vless", "enabled", "disabled", "pending"].every(key => Number.isInteger(value.summary[key]) && value.summary[key] >= 0)) return false;
    const nodes = new Map(value.nodes.map(node => [node.id, node]));
    if (!Array.isArray(value.exits) || value.exits.length > 16 || !value.exits.every(exit => exit &&
      typeof exit.id === "string" && /^[a-f0-9]{12}$/.test(exit.id) && typeof exit.name === "string" &&
      exit.name.length > 0 && [...exit.name].length <= 40)) return false;
    const exits = new Set(value.exits.map(exit => exit.id));
    if (exits.size !== value.exits.length || value.nodes.some(node => node.exit_ids.some(id => !exits.has(id)))) return false;
    if (nodes.size !== value.nodes.length || !sameNode(value.selected, nodes.get(value.selected_id)) ||
      value.selected.id !== value.selected_id || value.relations.length !== nodes.size - 1) return false;
    const related = new Set();
    for (const relation of value.relations) {
      if (!relation || !validNode(relation.node) || relation.node.id === value.selected_id || related.has(relation.node.id) ||
        !sameNode(relation.node, nodes.get(relation.node.id)) || !relationTypes.has(relation.relation) || typeof relation.label !== "string" ||
        !validDirection(relation.forward) || !validDirection(relation.reverse)) return false;
      related.add(relation.node.id);
    }
    const links = new Set();
    for (const link of value.links) {
      if (!link || typeof link.source !== "string" || typeof link.target !== "string" || link.source === link.target ||
        !nodes.has(link.source) || !nodes.has(link.target) || !["allowed", "partial"].includes(link.status) ||
        typeof link.label !== "string" || !stringList(link.scopes) || !link.scopes.length) return false;
      const source = nodes.get(link.source), target = nodes.get(link.target);
      if (source.kind === "hub" || target.kind === "vless" || source.availability !== "enabled" ||
        !["enabled", "hub"].includes(target.availability)) return false;
      const key = JSON.stringify([link.source, link.target]);
      if (links.has(key)) return false;
      links.add(key);
    }
    return true;
  }
  try {
    snapshot = JSON.parse(initial.textContent);
    if (!validSnapshot(snapshot)) return;
  } catch (_) { return; }
  configCache.set(snapshot.selected_id, {snapshot, at: performance.now()});

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svgElement(tag, attributes) {
    const node = document.createElementNS(svgNS, tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    return node;
  }
  function relationType(relation) { return relation && relationTypes.has(relation.relation) ? relation.relation : "unknown"; }
  function matchingNodes() {
    const query = search.value.trim().toLocaleLowerCase();
    return query ? snapshot.nodes.filter(node => [node.name, node.address, node.kind_label, node.kind].join(" ").toLocaleLowerCase().includes(query)) : [];
  }
  function directionalLinks() {
    if (displayMode === "overview") return [];
    return snapshot.links.filter(link => (direction === "forward" ? link.source : link.target) === snapshot.selected_id);
  }
  function directionHint() {
    if (snapshot.selected_id === "hub") return direction === "forward"
      ? "VPS 主动访问未检测，详情列出各节点状态；不绘制未经确认的授权箭头。"
      : "箭头指向 VPS，来源节点内显示允许访问 VPS 的端口。";
    return direction === "forward" ? "端口写在目标节点内，完整范围见详情。"
      : "卡片端口表示该节点可访问当前节点的范围。";
  }
  function compactScope(scope) {
    if (scope === "全部协议 · 全部端口") return "全协议 · 全端口";
    return scope.replaceAll(" · ", " ").replaceAll(", ", ",");
  }
  function addressLabel(node) {
    return node.address || (node.kind === "vless" ? "无独立内网 IP" : "IP 未提供");
  }
  function spatialObjects() {
    // Only real internal devices belong to the rotating VPS-centered world.
    return snapshot.nodes;
  }
  function objectElement(id) { return scene?.nodes.get(id); }
  function galaxySymbol(index) {
    // Native SVG keeps distant galaxies sharp without textures or a render loop.
    const symbol = svgElement("svg", {class: "topology-galaxy-symbol", viewBox: "0 0 120 64", "aria-hidden": "true", focusable: "false"});
    const disc = svgElement("g", {transform: `translate(60 32) rotate(${-24 + index % 4 * 13})`});
    disc.append(svgElement("ellipse", {class: "topology-galaxy-halo", rx: 43, ry: 22}),
      svgElement("ellipse", {class: "topology-galaxy-orbit", rx: 35, ry: 12}),
      svgElement("path", {class: "topology-galaxy-arm", d: "M -40 5 C -34 -13 9 -20 24 -5 C 36 7 7 18 -17 12 M 40 -5 C 34 13 -9 20 -24 5 C -36 -7 -7 -18 17 -12"}),
      svgElement("ellipse", {class: "topology-galaxy-inner", rx: 15, ry: 6}),
      svgElement("circle", {class: "topology-galaxy-core", r: 3}));
    [[-29, -5, 1.4], [24, 8, 1.6], [42, -11, 1], [-17, 18, .9]].forEach(([cx, cy, r]) =>
      disc.append(svgElement("circle", {class: "topology-galaxy-star", cx, cy, r})));
    symbol.append(disc);
    return symbol;
  }
  function renderGalaxies() {
    // Subscription visibility is separate from permissions, reachability and
    // real traffic. A disabled node may still have configured visible exits.
    const active = new Set(displayMode === "relations" ? snapshot.selected.exit_ids : []);
    for (const exit of snapshot.exits) {
      const item = scene.exits.get(exit.id), enabled = active.has(exit.id);
      item.classList.toggle("is-active", enabled);
      item.querySelector(".topology-galaxy-name").textContent = exit.name;
      const state = item.querySelector(".topology-galaxy-state");
      state.textContent = displayMode !== "relations" ? "出口" : enabled ? "已展示" : "未展示";
      item.setAttribute("aria-label", `${exit.name}，订阅出口，${state.textContent}。配置关联不代表实时流量。`);
      item.title = `${exit.name} · ${state.textContent} · 订阅配置，非实时流量`;
    }
    for (const edge of scene.exitLinks) {
      edge.line.classList.toggle("is-active", active.has(edge.exitId));
      edge.line.style.display = active.has(edge.exitId) ? "" : "none";
    }
  }
  function renderInspector() {
    if (!inspector) return;
    const selected = snapshot.selected;
    if (displayMode === "overview") {
      const icon = element("span", "topology-inspector-icon", "◎");
      icon.setAttribute("aria-hidden", "true");
      inspector.replaceChildren(icon, element("h3", "", "先看结构，再看权限"),
        element("p", "", "所有节点经 VPS 中转。点一个节点，查看它能访问谁、开放哪些端口。"),
        element("p", "topology-inspector-hint", "虚线表示接入配置。↑ 发往 VPS，↓ 从 VPS 接收；近期握手不等于实时连通。"));
      return;
    }
    const hubOutbound = selected.kind === "hub" && direction === "forward";
    const allowed = snapshot.relations.filter(relation => ["allowed", "partial"].includes(relation[direction].status));
    const shown = hubOutbound ? snapshot.relations : allowed;
    const heading = element("div", "topology-inspector-heading");
    heading.append(element("p", "eyebrow", "当前节点"), element("h3", "", selected.name),
      element("p", "", [selected.kind_label, selected.address].filter(Boolean).join(" · ")));
    if (selected.kind !== "hub") {
      heading.dataset.telemetryNode = selected.id;
      const live = element("p", "node-telemetry-line");
      const state = element("span", "node-telemetry-status"); state.dataset.telemetryStatus = "";
      const label = element("span", "", "采样中"); label.dataset.telemetryStateLabel = "";
      const dot = element("i"); dot.setAttribute("aria-hidden", "true"); state.append(dot, label);
      const rates = element("span", "node-telemetry-rates", "↑— ↓—"); rates.dataset.telemetryRates = "";
      live.append(state, rates); heading.append(live);
    }
    const title = element("h4", "", hubOutbound ? `VPS 发起访问 · ${shown.length} 个节点`
      : `${selected.kind === "hub" ? "可访问 VPS" : direction === "forward" ? "我可访问" : "可访问我"} · ${allowed.length}`);
    const list = element("ul", "topology-access-list");
    shown.forEach(relation => {
      const row = element("li", "topology-access-item");
      row.dataset.topologyAccessTarget = relation.node.id;
      row.dataset.topologyAccessStatus = relation[direction].status;
      const target = element("button", "topology-access-target", relation.node.name);
      target.type = "button";
      target.title = "在图中定位此节点";
      target.addEventListener("click", () => centerNode(relation.node.id, true));
      const scopes = element("ul", "topology-access-scopes");
      relation[direction].scopes.forEach(scope => scopes.append(element("li", "", scope)));
      row.append(target);
      if (hubOutbound) {
        row.append(element("span", `topology-permission permission-${relation.forward.status}`, relation.forward.label),
          element("p", "topology-access-note", relation.forward.summary));
      } else row.append(scopes);
      list.append(row);
    });
    if (!shown.length) list.append(element("li", "topology-inspector-hint", hubOutbound ? "尚无其他节点。"
      : "此方向没有已确认的授权。未知、禁用及未授权情况请查看完整权限。"));
    const full = element("button", "secondary-button topology-open-details", `完整权限 · ${snapshot.relations.length} 个目标`);
    full.type = "button";
    full.addEventListener("click", () => {
      const section = root.querySelector("[data-topology-full-details]");
      if (section) { section.open = true; section.scrollIntoView({block: "start", behavior: "smooth"}); }
    });
    const hubNote = selected.kind === "hub" ? [element("p", "topology-hub-note",
      "入站按节点授权显示。VPS 主动访问不受这些规则控制，实际可达性未检测；VLESS 不能作为访问目标。")] : [];
    inspector.replaceChildren(heading, ...hubNote, title, list, full,
      element("p", "topology-inspector-hint", hubOutbound
        ? "未检测不等于禁止；实际访问还取决于路由、目标防火墙和服务。"
        : "这里只列配置允许的范围，不代表实时连通。"));
    root.dispatchEvent(new Event("node-telemetry-bind"));
  }
  function syncModeControls() {
    root.dataset.topologyMode = displayMode;
    graph.dataset.mode = displayMode;
    graph.dataset.direction = direction;
    root.querySelectorAll("[data-topology-mode]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.topologyMode === displayMode)));
    root.querySelectorAll("[data-topology-direction]").forEach(button => {
      const forward = button.dataset.topologyDirection === "forward";
      button.setAttribute("aria-pressed", String(button.dataset.topologyDirection === direction));
      button.textContent = snapshot.selected_id === "hub" ? forward ? "VPS 可访问" : "可访问 VPS" : forward ? "我可访问" : "可访问我";
    });
    const controls = root.querySelector("[data-topology-direction-controls]");
    if (controls) controls.hidden = displayMode !== "relations";
    const full = root.querySelector("[data-topology-full-details]");
    if (full) {
      full.hidden = displayMode !== "relations";
      if (full.hidden) full.open = false;
    }
    syncSelection();
    renderInspector();
  }
  function syncSelection() {
    select.value = displayMode === "relations" ? snapshot.selected_id : "";
    const location = new URL(window.location.href);
    if (displayMode === "relations") location.searchParams.set("node", snapshot.selected_id);
    else location.searchParams.delete("node");
    location.searchParams.delete("format");
    if (location.href !== window.location.href) window.history.replaceState(null, "", location.href);
  }
  function setMode(mode) {
    stopInertia();
    if (mode === "overview" && controller) {
      controller.abort(); generation += 1; controller = null; requestedId = null;
      refresh.disabled = false; root.removeAttribute("aria-busy");
      scheduleConfig();
    }
    if (mode === "relations" && displayMode !== "relations" && snapshot.selected_id === "hub") direction = "reverse";
    displayMode = mode;
    syncModeControls(); renderGraph();
    setStatus(mode === "overview" ? "全部节点都在图中。点击节点查看端口。" : directionHint());
  }
  function clearSelection() {
    // Retain the backing snapshot and the user's spatial layout, not a visible
    // selection. setMode invalidates any pending selection response as well.
    if (graph.contains(document.activeElement)) graph.focus({preventScroll: true});
    setMode("overview");
  }
  function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state || "ready";
  }
  function timestamp(value) {
    if (!value) return "未提供";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", {hour12: false});
  }
  function renderObservedAt() {
    const observed = root.querySelector("[data-topology-observed-at]");
    observed.textContent = timestamp(snapshot.observed_at);
    if (snapshot.observed_at) observed.setAttribute("datetime", snapshot.observed_at);
  }
  function renderSelect() {
    const options = document.createDocumentFragment();
    const placeholder = element("option", "", "选择节点…");
    placeholder.value = ""; placeholder.disabled = true;
    placeholder.selected = displayMode !== "relations";
    options.append(placeholder);
    snapshot.nodes.forEach(node => {
      const option = element("option", "", `${node.name} · ${node.kind_label}`);
      option.value = node.id;
      option.selected = displayMode === "relations" && node.id === snapshot.selected_id;
      options.append(option);
    });
    select.replaceChildren(options);
  }
  function directionList(direction) {
    const list = element("ul", "topology-relations");
    list.setAttribute(direction === "forward" ? "data-topology-outbound" : "data-topology-inbound", "");
    if (!snapshot.relations.length) {
      list.append(element("li", "topology-relations-empty", "尚无其他节点。添加节点后将在此显示访问关系。"));
      return list;
    }
    snapshot.relations.forEach(relation => {
      const permission = relation[direction];
      const state = permissionTypes.has(permission.status) ? permission.status : "unknown";
      const row = element("li", "topology-relation");
      row.dataset.relationStatus = state;
      const heading = element("div", "topology-relation-heading");
      heading.append(element("strong", "", relation.node.name), element("span", `topology-permission permission-${state}`, permission.label || "未知"));
      const from = direction === "forward" ? snapshot.selected : relation.node;
      const to = direction === "forward" ? relation.node : snapshot.selected;
      const path = [from.name];
      if (from.kind !== "hub" && to.kind !== "hub") path.push("VPS");
      path.push(to.name);
      row.append(heading, element("p", "topology-path", path.join(" → ")), element("p", "topology-relation-summary", permission.summary || "当前配置无法确定此方向的授权。"));
      if (Array.isArray(permission.scopes) && permission.scopes.length) {
        const scopes = element("ul", "topology-scopes");
        scopes.setAttribute("aria-label", "配置范围");
        permission.scopes.forEach(scope => scopes.append(element("li", "", scope)));
        row.append(scopes);
      }
      if (Array.isArray(permission.warnings)) permission.warnings.forEach(warning => row.append(element("p", "topology-relation-warning", warning)));
      list.append(row);
    });
    return list;
  }
  function renderDetails() {
    const selected = snapshot.selected;
    const summary = element("div", "topology-selected");
    const identity = element("div");
    const title = element("h2", "", selected.name);
    title.id = "topology-selected-heading";
    identity.append(element("p", "eyebrow", "当前观察节点"), title, element("p", "", [selected.kind_label, selected.address].filter(Boolean).join(" · ")));
    const facts = element("dl");
    const entries = [["配置状态", selected.state || "未知"]];
    if (selected.protected) entries.push(["节点角色", "管理入口"]);
    entries.forEach(([label, value]) => {
      const fact = element("div");
      fact.append(element("dt", "", label), element("dd", "", value));
      facts.append(fact);
    });
    summary.append(identity, facts);
    const directions = element("div", "topology-direction-grid");
    [["forward", "outbound", "我可访问", "从当前节点发起连接", "↗"], ["reverse", "inbound", "可访问我", "从其他节点发起连接", "↙"]].forEach(([key, name, label, subtitle, arrow]) => {
      const section = element("section", "topology-direction");
      section.setAttribute("aria-labelledby", `topology-${name}-heading`);
      const heading = element("div", "topology-direction-heading");
      const icon = element("span", "", arrow);
      icon.setAttribute("aria-hidden", "true");
      const headingText = element("div");
      const title = element("h3", "", label);
      title.id = `topology-${name}-heading`;
      headingText.append(title, element("p", "", subtitle));
      heading.append(icon, headingText);
      section.append(heading, directionList(key));
      directions.append(section);
    });
    details.replaceChildren(summary, element("p", "topology-detail-note", "以下为配置允许的方向，允许部分端口不等于完全互通。目标的防火墙、服务与实际在线情况仍可能影响连接。"), directions);
    root.querySelectorAll("[data-topology-count]").forEach(counter => { counter.textContent = snapshot.summary?.[counter.dataset.topologyCount] ?? "—"; });
    const warnings = root.querySelector("[data-topology-warnings]");
    const notes = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
    warnings.replaceChildren(...notes.map(warning => element("p", "alert neutral", warning)));
    warnings.hidden = !notes.length;
    if (snapshot.note) root.querySelector("[data-topology-note]").textContent = snapshot.note;
    renderObservedAt();
  }
  function measuredAspect() {
    return graph.clientWidth;
  }
  function measureNodes() {
    const style = getComputedStyle(graph);
    baseNodeSize = {width: parseFloat(style.getPropertyValue("--topology-node-width")) || 148,
      height: parseFloat(style.getPropertyValue("--topology-node-height")) || 72};
    baseHubSize = {width: parseFloat(style.getPropertyValue("--topology-hub-width")) || 148,
      height: parseFloat(style.getPropertyValue("--topology-hub-height")) || 148};
    const ids = new Set(spatialObjects().map(node => node.id));
    for (const id of nodeMetrics.keys()) if (!ids.has(id)) nodeMetrics.delete(id);
    let changed = false;
    for (const [id, button] of scene?.nodes || []) {
      if (!ids.has(id) || !button.offsetWidth || !button.offsetHeight) continue;
      // offset sizes are border boxes before the world's zoom transform.
      const ports = button.querySelector("[data-topology-node-ports]");
      const portHeight = ports?.offsetHeight || 0;
      const minimum = id === "hub" ? baseHubSize.height : baseNodeSize.height;
      const size = {width: button.offsetWidth, height: button.offsetHeight,
        bodyHeight: Math.max(minimum, button.offsetHeight - (portHeight ? portHeight + 2 : 0))};
      const previous = nodeMetrics.get(id);
      if (!previous || size.width !== previous.width || size.height !== previous.height || size.bodyHeight !== previous.bodyHeight) changed = true;
      nodeMetrics.set(id, size);
    }
    const exitIds = new Set(snapshot.exits.map(exit => exit.id));
    for (const id of exitMetrics.keys()) if (!exitIds.has(id)) exitMetrics.delete(id);
    for (const [id, item] of scene?.exits || []) {
      if (!exitIds.has(id) || !item.offsetWidth || !item.offsetHeight) continue;
      const size = {width: item.offsetWidth, height: item.offsetHeight}, previous = exitMetrics.get(id);
      if (!previous || size.width !== previous.width || size.height !== previous.height) changed = true;
      exitMetrics.set(id, size);
    }
    if (changed) exitGeometryDirty = true;
    return changed;
  }
  function nodeSize(id) {
    const measured = nodeMetrics.get(id);
    if (id === "hub" && projection === "3d") return {width: Math.max(baseHubSize.width, measured?.width || 0), height: Math.max(baseHubSize.height, measured?.height || 0)};
    return measured || baseNodeSize;
  }
  function layoutHeight() {
    // Reserve the largest possible scope block in either direction, not just
    // today's visible cards. Selection must not rearrange a user's nodes.
    const lines = snapshot.links.reduce((count, edge) => Math.max(count, Math.min(3, edge.scopes.length)), 0);
    return baseNodeSize.height + (lines ? 6 + 15 * lines : 0);
  }
  function sizeCanvas() {
    const count = spatialObjects().length - 1;
    const compact = graph.clientWidth >= 1000 && count >= 10 && count <= 16;
    const rows = Math.ceil(count / (compact ? 4 : 2));
    // Fixed-size labels use vertical page space, never a shrinking scene.
    let height = Math.max(graph.clientWidth >= 520 ? 600 : 480,
      rows * (layoutHeight() + 20) + (graph.clientWidth < 520 ? 160 : 80));
    if (graph.clientWidth) {
      const radiusX = availableRadiusX(), seeds = defaultSpatialSeeds();
      const tallest = Math.max(...spatialObjects().map(node => reservedSpatialSize(node.id).height));
      // Reserve unit-ball depth without compressing the readable XY seeds.
      // The resulting ellipse contains every rotated point at every angle.
      const radiusY = Math.max(1, ...[...seeds.values()].map(point => Math.abs(point.y) /
        Math.sqrt(Math.max(.01, .94 - (point.x / radiusX) ** 2))));
      height = Math.max(height, radiusY * 2 + tallest + 40);
    }
    exitLayout = placeDistantExits(Math.ceil(height));
    exitInset = exitLayout.inset;
    graph.style.height = `${exitLayout.height}px`;
    graph.dataset.skyInset = String(exitInset);
    for (const [id, point] of exitLayout.points) {
      const item = scene?.exits.get(id);
      if (item) { item.style.left = `${point.x}px`; item.style.top = `${point.y}px`; }
    }
  }
  function placeDistantExits(baseHeight) {
    const width = graph.clientWidth;
    if (!snapshot.exits.length || !width) { exitLayoutKey = ""; return {height: baseHeight, inset: 0, points: new Map()}; }
    const widest = Math.max(...snapshot.nodes.map(node => reservedSpatialSize(node.id).width));
    const tallest = Math.max(...snapshot.nodes.map(node => reservedSpatialSize(node.id).height));
    const rx = availableRadiusX(), ry = Math.max(1, (baseHeight - tallest) / 2 - 20);
    const items = snapshot.exits.map(exit => ({id: exit.id, ...(exitMetrics.get(exit.id) || {
      width: Math.min(width < 600 ? 132 : 152, (width - 56) / 2), height: 144})}));
    const key = JSON.stringify([width, baseHeight, widest, tallest, items]);
    if (exitLayout && exitLayoutKey === key) return exitLayout;
    const margin = width < 600 ? 14 : 20, gap = 20;
    const itemWidth = Math.max(...items.map(item => item.width));
    const columns = Math.min(4, items.length, Math.max(1, Math.floor((width - margin * 2 + gap) / (itemWidth + gap))));
    const cellWidth = (width - margin * 2) / columns;
    const drift = Math.min(18, Math.max(0, (cellWidth - itemWidth - gap) / 2));
    const order = Array.from({length: columns}, (_, index) => index % 2 ? columns - 1 - Math.floor(index / 2) : Math.floor(index / 2));
    const make = inset => {
      const height = baseHeight + inset, centerY = baseHeight / 2 + inset;
      const points = new Map(), boxes = [];
      // Scatter only across the sky. Uneven rows imply distance, not an
      // orbit or a toolbar; narrow screens use fewer columns, never a sidebar.
      const cursors = [6, 46, 20, 70].slice(0, columns).map(offset => margin + offset);
      items.forEach((item, index) => {
        const column = order[index % columns];
        const stagger = drift * (parseInt(item.id.slice(-3), 16) % 3 - 1);
        const x = margin + cellWidth * (column + .5) - item.width / 2 + stagger;
        const y = cursors[column];
        cursors[column] += item.height + gap;
        boxes.push({...item, x, y}); points.set(item.id, {x, y});
      });
      const clear = boxes.every((box, index) => {
        // Expanded rectangles exclude the complete rotating ellipsoid, not
        // merely the current projected node positions. 12px covers parallax.
        const dx = Math.max(0, Math.abs(box.x + box.width / 2 - width / 2) - (box.width + widest) / 2 - 12);
        const dy = Math.max(0, Math.abs(box.y + box.height / 2 - centerY) - (box.height + tallest) / 2 - 12);
        return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height + 12 <= centerY &&
          dx * dx / (rx * rx) + dy * dy / (ry * ry) > 1.01 &&
          boxes.slice(index + 1).every(other => box.x + box.width + 12 <= other.x || other.x + other.width + 12 <= box.x ||
            box.y + box.height + 12 <= other.y || other.y + other.height + 12 <= box.y);
      });
      return {height, inset, points, clear};
    };
    let result = make(0);
    if (!result.clear) {
      // Only the sky needs extra space. Keep the complete rotating envelope
      // below it, without mirroring this padding into an empty sea below.
      let low = 0, high = Math.ceil(items.reduce((sum, item) => sum + item.height + gap, 0) + tallest + 80);
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (make(middle).clear) high = middle; else low = middle;
      }
      result = make(high);
    }
    exitLayoutKey = key;
    return result;
  }
  function availableRadiusX() {
    const widest = Math.max(...spatialObjects().map(node => reservedSpatialSize(node.id).width));
    return Math.max(1, (graph.clientWidth - widest) / 2 - 20);
  }
  function updateCameraRadii() {
    const tallest = Math.max(...spatialObjects().map(node => reservedSpatialSize(node.id).height));
    cameraRadii.x = availableRadiusX();
    cameraRadii.y = Math.max(1, (graph.clientHeight - exitInset - tallest) / 2 - 20);
    graph.dataset.cameraRadiusX = String(cameraRadii.x);
    graph.dataset.cameraRadiusY = String(cameraRadii.y);
  }
  function cameraPoint(point) {
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const x = cy * point.x + sy * point.z, z = -sy * point.x + cy * point.z;
    return {x, y: cp * point.y - sp * z, z: sp * point.y + cp * z};
  }
  function fromCamera(point) {
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const y = cp * point.y + sp * point.z, z = -sp * point.y + cp * point.z;
    return {x: cy * point.x - sy * z, y, z: sy * point.x + cy * z};
  }
  function projectPoint(point) {
    const rotated = cameraPoint(point);
    return {x: rotated.x * cameraRadii.x, y: rotated.y * cameraRadii.y, depth: rotated.z};
  }
  function projectPositions() {
    updateCameraRadii();
    positions.clear();
    for (const [id, point] of spacePositions) positions.set(id, projectPoint(point));
    const depths = [...positions].sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));
    depths.forEach(([id, point], index) => { point.depthIndex = index + 1; });
    graph.dataset.cameraYaw = String(camera.yaw);
    graph.dataset.cameraPitch = String(camera.pitch);
  }
  function reservedSpatialSize(id) {
    const size = nodeSize(id);
    const scopeHeight = layoutHeight() - baseNodeSize.height;
    return {width: size.width, height: id === "hub" ? Math.max(size.height, baseHubSize.height + scopeHeight)
      : Math.max(size.height, (size.bodyHeight || baseNodeSize.height) + scopeHeight)};
  }
  function spatialOverlaps(seeds) {
    const points = [...seeds];
    const sizes = new Map(points.map(([id]) => [id, reservedSpatialSize(id)]));
    return points.some(([id, point], index) => points.slice(index + 1).some(([otherId, other]) => {
      const first = sizes.get(id), second = sizes.get(otherId);
      return Math.abs(point.x - other.x) < (first.width + second.width) / 2 + 20
        && Math.abs(point.y - other.y) < (first.height + second.height) / 2 + 20;
    }));
  }
  function defaultSpatialSeeds() {
    const seeds = new Map([["hub", {x: 0, y: 0}]]);
    const clients = spatialObjects().filter(node => node.id !== "hub");
    if (!clients.length) return seeds;
    const leafHeight = Math.max(layoutHeight(), ...clients.map(node => reservedSpatialSize(node.id).height));
    const hubClearance = (reservedSpatialSize("hub").height + leafHeight) / 2 + 28;
    const radiusX = availableRadiusX() * .9;
    if (graph.clientWidth >= 1000 && clients.length >= 10 && clients.length <= 16) {
      // A second, shallow orbit uses the open space beside the moon instead
      // of stretching a crowded desktop perimeter into a very tall canvas.
      const outer = clients.slice(0, -4), inner = clients.slice(-4);
      const leafWidth = Math.max(...clients.map(node => reservedSpatialSize(node.id).width));
      const innerX = (reservedSpatialSize("hub").width + leafWidth) / 2 + 24;
      let radiusY = Math.max(280, leafHeight * 2);
      for (let attempt = 0; attempt < 8; attempt++) {
        outer.forEach((node, index) => {
          const angle = -Math.PI / 2 + index * Math.PI * 2 / outer.length;
          seeds.set(node.id, {x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY});
        });
        inner.forEach((node, index) => seeds.set(node.id, {x: index % 2 ? innerX : -innerX,
          y: (index < 2 ? -1 : 1) * (leafHeight + 24) / 2}));
        if (!spatialOverlaps(seeds)) return seeds;
        radiusY *= 1.1;
      }
    }
    if (graph.clientWidth >= 600 && clients.length >= 3 && clients.length <= 16) {
      let radiusY = Math.max(165, hubClearance);
      for (let attempt = 0; attempt < 9; attempt++) {
        clients.forEach((node, index) => {
          const angle = -Math.PI / 2 + index * Math.PI * 2 / clients.length + Math.sin(index * 1.9) * .04;
          const stagger = .96 + Math.sin(index * 2.1) * .035;
          seeds.set(node.id, {x: Math.cos(angle) * radiusX * stagger, y: Math.sin(angle) * radiusY * stagger});
        });
        if (!spatialOverlaps(seeds)) return seeds;
        radiusY *= 1.12;
      }
    }
    if (graph.clientWidth >= 600 && clients.length >= 5) {
      // Larger constellations follow two offset arcs rather than straight
      // table columns. Fixed row spacing protects full-height port cards.
      const step = leafHeight + 36, remaining = clients.length - 2;
      const counts = [Math.ceil(remaining / 2), Math.floor(remaining / 2)];
      const radiusY = Math.max(hubClearance, ((counts[0] - 1) / 2 + 1.2) * step);
      seeds.set(clients[0].id, {x: -.11 * radiusX, y: -radiusY});
      seeds.set(clients[1].id, {x: .15 * radiusX, y: radiusY});
      clients.slice(2).forEach((node, index) => {
        const side = index % 2, row = Math.floor(index / 2);
        const y = (row - (counts[side] - 1) / 2) * step + Math.sin(index * 1.7) * 5;
        const arc = Math.sqrt(Math.max(.3, 1 - (y / (radiusY * 1.08)) ** 2));
        const x = Math.min(radiusX, Math.max((baseHubSize.width + baseNodeSize.width) / 2 + 25,
          radiusX * arc * (.96 + Math.sin(index * 2.3) * .025)));
        seeds.set(node.id, {x: side ? x : -x, y});
      });
      return seeds;
    }
    // Pack the narrow ellipse instead of extending two fixed-width columns
    // into its poles. Paired rows stay near the equator; outer rows are single.
    // Labels keep their native size and the unit-ball rotation bounds remain
    // unchanged. The first row starts at hubClearance, with no extra half-row.
    const radius = availableRadiusX();
    const leafWidth = Math.max(...clients.map(node => reservedSpatialSize(node.id).width));
    const pairX = (leafWidth + 20) / 2 + 1, step = leafHeight + 22;
    const pairBudget = Math.sqrt(Math.max(0, .94 - (pairX / radius) ** 2));
    const halves = [clients.slice(0, Math.ceil(clients.length / 2)), clients.slice(Math.ceil(clients.length / 2))];
    halves.forEach((nodes, half) => {
      let bestPairs = 0, bestCost = Infinity;
      const maxPairs = pairBudget > 0 ? Math.floor(nodes.length / 2) : 0;
      for (let pairs = 0; pairs <= maxPairs; pairs++) {
        const singles = nodes.length - pairs * 2;
        const cost = Math.max(pairs ? (hubClearance + (pairs - 1) * step) / pairBudget : 0,
          singles ? (hubClearance + (pairs + singles - 1) * step) / Math.sqrt(.94) : 0);
        if (cost < bestCost) { bestCost = cost; bestPairs = pairs; }
      }
      nodes.forEach((node, index) => {
        const paired = index < bestPairs * 2;
        const row = paired ? Math.floor(index / 2) : index - bestPairs;
        seeds.set(node.id, {x: paired ? (index % 2 ? pairX : -pairX) : 0,
          y: (half ? 1 : -1) * (hubClearance + row * step)});
      });
    });
    return seeds;
  }
  function syncPositions(rearrange = false) {
    const objects = spatialObjects(), ids = new Set(objects.map(node => node.id));
    for (const id of spacePositions.keys()) if (!ids.has(id)) spacePositions.delete(id);
    if (rearrange) {
      spacePositions.clear(); Object.assign(camera, defaultCamera);
    }
    if (!spacePositions.size) layoutAspect = measuredAspect();
    updateCameraRadii();
    const seeds = defaultSpatialSeeds();
    objects.forEach((node, index) => {
      if (node.id === "hub") { spacePositions.set("hub", {x: 0, y: 0, z: 0}); return; }
      if (spacePositions.has(node.id)) return;
      const seed = seeds.get(node.id), x = seed.x / cameraRadii.x, y = seed.y / cameraRadii.y;
      const budget = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      const depth = Math.sin(index * 2.3999632297) * Math.min(.48, budget * .72);
      spacePositions.set(node.id, fromCamera({x, y, z: depth}));
    });
    projectPositions();
  }
  function moveNode(id, origin, dx, dy) {
    if (id === "hub" || !origin) return;
    const current = cameraPoint(origin);
    let x = current.x + dx / cameraRadii.x, y = current.y + dy / cameraRadii.y;
    const radius = Math.sqrt(Math.max(0, 1 - current.z * current.z));
    const length = Math.hypot(x, y);
    if (length > radius) { x *= radius / length; y *= radius / length; }
    spacePositions.set(id, fromCamera({x, y, z: current.z}));
    projectPositions();
    dirtyNodes.add(id);
  }
  function rotateCamera(yaw, pitch) {
    camera.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    camera.pitch = Math.max(-Math.PI * .44, Math.min(Math.PI * .44, pitch));
    projectPositions();
    for (const id of positions.keys()) dirtyNodes.add(id);
  }
  function syncProjectionControls() {
    root.dataset.projection = projection; graph.dataset.projection = projection;
    const mouseHelp = root.querySelector("[data-topology-mouse-help]");
    if (mouseHelp) mouseHelp.textContent = "点空白取消选中 · 拖空白旋转 · 拖节点整理";
    const touchHelp = root.querySelector("[data-topology-touch-help]");
    if (touchHelp) touchHelp.textContent = "左右滑动画布、节点或 VPS 旋转水平视角，上下滑动滚页。点“移动节点”后可拖动设备节点，空白和 VPS 仍可上下滚页。点空白取消选中。";
    if (touchHint) touchHint.textContent = !layoutEditing ? "直接左右滑动画布旋转，上下滑动滚页；点“移动节点”可拖动设备节点。" : "拖动设备节点调整位置；空白或 VPS 仍可左右旋转、上下滚页。";
  }
  function createCosmos() {
    const backdrop = element("div", "topology-cosmos");
    backdrop.setAttribute("aria-hidden", "true"); backdrop.style.pointerEvents = "none";
    const svg = svgElement("svg", {class: "topology-cosmos-scene", viewBox: "0 0 1000 700", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false", "pointer-events": "none"});
    const stars = svgElement("g", {class: "topology-stars"});
    // Tiny, unconnected starlets are decoration, never additional devices.
    const starPoints = [[63, .12], [188, .39], [298, .1], [413, .24], [558, .07], [684, .34], [813, .13], [939, .28],
      [109, .67], [240, .8], [360, .55], [472, .73], [614, .52], [729, .81], [878, .62], [977, .84], [37, .91], [532, .95]];
    const starlets = starPoints.map(([x, fraction], index) => {
      const dot = svgElement("circle", {cx: x, cy: 0, r: index % 5 === 0 ? 1.25 : .7, fill: "currentColor"});
      stars.append(dot); return {dot, x, fraction};
    });
    const horizon = svgElement("path", {class: "topology-horizon", fill: "none"});
    const sea = svgElement("g", {class: "topology-waves"});
    const waves = Array.from({length: 5}, () => { const path = svgElement("path", {fill: "none"}); sea.append(path); return path; });
    const reflected = svgElement("g", {class: "topology-moon-reflection"});
    const reflections = Array.from({length: 10}, () => { const path = svgElement("path", {fill: "none"}); reflected.append(path); return path; });
    svg.append(stars, horizon, sea, reflected); backdrop.append(svg);
    return {element: backdrop, stars, starlets, horizon, waves, reflections};
  }
  function updateCosmos() {
    if (!scene?.cosmos || projection !== "3d" || !graph.clientWidth || !graph.clientHeight) return;
    const hub = positions.get("hub");
    if (!hub) return;
    const width = graph.clientWidth, height = graph.clientHeight;
    const moonX = hub.x * view.scale + view.x, moonY = hub.y * view.scale + view.y;
    // The horizon follows the fixed moon, not a percentage of the combined
    // sky and local scene: a tall exit catalog must not push exits into sea.
    const horizonY = moonY + Math.max(90, 105 * view.scale);
    graph.style.setProperty("--moon-x", `${moonX / width * 100}%`);
    graph.style.setProperty("--moon-y", `${moonY / height * 100}%`);
    graph.style.setProperty("--horizon-y", `${horizonY / height * 100}%`);
    const x = moonX / width * 1000, y = horizonY / height * 700;
    const parallaxX = Math.sin(camera.yaw - defaultCamera.yaw) * 14;
    const parallaxY = Math.sin(camera.pitch - defaultCamera.pitch) * 9;
    const {stars, starlets, horizon, waves, reflections} = scene.cosmos;
    stars.setAttribute("transform", `translate(${parallaxX} ${parallaxY})`);
    starlets.forEach(({dot, fraction}) => dot.setAttribute("cy", 14 + fraction * Math.max(0, y - 42)));
    horizon.setAttribute("d", `M 0 ${y + 3} Q 480 ${y - 3} 1000 ${y + 2}`);
    // Sparse, uneven ripples: never full-width, evenly stacked sea stripes.
    const ripples = [[.12, .21, 130], [.70, .13, 95], [.82, .58, 150], [.29, .72, 175], [.05, .94, 70]];
    waves.forEach((path, index) => {
      const [fraction, depth, span] = ripples[index], row = y + (700 - y) * depth;
      const start = fraction * 1000;
      path.setAttribute("d", `M ${start} ${row} q ${span * .48} ${-1 - depth} ${span} ${.5 + depth}`);
    });
    const glints = [[.06, 8, -3], [.095, 15, 11], [.19, 12, -8], [.25, 24, 18], [.33, 18, -13],
      [.43, 31, 4], [.52, 25, -20], [.65, 38, 14], [.78, 30, -8], [.92, 45, 24]];
    reflections.forEach((path, index) => {
      const [depth, half, drift] = glints[index], row = y + 8 + (700 - y - 18) * depth;
      path.setAttribute("d", `M ${x + drift - half} ${row} Q ${x + drift} ${row - 1.5} ${x + drift + half} ${row}`);
    });
  }
  function applyView(redrawEdges = false) {
    if (!scene) return;
    view.width = graph.clientWidth; view.height = graph.clientHeight;
    view.x = view.width / 2; view.y = (view.height + exitInset) / 2;
    scene.world.style.transform = `translate(${view.x}px, ${view.y}px)`;
    graph.dataset.viewportX = String(view.x);
    graph.dataset.viewportY = String(view.y);
    graph.dataset.viewportScale = "1";
    scene.moon?.render(camera.yaw, camera.pitch);
    // Distant light has a small, bounded parallax. Labels never orbit or move.
    exitRegion.style.setProperty("--far-x", `${Math.sin(camera.yaw - defaultCamera.yaw) * 8}px`);
    exitRegion.style.setProperty("--far-y", `${Math.sin(camera.pitch - defaultCamera.pitch) * 4}px`);
    updateCosmos();
    if (redrawEdges) {
      scene.spokes.forEach(drawSpoke); scene.edges.forEach(drawLink); drawExitLinks();
    }
  }
  function centerNode(id) {
    // Locate in the document, never move the scene or its fixed central VPS.
    objectElement(id)?.scrollIntoView({block: "nearest", inline: "nearest", behavior: "auto"});
  }
  function updateGeometry(id) {
    const position = positions.get(id), button = objectElement(id);
    if (!position || !button) return;
    button.style.left = `${position.x}px`; button.style.top = `${position.y}px`;
    button.dataset.worldX = String(position.x); button.dataset.worldY = String(position.y);
    const space = spacePositions.get(id);
    button.dataset.spaceX = String(space.x); button.dataset.spaceY = String(space.y); button.dataset.spaceZ = String(space.z || 0);
    button.dataset.cameraDepth = String(position.depth);
    button.style.setProperty("--topology-depth-index", String(position.depthIndex));
  }
  function drawSpoke(spoke) {
    const origin = positions.get(spoke.source), center = positions.get("hub");
    spoke.line.style.visibility = unresolvedConnection(spoke.source, "hub") ? "hidden" : "";
    const from = cardEdge(origin, center, spoke.source), to = cardEdge(center, origin, "hub");
    spoke.line.setAttribute("x1", from.x); spoke.line.setAttribute("y1", from.y);
    spoke.line.setAttribute("x2", to.x); spoke.line.setAttribute("y2", to.y);
  }
  function drawExitLinks() {
    // VPS stays fixed. Cache these DOM measurements rather than reading all
    // resource labels on every inertia frame. Exits never enter camera space.
    if (!exitGeometryDirty || !scene.exitLinks.length) return;
    exitGeometryDirty = false;
    const box = stage.getBoundingClientRect(), hub = scene.nodes.get("hub").getBoundingClientRect();
    stage.dataset.exitPlacement = "depth";
    exitDiagram.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    const center = {x: hub.left - box.left + hub.width / 2, y: hub.top - box.top + hub.height / 2};
    for (const edge of scene.exitLinks) {
      const item = scene.exits.get(edge.exitId).getBoundingClientRect();
      const target = {x: item.left - box.left + item.width / 2, y: item.top - box.top + item.height / 2};
      const dx = target.x - center.x, dy = target.y - center.y;
      const startFraction = 1 / Math.hypot(dx / (hub.width / 2 + 7), dy / (hub.height / 2 + 7));
      const endFraction = Math.min((item.width / 2 + 7) / Math.max(.01, Math.abs(dx)), (item.height / 2 + 7) / Math.max(.01, Math.abs(dy)));
      const start = {x: center.x + dx * startFraction, y: center.y + dy * startFraction};
      const end = {x: target.x - dx * endFraction, y: target.y - dy * endFraction};
      const bend = Math.min(36, Math.hypot(dx, dy) * .06) * Math.sign(dx);
      edge.line.setAttribute("d", `M ${start.x} ${start.y} Q ${(start.x + end.x) / 2 + bend} ${(start.y + end.y) / 2} ${end.x} ${end.y}`);
    }
  }
  function cardEdge(from, toward, id) {
    const size = nodeSize(id), dx = toward.x - from.x, dy = toward.y - from.y;
    if (Math.hypot(dx, dy) < .01) return {x: from.x, y: from.y};
    if (projection === "3d" && id === "hub") {
      const fraction = 1 / Math.hypot(dx / (size.width / 2 + 7), dy / (size.height / 2 + 7));
      return {x: from.x + dx * fraction, y: from.y + dy * fraction};
    }
    // Intersect the actual card, even when a nearby curve control point is
    // inside it; a midpoint cap would leave the arrow hidden under the card.
    const fraction = Math.min((size.width / 2 + 7) / Math.max(.01, Math.abs(dx)),
      (size.height / 2 + 7) / Math.max(.01, Math.abs(dy)));
    return {x: from.x + dx * fraction, y: from.y + dy * fraction};
  }
  function unresolvedConnection(source, target) {
    const from = positions.get(source), to = positions.get(target);
    const dx = Math.abs(from.x - to.x), dy = Math.abs(from.y - to.y);
    if (Math.hypot(dx, dy) < .01) return true;
    if (projection !== "3d") return false;
    const first = nodeSize(source), second = nodeSize(target);
    // A projected overlap has no visible gap for a meaningful endpoint. Keep
    // the configured link in the model/DOM, without drawing a reversed stub.
    return dx < (first.width + second.width) / 2 + 16 && dy < (first.height + second.height) / 2 + 16;
  }
  function drawLink(edge) {
    const start = positions.get(edge.source), end = positions.get(edge.target);
    edge.group.style.visibility = unresolvedConnection(edge.source, edge.target) ? "hidden" : "";
    if (projection === "3d") {
      // Clip first, then bend the visible gap. A control point halfway between
      // node centers can sit inside the large moon and reverse its arrowhead.
      const from = cardEdge(start, end, edge.source), to = cardEdge(end, start, edge.target);
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.max(1, Math.hypot(dx, dy));
      const bend = Math.min(24, length * .04);
      const cx = (from.x + to.x) / 2 - dy / length * bend;
      const cy = (from.y + to.y) / 2 + dx / length * bend;
      edge.path.setAttribute("d", `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`);
      return;
    }
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.max(1, Math.hypot(dx, dy));
    const bend = Math.min(36, length * .05);
    const cx = (start.x + end.x) / 2 - dy / length * bend;
    const cy = (start.y + end.y) / 2 + dx / length * bend;
    const from = cardEdge(start, {x: cx, y: cy}, edge.source), to = cardEdge(end, {x: cx, y: cy}, edge.target);
    edge.path.setAttribute("d", `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`);
  }
  function updateGraphFacts() {
    renderGalaxies();
    const matched = new Set(matchingNodes().map(node => node.id));
    const relations = new Map(snapshot.relations.map(relation => [relation.node.id, relation]));
    // Leaf-to-leaf permissions are shown on cards, without cross-canvas arrows.
    // Keep their scopes and highlights independent of the drawn hub edges.
    // Never turn a spoke or an unknown relation into access.
    const peers = new Map(displayMode === "relations"
      ? scene.links.map(link => [direction === "forward" ? link.target : link.source, link]) : []);
    // Route arrows show travel through the hub, not extra hub permissions.
    // A real hub-access arrow replaces its coincident spoke.
    const hubArrows = new Set(scene.edges.map(edge => edge.source === "hub" ? edge.target : edge.source));
    for (const spoke of scene.spokes) {
      const role = peers.has(spoke.source) ? "peer"
        : peers.size && spoke.source === snapshot.selected_id ? "selected" : "";
      spoke.line.classList.toggle("is-route", Boolean(role));
      spoke.line.classList.toggle("has-permission", hubArrows.has(spoke.source));
      if (role) spoke.line.dataset.topologyRoute = role;
      else delete spoke.line.dataset.topologyRoute;
      const flow = role ? ((direction === "forward" ? role === "selected" : role === "peer") ? "inbound" : "outbound") : null;
      if (flow) spoke.line.dataset.topologyFlow = flow;
      else delete spoke.line.dataset.topologyFlow;
      const terminal = !hubArrows.has(spoke.source) && flow === "outbound";
      // Spoke geometry runs leaf -> hub; marker-start points back to the leaf.
      // Forward ends at a peer; reverse ends at the current observation node.
      if (terminal) {
        spoke.line.setAttribute("marker-start", "url(#topology-flow-arrow-outbound)");
        spoke.line.dataset.topologyRouteEnd = spoke.source;
      } else {
        spoke.line.removeAttribute("marker-start");
        delete spoke.line.dataset.topologyRouteEnd;
      }
      const viaHub = !hubArrows.has(spoke.source) && flow === "inbound";
      if (viaHub) {
        spoke.line.setAttribute("marker-end", "url(#topology-flow-arrow-inbound)");
        spoke.line.dataset.topologyRouteVia = "hub";
      } else {
        spoke.line.removeAttribute("marker-end");
        delete spoke.line.dataset.topologyRouteVia;
      }
    }
    for (const node of snapshot.nodes) {
      const button = scene.nodes.get(node.id), chosen = displayMode === "relations" && node.id === snapshot.selected_id;
      const relation = relations.get(node.id);
      const peer = !chosen && peers.has(node.id);
      const scopes = peer ? peers.get(node.id).scopes : [];
      const scopeRole = direction === "forward" ? "当前节点可访问此节点" : "此节点可访问当前节点";
      const role = displayMode === "overview" ? "点击查看访问关系" : chosen ? "当前观察节点" : peer
        ? `${direction === "forward" ? "已授权目标" : "已授权来源"}，${relation?.[direction].label || "已授权"}`
        : relation?.label || "中心网关";
      const dragging = gesture?.type === "node" && gesture.moved && gesture.id === node.id;
      button.className = `topology-node kind-${node.kind} availability-${node.availability}${node.kind === "hub" ? " is-hub" : ""}${matched.has(node.id) ? " is-match" : ""}${peer ? " is-peer" : ""}${dragging ? " is-dragging" : ""}`;
      if (peer) button.dataset.topologyPeer = direction === "forward" ? "outbound" : "inbound";
      else delete button.dataset.topologyPeer;
      button.setAttribute("aria-pressed", String(chosen));
      const scopeText = scopes.length ? `。${scopeRole}：${scopes.join("；")}` : "";
      const accessibility = `${node.name}，${node.kind_label}，${addressLabel(node)}，${node.state}，${role}${scopeText}。${node.kind === "hub" ? "VPS 固定在画布中心。" : "可拖动调整布局。"}`;
      button.setAttribute("aria-label", accessibility);
      button.dataset.telemetryBaseLabel = accessibility;
      button.title = `${node.name} · ${node.kind_label}${node.address ? ` · ${node.address}` : ""} · ${node.state} · ${role}${scopeText}`;
      button.querySelector("strong").textContent = node.name;
      const kind = button.querySelector("[data-topology-node-kind]");
      kind.textContent = node.kind === "hub" ? "中心网关" : node.kind.toUpperCase();
      const address = button.querySelector("[data-topology-node-address]");
      const addressText = addressLabel(node);
      if (address.textContent !== addressText) {
        address.textContent = addressText;
        if (node.address.includes(":")) {
          // Prefer whole IPv6 groups at line breaks; text/copy stays unchanged.
          const groups = node.address.split(":");
          address.replaceChildren(...groups.flatMap((group, index) => index
            ? [document.createTextNode(":"), element("wbr"), document.createTextNode(group)]
            : [document.createTextNode(group)]));
        }
      }
      address.title = node.address ? `内网 IP：${node.address}` : addressLabel(node);
      button.querySelector(".topology-node-selected").hidden = !chosen || displayMode !== "relations";
      const peerMarker = button.querySelector(".topology-node-peer");
      peerMarker.hidden = !peer;
      peerMarker.textContent = peer ? direction === "forward" ? "目标" : "来源" : "";
      const ports = button.querySelector("[data-topology-node-ports]");
      ports.replaceChildren();
      ports.hidden = !scopes.length;
      ports.removeAttribute("title");
      ports.removeAttribute("aria-label");
      if (scopes.length) {
        ports.title = `${scopeRole}：${scopes.join("；")}`;
        ports.setAttribute("aria-label", ports.title);
        scopes.slice(0, 2).forEach(scope => {
          const line = element("span", "topology-node-port", compactScope(scope));
          line.dataset.topologyScope = scope;
          line.title = scope;
          ports.append(line);
        });
        if (scopes.length > 2) ports.append(element("span", "topology-node-ports-more", `另 ${scopes.length - 2} 项·见详情`));
      }
    }
    const related = new Set(scene.links.flatMap(link => [link.source, link.target]));
    for (const [id, button] of scene.nodes) button.classList.toggle("is-related", related.has(id));
    scene.world.dataset.mode = displayMode;
    const matchLabel = search.value.trim() ? ` · 搜索匹配 ${matched.size} 个` : "";
    const relationSummary = snapshot.selected_id === "hub" && direction === "forward"
      ? " · VPS 主动访问未检测" : ` · 当前方向 ${scene.links.length} 条授权`;
    root.querySelector("[data-topology-canvas-summary]").textContent = `全部 ${snapshot.nodes.length} 个节点（含 VPS），${snapshot.exits.length} 个出口${displayMode === "relations" ? relationSummary : " · 经 VPS 中转"}${matchLabel}`;
    findNext.disabled = !matched.size;
    root.dispatchEvent(new Event("node-telemetry-bind"));
    if (measureNodes()) {
      // Absolute far-field labels do not resize their parent. Repack after
      // font/viewport changes and same-ID renames, including long names.
      scheduleGraph();
      if (view.width) applyView(true);
    }
  }
  function renderGraph() {
    stage.dataset.hasExits = String(Boolean(snapshot.exits.length));
    exitRegion.hidden = !snapshot.exits.length;
    exitGeometryDirty = true;
    measureNodes();
    sizeCanvas();
    if (!graph.clientWidth || !graph.clientHeight) {
      if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(() => { layoutFrame = null; renderGraph(); });
      return;
    }
    if (gesture?.id && !spatialObjects().some(node => node.id === gesture.id)) cancelGesture();
    syncPositions();
    const links = directionalLinks();
    const key = JSON.stringify([snapshot.nodes.map(node => node.id), snapshot.exits, links, displayMode, direction, projection]);
    if (scene && drawingKey === key) {
      for (const id of positions.keys()) updateGeometry(id);
      updateGraphFacts(); applyView(true); return;
    }
    const focusedId = graph.contains(document.activeElement) ? document.activeElement.dataset.topologyObject : null;
    const world = element("div", "topology-world");
    world.setAttribute("data-topology-world", "");
    const diagram = svgElement("svg", {"aria-hidden": "true", focusable: "false"});
    const definitions = svgElement("defs", {});
    for (const flow of ["inbound", "outbound"]) {
      const arrow = svgElement("marker", {id: `topology-flow-arrow-${flow}`, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse"});
      arrow.append(svgElement("path", {d: "M 1 1 L 8 5 L 1 9", fill: "none", class: `topology-flow-arrow flow-${flow}`, "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round"}));
      definitions.append(arrow);
    }
    diagram.append(definitions);
    scene = {world, links, nodes: new Map(), exits: new Map(), exitLinks: [], edges: [], spokes: [], cosmos: projection === "3d" ? createCosmos() : null,
      incidents: new Map(snapshot.nodes.map(node => [node.id, new Set()]))};
    for (const node of snapshot.nodes) if (node.id !== "hub") {
      const line = svgElement("line", {class: `topology-spoke kind-${node.kind}`, "data-topology-spoke": "", "data-source": node.id, "data-target": "hub"});
      const spoke = {source: node.id, kind: node.kind, line}; scene.spokes.push(spoke); diagram.append(line); drawSpoke(spoke);
    }
    const pathsLayer = svgElement("g", {});
    diagram.append(pathsLayer);
    const nodeNames = new Map(snapshot.nodes.map(node => [node.id, node.name]));
    for (const link of links) {
      if (link.source !== "hub" && link.target !== "hub") continue;
      const linkKey = `${link.source}→${link.target}`;
      const group = svgElement("g", {class: "topology-link is-connected", "data-topology-link": "", "data-link-key": linkKey});
      const flow = link.target === "hub" ? "inbound" : "outbound";
      const path = svgElement("path", {class: "topology-edge", "data-topology-edge": "", "data-source": link.source, "data-target": link.target, "data-link-key": linkKey, "data-bidirectional": "false", "data-topology-flow": flow, "marker-end": `url(#topology-flow-arrow-${flow})`});
      const full = `${nodeNames.get(link.source)} → ${nodeNames.get(link.target)}：${link.label}`;
      const title = svgElement("title", {}); title.textContent = full;
      group.append(title, path); pathsLayer.append(group);
      const edge = {...link, group, path};
      scene.edges.push(edge); scene.incidents.get(link.source).add(edge); scene.incidents.get(link.target).add(edge); drawLink(edge);
    }
    world.append(diagram);
    for (const node of snapshot.nodes) {
      const button = element("button", "topology-node"); button.type = "button"; button.dataset.topologyNode = node.id;
      button.dataset.topologyObject = node.id;
      if (node.kind === "hub" && projection === "3d") {
        const moon = element("span", "topology-moon-disc"); moon.setAttribute("aria-hidden", "true");
        scene.moon = window.MoonsageLunarSurface?.create();
        if (scene.moon) moon.append(scene.moon.element);
        button.dataset.topologyShape = "moon"; button.append(moon);
      }
      const dot = element("span", "topology-node-dot"); dot.setAttribute("aria-hidden", "true");
      const ports = element("span", "topology-node-ports"); ports.dataset.topologyNodePorts = "";
      const selected = element("span", "topology-node-selected", "当前"); selected.setAttribute("aria-hidden", "true");
      const peer = element("span", "topology-node-peer"); peer.hidden = true; peer.setAttribute("aria-hidden", "true");
      const state = element("span", "topology-node-state"), kind = element("span"); kind.dataset.topologyNodeKind = ""; state.append(kind);
      button.append(dot, element("strong", "", node.name), state, selected, peer);
      const address = element("span", "topology-node-address"); address.dataset.topologyNodeAddress = "";
      if (node.kind === "hub") { kind.hidden = true; state.append(address); }
      else button.append(address);
      if (node.kind !== "hub") {
        button.dataset.telemetryNode = node.id; button.dataset.telemetryCompact = "true";
        const activity = element("span", "topology-node-activity"); activity.dataset.telemetryStatus = "";
        const label = element("span", "", "采样中"); label.dataset.telemetryStateLabel = ""; activity.append(label); state.append(activity);
        const rates = element("span", "node-telemetry-rates topology-node-rates", "↑— ↓—"); rates.dataset.telemetryRates = ""; button.append(rates);
      }
      button.append(ports);
      scene.nodes.set(node.id, button); world.append(button); updateGeometry(node.id);
    }
    const exitItems = [], exitLines = [];
    snapshot.exits.forEach((exit, index) => {
      const item = element("li", "topology-galaxy");
      item.dataset.topologyGalaxy = exit.id;
      const depth = .7 + (parseInt(exit.id.slice(-3), 16) % 4) * .1;
      item.style.setProperty("--exit-depth", String(depth));
      item.style.setProperty("--exit-symbol-width", `${82 + (parseInt(exit.id.slice(-2), 16) % 3) * 12}px`);
      const slot = exitLayout?.points.get(exit.id);
      if (slot) { item.style.left = `${slot.x}px`; item.style.top = `${slot.y}px`; }
      item.append(galaxySymbol(index), element("span", "topology-galaxy-name", exit.name), element("span", "topology-galaxy-state"));
      scene.exits.set(exit.id, item); exitItems.push(item);
      const line = svgElement("path", {class: "topology-exit-link", "data-topology-exit-link": exit.id, "data-source": "hub", "data-target": `exit:${exit.id}`});
      const title = svgElement("title", {}); title.textContent = `VPS · ${exit.name} · 出口配置关联，非实时流量`;
      line.append(title); exitLines.push(line); scene.exitLinks.push({exitId: exit.id, line});
    });
    exitList.replaceChildren(...exitItems); exitDiagram.replaceChildren(...exitLines);
    graph.replaceChildren(...(scene.cosmos ? [scene.cosmos.element, world] : [world]));
    if (snapshot.nodes.length === 1) graph.append(element("p", "topology-graph-empty", "尚无设备节点，可在节点列表中添加。"));
    drawingKey = key;
    updateGraphFacts();
    applyView(true);
    if (focusedId && objectElement(focusedId)) { restoringFocus = true; objectElement(focusedId).focus({preventScroll: true}); restoringFocus = false; }
  }
  function flushPointers() {
    pointerFrame = null;
    if (!scene) return;
    if (dirtyNodes.size) {
      // Depth ranks can change even when just one card moves. Project, paint
      // every card and redraw every line together, never in separate frames.
      projectPositions();
      for (const id of positions.keys()) updateGeometry(id);
      dirtyNodes.clear(); applyView(true); return;
    }
    applyView();
  }
  function schedulePointers() { if (pointerFrame === null) pointerFrame = requestAnimationFrame(flushPointers); }
  function stopInertia() {
    if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);
    inertiaFrame = null; inertia = null; graph.dataset.inertia = "idle";
  }
  function pointerTime(event) {
    const now = performance.now(), at = event.timeStamp;
    return Number.isFinite(at) && at >= 0 && at <= now + 1 && now - at < 1000 ? at : now;
  }
  function sampleOrbit(point, at = performance.now(), motion = gesture.motion) {
    const samples = motion.samples, last = samples[samples.length - 1];
    at = Math.max(at, last.at);
    const current = {x: point.x, pitch: camera.pitch, at};
    const deltaYaw = (current.x - last.x) * .006, deltaPitch = current.pitch - last.pitch;
    // A deliberate reversal must not fling the camera in its previous direction.
    if (deltaYaw * motion.yawVelocity + deltaPitch * motion.pitchVelocity < 0) samples.splice(0, samples.length - 1);
    if (at === last.at) samples[samples.length - 1] = current;
    else samples.push(current);
    const cutoff = at - inertiaLimits.sampleWindowMs;
    while (samples.length > 2 && samples[1].at <= cutoff) samples.shift();
    while (samples.length > 128) samples.shift();
    let first = samples[0];
    if (first.at < cutoff && samples.length > 1) {
      const next = samples[1], fraction = (cutoff - first.at) / (next.at - first.at);
      first = {x: first.x + (next.x - first.x) * fraction,
        pitch: first.pitch + (next.pitch - first.pitch) * fraction, at: cutoff};
    }
    const elapsed = at - first.at;
    if (elapsed > 0) {
      motion.yawVelocity = (current.x - first.x) * .006 / elapsed;
      motion.pitchVelocity = (current.pitch - first.pitch) / elapsed;
    } else motion.yawVelocity = motion.pitchVelocity = 0;
    Object.assign(motion, current);
  }
  function coastOrbit(now) {
    inertiaFrame = null;
    if (!inertia || gesture || document.hidden || reducedMotion.matches) { stopInertia(); return; }
    const elapsed = now - inertia.lastAt, duration = now - inertia.startedAt;
    // Do not jump after a stalled frame or keep a hidden page moving.
    if (elapsed > 150 || duration >= inertiaLimits.durationMs) { stopInertia(); return; }
    const decay = Math.exp(-Math.max(0, elapsed) / inertia.decayMs);
    const distance = inertia.decayMs * (1 - decay);
    const nextPitch = camera.pitch + inertia.pitchVelocity * distance;
    rotateCamera(camera.yaw + inertia.yawVelocity * distance, nextPitch);
    inertia.yawVelocity *= decay;
    inertia.pitchVelocity = Math.abs(camera.pitch - nextPitch) > 1e-9 ? 0 : inertia.pitchVelocity * decay;
    inertia.lastAt = now;
    flushPointers();
    if (Math.hypot(inertia.yawVelocity, inertia.pitchVelocity) < inertiaLimits.minSpeed) { stopInertia(); return; }
    inertiaFrame = requestAnimationFrame(coastOrbit);
  }
  function startInertia(released) {
    stopInertia();
    const now = performance.now(), motion = released?.motion;
    if (released?.type !== "orbit" || !released.moved || !motion || reducedMotion.matches || document.hidden ||
      nativeMultiTouch || pointers.size || (released.pointerType === "touch" && released.axis !== "yaw") ||
      now - motion.at > inertiaLimits.releaseIdleMs) return;
    // Include the release pause in the same window; holding still sheds momentum.
    sampleOrbit({x: motion.x}, now, motion);
    if (released.axis === "yaw") motion.pitchVelocity = 0;
    const speed = Math.hypot(motion.yawVelocity, motion.pitchVelocity);
    if (!Number.isFinite(speed) || speed < inertiaLimits.minSpeed) return;
    // Soft saturation preserves differences between ordinary and fast drags.
    // Faster releases also retain momentum longer, with a bounded final extent.
    const weight = speed / (speed + inertiaLimits.referenceSpeed);
    const limit = inertiaLimits.maxSpeed / (speed + inertiaLimits.referenceSpeed);
    if (speed * limit < inertiaLimits.minSpeed) return;
    const decayMs = inertiaLimits.minDecayMs + (inertiaLimits.maxDecayMs - inertiaLimits.minDecayMs) * weight;
    inertia = {yawVelocity: motion.yawVelocity * limit, pitchVelocity: motion.pitchVelocity * limit, decayMs, startedAt: now, lastAt: now};
    graph.dataset.inertia = "running";
    inertiaFrame = requestAnimationFrame(coastOrbit);
  }
  function scheduleGraph() {
    exitGeometryDirty = true;
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      if (!scene) { renderGraph(); return; }
      const sizeChanged = measureNodes();
      sizeCanvas();
      const width = graph.clientWidth, height = graph.clientHeight;
      if (!sizeChanged && width === view.width && height === view.height && (userAdjustedView || Math.abs(layoutAspect - measuredAspect()) < .01)) {
        drawExitLinks(); return;
      }
      stopInertia();
      if (!userAdjustedView) {
        // The first ResizeObserver notification can arrive after CSS settles
        // or an initial mobile viewport is applied. Only the untouched default
        // layout may adapt its aspect ratio; never replace a user's layout.
        syncPositions(true);
      } else projectPositions();
      for (const id of positions.keys()) dirtyNodes.add(id);
      flushPointers();
    });
  }
  function pointerPoint(event) {
    // Page scrolling moves the canvas, not the finger. Intent and drag deltas
    // use viewport coordinates so native scrolling cannot look like rotation.
    return {x: event.clientX, y: event.clientY};
  }
  function clearDraggingNodes() {
    for (const button of scene?.nodes.values() || []) button.classList.remove("is-dragging");
  }
  function cancelGesture() {
    stopInertia();
    clearDraggingNodes();
    const captured = [...pointers.keys()]; pointers.clear(); gesture = null; dirtyNodes.clear();
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    pointerFrame = null; graph.removeAttribute("data-dragging"); suppressClickUntil = performance.now() + 450;
    for (const id of captured) { try { graph.releasePointerCapture(id); } catch (_) { /* Already released. */ } }
  }
  function setLayoutEditing(enabled) {
    // Finish pending geometry before giving gestures back to the browser.
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    flushPointers();
    cancelGesture();
    layoutEditing = enabled;
    graph.dataset.layoutEditing = String(enabled);
    layoutEdit?.setAttribute("aria-pressed", String(enabled));
    if (layoutEdit) layoutEdit.textContent = enabled ? "完成移动" : "移动节点";
    syncProjectionControls();
  }
  function beginPointer(event) {
    stopInertia();
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const button = event.target.closest?.("[data-topology-object]");
    const id = button?.dataset.topologyObject;
    if (event.pointerType === "touch") {
      root.dataset.touchInput = "true";
      if (nativeMultiTouch) return;
    }
    const pending = event.pointerType === "touch" && !(layoutEditing && id && id !== "hub");
    const point = pointerPoint(event); pointers.set(event.pointerId, point);
    if (pointers.size >= 2) {
      // A second finger belongs to native page zoom, not a scene gesture.
      if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
      flushPointers(); cancelGesture(); return;
    }
    // A potential scroll/tap must not be captured, focused or canceled before
    // the finger establishes clear horizontal intent.
    if (!pending) {
      try { graph.setPointerCapture(event.pointerId); } catch (_) { /* A detached pointer can already be gone. */ }
      if (button) button.focus({preventScroll: true});
    } else suppressClickUntil = 0;
    const type = pending ? "pending" : id === "hub" ? "hub" : id ? "node" : "orbit";
    const at = pointerTime(event);
    gesture = {type, axis: event.pointerType === "touch" ? "yaw" : "free", id, selectId: button?.dataset.topologyNode, start: point, pointerType: event.pointerType,
      motion: {x: point.x, pitch: camera.pitch, at, yawVelocity: 0, pitchVelocity: 0,
        samples: [{x: point.x, pitch: camera.pitch, at}]},
      origin: pending || !id ? {yaw: camera.yaw, pitch: camera.pitch} : {...spacePositions.get(id)}, moved: false};
  }
  // Count fingers across the canvas, its toolbar and outside the widget. A
  // second finger always cancels manipulation and belongs to native zoom.
  window.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch") return;
    activeTouches.add(event.pointerId);
    if (activeTouches.size >= 2) {
      nativeMultiTouch = true;
      if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
      flushPointers(); cancelGesture();
    }
  }, {capture: true});
  graph.addEventListener("pointerdown", beginPointer);
  graph.addEventListener("pointermove", event => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    const point = pointerPoint(event); pointers.set(event.pointerId, point);
    const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
    if (gesture.type === "pending") {
      if (Math.hypot(dx, dy) < 10) return;
      // Ambiguous/vertical movement belongs to the page for this whole touch.
      // Never take over an already-started scroll when the finger turns later.
      if (Math.abs(dx) < Math.abs(dy) * 1.4) { cancelGesture(); return; }
      gesture.type = "orbit"; gesture.id = null; gesture.selectId = null;
      try { graph.setPointerCapture(event.pointerId); } catch (_) { /* Pointer already canceled by the browser. */ }
    }
    if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
    gesture.moved = true;
    if (gesture.type === "hub") return;
    userAdjustedView = true;
    if (gesture.type === "node") {
      if (!positions.has(gesture.id)) { cancelGesture(); return; }
      objectElement(gesture.id)?.classList.add("is-dragging");
      moveNode(gesture.id, gesture.origin, dx, dy);
    } else if (gesture.type === "orbit") {
      rotateCamera(gesture.origin.yaw + dx * .006, gesture.axis === "yaw" ? gesture.origin.pitch : gesture.origin.pitch - dy * .006);
      sampleOrbit(point, pointerTime(event));
    }
    graph.dataset.dragging = "true";
    schedulePointers(); event.preventDefault();
  });
  function finishPointer(event, canceled = false) {
    if (!pointers.has(event.pointerId)) return;
    const current = gesture; pointers.delete(event.pointerId);
    clearDraggingNodes();
    try { graph.releasePointerCapture(event.pointerId); } catch (_) { /* Safe after pointer cancellation. */ }
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    flushPointers();
    if (current?.type === "pending") {
      // Let the browser deliver a genuine tap as a normal click. A canceled
      // touch belongs to native scrolling/zoom and must never select or coast.
      gesture = null; suppressClickUntil = canceled ? performance.now() + 450 : 0;
      stopInertia(); return;
    }
    if (!canceled && current && !current.moved) {
      if (current.selectId) load(current.selectId);
      else if (current.type === "orbit") clearSelection();
    }
    suppressClickUntil = performance.now() + 450;
    gesture = null; graph.removeAttribute("data-dragging");
    if (canceled) stopInertia();
    else startInertia(current);
  }
  // Touch starts with implicit capture on its card. Transferring that capture
  // to the canvas must not mistake the card's bubbling loss for a canceled drag.
  graph.addEventListener("lostpointercapture", event => {
    if (event.target === graph && !graph.hasPointerCapture(event.pointerId)) finishPointer(event, true);
  });
  function releaseTouch(event) {
    activeTouches.delete(event.pointerId);
    if (!activeTouches.size) nativeMultiTouch = false;
  }
  window.addEventListener("pointerup", event => { releaseTouch(event); finishPointer(event); }, {capture: true});
  window.addEventListener("pointercancel", event => { releaseTouch(event); finishPointer(event, true); stopInertia(); }, {capture: true});
  graph.addEventListener("click", event => {
    if (event.button !== 0 || (event.detail !== 0 && performance.now() <= suppressClickUntil)) return;
    const button = event.target.closest?.("[data-topology-node]");
    if (button) load(button.dataset.topologyNode);
    else clearSelection();
  });
  function orbitKeydown(event) {
    if (event.ctrlKey || event.metaKey) return;
    const movement = {ArrowLeft: [-35, 0], ArrowRight: [35, 0], ArrowUp: [0, -35], ArrowDown: [0, 35]}[event.key];
    if (movement) {
      userAdjustedView = true;
      event.preventDefault(); const button = event.target.closest?.("[data-topology-object]");
      if (event.altKey && button) {
        const id = button.dataset.topologyObject, position = spacePositions.get(id);
        moveNode(id, position, movement[0], movement[1]);
      } else rotateCamera(camera.yaw + movement[0] * .006, camera.pitch - movement[1] * .006);
      flushPointers();
    }
  }
  graph.addEventListener("keydown", orbitKeydown);
  graph.addEventListener("focusin", event => {
    const id = event.target.dataset.topologyObject, position = positions.get(id);
    if (!position || pointers.size || restoringFocus) return;
    centerNode(id);
  });
  function scheduleConfig() {
    clearTimeout(configTimer);
    if (!configStopped && !document.hidden) configTimer = setTimeout(() => {
      configTimer = null;
      if (controller || pointers.size) scheduleConfig();
      else load(snapshot.selected_id, true, true);
    }, configInterval);
  }
  function applySnapshot(nextSnapshot, isRefresh, cachedAt = performance.now()) {
    if (JSON.stringify([snapshot.nodes, snapshot.links, snapshot.exits]) !== JSON.stringify([nextSnapshot.nodes, nextSnapshot.links, nextSnapshot.exits])) configCache.clear();
    const inventoryChanged = JSON.stringify(snapshot.nodes.map(node => node.id)) !== JSON.stringify(nextSnapshot.nodes.map(node => node.id));
    if (inventoryChanged && !userAdjustedView) spacePositions.clear();
    if (!isRefresh && nextSnapshot.selected_id === "hub" && (displayMode !== "relations" || snapshot.selected_id !== "hub")) direction = "reverse";
    snapshot = nextSnapshot;
    configCache.set(snapshot.selected_id, {snapshot, at: cachedAt});
    if (!isRefresh) displayMode = "relations";
    renderSelect(); renderDetails(); syncModeControls(); renderGraph();
  }
  async function load(id, isRefresh = false, background = false) {
    if (!id) return;
    if (!background) stopInertia();
    const cached = configCache.get(id);
    if (!isRefresh && cached && performance.now() - cached.at < configInterval) {
      if (controller && requestedId !== id) { controller.abort(); generation += 1; controller = null; requestedId = null; refresh.disabled = false; root.removeAttribute("aria-busy"); scheduleConfig(); }
      applySnapshot(cached.snapshot, false, cached.at);
      setStatus(directionHint());
      return;
    }
    if (controller) controller.abort();
    const thisGeneration = ++generation;
    controller = new AbortController();
    const activeController = controller;
    const signal = controller.signal;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      if (thisGeneration !== generation) return;
      timedOut = true;
      activeController.abort();
    }, 15000);
    requestedId = id;
    if (!background) {
      refresh.disabled = true;
      root.setAttribute("aria-busy", "true");
      setStatus(isRefresh ? "正在重新读取配置…" : "正在读取所选节点的访问关系…", "loading");
    }
    try {
      const url = new URL(form.action, window.location.href);
      url.searchParams.set("node", id);
      url.searchParams.set("format", "json");
      const response = await fetch(url.href, {method: "GET", credentials: "same-origin", cache: "no-store", headers: {Accept: "application/json"}, signal});
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("unavailable");
      const nextSnapshot = await response.json();
      if (!validSnapshot(nextSnapshot)) throw new Error("invalid-snapshot");
      if (thisGeneration !== generation || signal.aborted) return;
      applySnapshot(nextSnapshot, isRefresh);
      if (!background || status.dataset.state === "error") setStatus(displayMode === "relations" ? directionHint() : `已读取 ${snapshot.selected.name} 的配置关系。`);
    } catch (error) {
      if (thisGeneration !== generation || (signal.aborted && !timedOut)) return;
      syncSelection();
      setStatus(timedOut ? "读取超时，已保留上次显示的配置。请稍后刷新。" : "读取失败，已保留上次显示的配置。请稍后刷新；若登录已过期，请重新登录。", "error");
    } finally {
      window.clearTimeout(timeout);
      if (thisGeneration === generation) {
        controller = null;
        requestedId = null;
        refresh.disabled = false;
        root.removeAttribute("aria-busy");
        scheduleConfig();
      }
    }
  }

  root.querySelector("[data-topology-enhancement]").hidden = false;
  syncProjectionControls();
  if (navigator.maxTouchPoints > 0 || window.matchMedia("(any-pointer: coarse)").matches) root.dataset.touchInput = "true";
  graph.dataset.layoutEditing = "false";
  graph.dataset.inertia = "idle";
  // Fresh input always takes control; native page scrolling and zoom remain native.
  root.addEventListener("pointerdown", stopInertia, {capture: true});
  root.addEventListener("keydown", stopInertia, {capture: true});
  root.addEventListener("focusin", stopInertia);
  graph.addEventListener("wheel", stopInertia, {passive: true});
  const cancelMotion = () => {
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    flushPointers(); cancelGesture(); activeTouches.clear(); nativeMultiTouch = false;
  };
  window.addEventListener("blur", cancelMotion);
  if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", cancelMotion);
  else reducedMotion.addListener(cancelMotion);
  layoutEdit?.addEventListener("click", () => setLayoutEditing(!layoutEditing));
  root.addEventListener("keydown", event => {
    if (event.key === "Escape" && layoutEditing) {
      event.preventDefault(); setLayoutEditing(false); layoutEdit?.focus({preventScroll: true});
    }
  });
  root.querySelectorAll("[data-topology-enhanced-control]").forEach(control => { control.hidden = false; });
  root.querySelector("[data-topology-submit]").hidden = true;
  const fullDetails = root.querySelector("[data-topology-full-details]");
  if (fullDetails) fullDetails.open = false;
  refresh.hidden = false;
  form.addEventListener("submit", event => { event.preventDefault(); load(select.value); });
  select.addEventListener("change", () => load(select.value));
  refresh.addEventListener("click", () => load(snapshot.selected_id, true));
  function locateMatch(advance = false) {
    stopInertia();
    const matches = matchingNodes();
    searchIndex = matches.length ? (advance ? searchIndex + 1 : 0) % matches.length : 0;
    updateGraphFacts();
    if (matches.length) centerNode(matches[searchIndex].id, true);
  }
  search.addEventListener("input", () => locateMatch());
  search.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); locateMatch(true); } });
  findNext.addEventListener("click", () => locateMatch(true));
  root.querySelectorAll("[data-topology-mode]").forEach(button => button.addEventListener("click", () => setMode(button.dataset.topologyMode)));
  root.querySelectorAll("[data-topology-orbit]").forEach(button => button.addEventListener("click", () => {
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    flushPointers(); cancelGesture(); userAdjustedView = true;
    rotateCamera(defaultCamera.yaw, defaultCamera.pitch);
    flushPointers();
  }));
  root.querySelectorAll("[data-topology-direction]").forEach(button => button.addEventListener("click", () => {
    stopInertia();
    direction = button.dataset.topologyDirection;
    syncModeControls(); renderGraph(); setStatus(directionHint());
  }));
  root.querySelector("[data-topology-reset]").addEventListener("click", () => {
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    flushPointers(); cancelGesture(); userAdjustedView = false;
    measureNodes(); sizeCanvas();
    syncPositions(true);
    for (const id of positions.keys()) dirtyNodes.add(id);
    flushPointers(); setStatus("已自动重排全部节点，并恢复默认视角。VPS 固定居中。");
  });
  if ("ResizeObserver" in window) {
    const geometryObserver = new ResizeObserver(scheduleGraph);
    [graph, stage, exitRegion].forEach(target => geometryObserver.observe(target));
  }
  else window.addEventListener("resize", scheduleGraph);
  window.addEventListener("pagehide", () => {
    configStopped = true; clearTimeout(configTimer);
    generation += 1;
    if (controller) controller.abort();
    controller = null;
    requestedId = null;
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
    setLayoutEditing(false);
    activeTouches.clear(); nativeMultiTouch = false;
    refresh.disabled = false;
    root.removeAttribute("aria-busy");
    syncSelection();
    setStatus(displayMode === "relations" ? directionHint() : "全部节点都在图中。点击节点查看端口。");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelMotion();
      clearTimeout(configTimer); generation += 1; controller?.abort(); controller = null; requestedId = null;
      refresh.disabled = false; root.removeAttribute("aria-busy"); syncSelection();
    } else {
      const cached = configCache.get(snapshot.selected_id);
      if (!cached || performance.now() - cached.at >= configInterval) load(snapshot.selected_id, true, true);
      else scheduleConfig();
    }
  });
  window.addEventListener("pageshow", () => { configStopped = false; scheduleGraph(); scheduleConfig(); });
  renderObservedAt();
  renderSelect();
  syncModeControls();
  renderGraph();
  scheduleGraph();
  scheduleConfig();
})();
