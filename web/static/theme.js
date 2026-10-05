"use strict";

(() => {
  const storageKey = "server-kit-theme";
  const defaultTheme = "dark";
  const themes = new Set(["light", "dark"]);
  const themeColors = {
    light: "#f0f6f8",
    dark: "#101d27",
  };

  function readTheme() {
    let saved;
    try {
      saved = window.localStorage.getItem(storageKey);
    } catch (_error) {
      return defaultTheme;
    }
    if (saved === "sky") {
      // Keep an explicit choice of the former sky palette in light mode.
      try {
        window.localStorage.setItem(storageKey, "light");
      } catch (_error) {
        // A read-only store must not discard the user's previous choice.
      }
      return "light";
    }
    return themes.has(saved) ? saved : defaultTheme;
  }

  function applyTheme(theme, persist = false) {
    const selected = themes.has(theme) ? theme : defaultTheme;
    document.documentElement.dataset.theme = selected;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute("content", themeColors[selected]);
    document.querySelectorAll("[data-theme-value]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeValue === selected));
    });
    if (persist) {
      try {
        window.localStorage.setItem(storageKey, selected);
      } catch (_error) {
        // 浏览器禁用本地存储时，主题仍对当前页面生效。
      }
    }
  }

  applyTheme(readTheme());

  function bindThemePicker() {
    applyTheme(readTheme());
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-theme-value]");
      if (!button) return;
      applyTheme(button.dataset.themeValue, true);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindThemePicker, {once: true});
  } else {
    bindThemePicker();
  }
})();
