"use strict";

// Draft rules exist only in this page. Persistent facts are saved by root tasks.
(() => {
  const initialized = new WeakSet();
  function refreshRow(row) {
    const kind = row.dataset.ruleRow;
    const match = row.querySelector(`[name="${kind}_match"]`).value;
    const input = row.querySelector(`[name="${kind}_value"]`);
    input.placeholder = match === "cidr" ? "192.168.50.0/24" : "example.com";
    row.querySelector("[data-rule-value-label]").textContent = match === "cidr" ? "IP 网段" : "域名";
    const notice = row.querySelector("[data-rule-route-notice]");
    if (notice) {
      const route = row.querySelector('[name="dns_route"]').value;
      if (notice.dataset.route !== route) {
        const paths = {
          PROXY: ["设备 → 所选出口 → DNS", "跟随客户端 PROXY 选择。"],
          MID: ["设备 → VPS → DNS", "VPS 直出，不走出口节点。"],
          DIRECT: ["设备 → DNS", "不经过客户端代理。"],
        };
        notice.dataset.route = route;
        notice.querySelector("[data-rule-route-preview]").textContent = paths[route][0];
        notice.querySelector("[data-rule-route-help]").textContent = paths[route][1];
      }
      row.querySelector('[name="dns_servers"]').placeholder = route === "MID"
        ? "https://1.1.1.1/dns-query" : route === "DIRECT"
          ? "https://223.5.5.5/dns-query" : "https://8.8.8.8/dns-query";
    }
  }
  function refreshForm(form, dirty = true) {
    form.querySelectorAll("[data-rule-list]").forEach(list => {
      const rows = list.querySelectorAll("[data-rule-row]");
      list.querySelector("[data-rule-empty]")?.remove();
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "subscription-rule-empty";
        empty.dataset.ruleEmpty = "";
        empty.textContent = list.dataset.ruleList === "direct" ? "没有指定直连规则。" : "没有自定义 DNS 规则，其余域名沿用现有策略。";
        list.append(empty);
      }
      const add = form.querySelector(`[data-rule-add="${list.dataset.ruleList}"]`);
      if (form.getAttribute("aria-busy") !== "true") add.disabled = rows.length >= 128;
    });
    if (dirty) {
      form.dataset.rulesDirty = "true";
      form.querySelector("[data-rules-feedback]").textContent = "有未保存的修改；确认预览后统一生效。";
      if (form.getAttribute("aria-busy") !== "true") form.querySelector("[data-rules-save]").disabled = false;
    }
  }
  function initialize() {
    document.querySelectorAll("[data-rules-form]").forEach(form => {
      if (initialized.has(form)) return;
      initialized.add(form);
      form.querySelectorAll("[data-rule-add], [data-rule-remove]").forEach(button => { button.hidden = false; });
      form.querySelectorAll("[data-rule-row]").forEach(refreshRow);
      form.querySelector("[data-rules-save]").disabled = true;
      refreshForm(form, false);
    });
  }
  document.addEventListener("click", event => {
    const add = event.target.closest("[data-rule-add]");
    const remove = event.target.closest("[data-rule-remove]");
    const button = add || remove;
    if (!button || button.disabled) return;
    const form = button.closest("[data-rules-form]");
    if (!form || form.getAttribute("aria-busy") === "true") return;
    if (add) {
      const kind = add.dataset.ruleAdd;
      const list = form.querySelector(`[data-rule-list="${kind}"]`);
      if (list.querySelectorAll("[data-rule-row]").length >= 128) return;
      const template = form.closest("[data-subscription-rules]").querySelector(`[data-rule-template="${kind}"]`);
      const row = template.content.firstElementChild.cloneNode(true);
      row.querySelector("[data-rule-remove]").hidden = false;
      list.append(row);
      refreshRow(row);
      row.querySelector("input").focus();
    } else {
      const kind = remove.closest("[data-rule-row]").dataset.ruleRow;
      remove.closest("[data-rule-row]").remove();
      form.querySelector(`[data-rule-add="${kind}"]`).focus();
    }
    refreshForm(form);
    form.dispatchEvent(new Event("input", {bubbles: true}));
  });
  for (const name of ["input", "change"]) document.addEventListener(name, event => {
    const form = event.target.closest("[data-rules-form]");
    if (!form || form.getAttribute("aria-busy") === "true") return;
    const row = event.target.closest("[data-rule-row]");
    if (row) refreshRow(row);
    refreshForm(form);
  });
  document.addEventListener("server-kit:content-updated", initialize);
  document.addEventListener("server-kit:form-unlocked", event => {
    const form = event.detail?.form;
    if (form?.matches("[data-rules-form]")) refreshForm(form, form.dataset.rulesDirty === "true");
  });
  initialize();
})();
