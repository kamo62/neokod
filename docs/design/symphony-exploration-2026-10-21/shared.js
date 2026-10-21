/* Shared helpers for the Symphony layout prototypes: icons, theme, toast, status pills. */
(function () {
  "use strict";

  var THEME_KEY = "neokod-symphony-proto:theme";

  // 16px stroke icons, drawn for these prototypes.
  var ICONS = {
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    alert: '<path d="M8 2.5l6 11H2z"/><path d="M8 7v3"/><path d="M8 12h.01"/>',
    pause: '<path d="M6 4v8M10 4v8"/>',
    play: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
    search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
    branch:
      '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5v6M11 7c0 3-6 2-6 4"/>',
    commit: '<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>',
    folder: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
    chevronRight: '<path d="M6 3.5l4.5 4.5L6 12.5"/>',
    chevronDown: '<path d="M3.5 6l4.5 4.5L12.5 6"/>',
    chevronLeft: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
    moon: '<path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    reset: '<path d="M3 8a5 5 0 109-3"/><path d="M12 2v3H9"/>',
    edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
    history: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
    link: '<path d="M7 9l2-2"/><path d="M6 6.5L4.5 8a2.5 2.5 0 003.5 3.5L9.5 10"/><path d="M10 9.5L11.5 8A2.5 2.5 0 008 4.5L6.5 6"/>',
    agent:
      '<rect x="3" y="4.5" width="10" height="8" rx="2"/><path d="M8 2v2.5"/><path d="M6 8.5h.01M10 8.5h.01"/>',
    eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
    unlock:
      '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 014.8-1"/>',
    file: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
    question:
      '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 113 1.4c-.8.5-1.3.9-1.3 1.8"/><path d="M8 11.5h.01"/>',
    returned: '<path d="M6 3.5L2.5 7 6 10.5"/><path d="M3 7h6.5a4 4 0 010 8H8"/>',
    gate: '<path d="M3 14V3M13 14V3M3 6h10M3 10h10"/>',
    person: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5"/>',
    list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
    map: '<rect x="1.5" y="6" width="3.5" height="4" rx="1"/><rect x="11" y="2.5" width="3.5" height="4" rx="1"/><rect x="11" y="9.5" width="3.5" height="4" rx="1"/><path d="M5 8h2.5c1 0 1-3.5 3.5-3.5M7.5 8c1 0 1 3.5 3.5 3.5"/>',
    doc: '<path d="M3.5 2h9v12h-9z"/><path d="M5.5 5h5M5.5 8h5M5.5 11h3"/>',
    dot: '<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>',
    ring: '<circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>',
    circle: '<circle cx="8" cy="8" r="4.5"/>',
    orphan: '<circle cx="8" cy="8" r="5" stroke-dasharray="2.2 2"/><path d="M8 8h.01"/>',
    unknown:
      '<circle cx="8" cy="8" r="5.5" stroke-dasharray="1.5 1.8"/><path d="M6.6 6.6a1.5 1.5 0 112.3 1.2c-.6.4-.9.7-.9 1.4"/><path d="M8 11h.01"/>',
    superseded: '<circle cx="8" cy="8" r="5"/><path d="M4.5 11.5l7-7"/>',
    merged:
      '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="10" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 3 5 5.5 5"/>',
    skipped: '<path d="M3 8h10"/><path d="M10 5l3 3-3 3"/>',
  };

  function icon(name, cls) {
    var body = ICONS[name] || ICONS.circle;
    return (
      '<svg class="ic' +
      (cls ? " " + cls : "") +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      body +
      "</svg>"
    );
  }

  // One vocabulary for status pills. Colour never carries meaning alone.
  var STATUS = {
    needs: { icon: "alert", label: "Needs you", tone: "attn" },
    running: { icon: "ring", label: "Running", tone: "accent" },
    paused: { icon: "pause", label: "Paused", tone: "neutral" },
    queued: { icon: "circle", label: "Queued", tone: "quiet" },
    failed: { icon: "x", label: "Failed", tone: "danger" },
    orphaned: { icon: "orphan", label: "Tracking lost", tone: "orphan" },
    unknown: { icon: "unknown", label: "Unknown", tone: "quiet" },
    notrun: { icon: "circle", label: "Not run", tone: "quiet" },
    superseded: { icon: "superseded", label: "Superseded", tone: "quiet" },
    passed: { icon: "check", label: "Passed", tone: "ok" },
    done: { icon: "check", label: "Done", tone: "neutral" },
    merged: { icon: "merged", label: "Merged", tone: "merged" },
    cancelled: { icon: "stop", label: "Cancelled", tone: "quiet" },
    returned: { icon: "returned", label: "Sent back", tone: "neutral" },
    skipped: { icon: "skipped", label: "Skipped", tone: "quiet" },
    requested: { icon: "history", label: "Requested", tone: "neutral" },
    saved: { icon: "check", label: "Saved", tone: "neutral" },
    draft: { icon: "edit", label: "Draft", tone: "quiet" },
    locked: { icon: "lock", label: "Locked", tone: "quiet" },
  };

  function pill(status, text, extraClass) {
    var s = STATUS[status] || STATUS.unknown;
    return (
      '<span class="pill tone-' +
      s.tone +
      (extraClass ? " " + extraClass : "") +
      '">' +
      icon(s.icon) +
      "<span>" +
      esc(text || s.label) +
      "</span></span>"
    );
  }

  function glyph(status) {
    var s = STATUS[status] || STATUS.unknown;
    return (
      '<span class="glyph tone-' +
      s.tone +
      '" title="' +
      esc(s.label) +
      '">' +
      icon(s.icon) +
      "</span>"
    );
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function costText(cost) {
    return cost == null ? "Not reported" : cost;
  }

  /* Theme ------------------------------------------------------------- */
  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }
  function applyTheme(t) {
    document.documentElement.classList.toggle("dark", t === "dark");
    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      btn.setAttribute("aria-pressed", t === "dark" ? "true" : "false");
      btn.setAttribute(
        "aria-label",
        t === "dark" ? "Switch to light theme" : "Switch to dark theme",
      );
      btn.innerHTML = icon(t === "dark" ? "sun" : "moon");
    }
  }
  function currentTheme() {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }
  (function initTheme() {
    var t = storedTheme();
    if (!t)
      t =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.classList.toggle("dark", t === "dark");
  })();

  /* Toast (aria-live, no motion beyond a fade) ------------------------ */
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 4200);
  }

  /* Wire up shared chrome once the DOM is ready --------------------- */
  function onReady(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  onReady(function () {
    applyTheme(currentTheme());
    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      btn.addEventListener("click", function () {
        var next = currentTheme() === "dark" ? "light" : "dark";
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch (e) {}
        applyTheme(next);
      });
    }
    // static icon placeholders: <span data-ic="name"></span>
    var nodes = document.querySelectorAll("[data-ic]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].outerHTML = icon(
        nodes[i].getAttribute("data-ic"),
        nodes[i].getAttribute("data-ic-class"),
      );
    }
  });

  window.NK = {
    icon: icon,
    iconBody: function (name) {
      return ICONS[name] || ICONS.circle;
    },
    pill: pill,
    glyph: glyph,
    esc: esc,
    toast: toast,
    costText: costText,
    STATUS: STATUS,
    onReady: onReady,
    clone: function (o) {
      return JSON.parse(JSON.stringify(o));
    },
    runById: function (runs, id) {
      for (var i = 0; i < runs.length; i++) if (runs[i].id === id) return runs[i];
      return null;
    },
  };
})();
