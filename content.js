(function init() {
  const inIframe = window.top !== window;
  console.log("[ConsentX] content loaded", { href: location.href, inIframe });

  // Log page/frame load
  sendLog("page.load", { title: document.title, path: location.pathname, href: location.href });

  // Click handler (also pointer/keydown for robustness)
  const handler = (e) => {
    const el = findClickable(e.target);
    if (!el) return;

    const label = getLabel(el);
    // do NOT return if label is empty; many CMP buttons have no innerText

    const kind = classify(label, el); // pass element so we can use id/class
    if (!kind) return;

    sendLog("cmp.button.click", {
      label,
      kind,
      selector: shortCssPath(el),
      href: location.href,
      id: el.id || null,
      className: el.className || null
    });
  };

  window.addEventListener("click", handler, { capture: true });
  window.addEventListener("pointerup", handler, { capture: true });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    handler(e);
  }, { capture: true });

  // Detect dynamic banner insertion
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (looksLikeBanner(node)) {
          sendLog("cmp.banner.detected", {
            tag: node.tagName.toLowerCase(),
            classes: node.className || "",
            href: location.href
          });
        }
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();

/* ------------ helpers ------------ */

function sendLog(action, details, actor) {
  try {
    chrome.runtime.sendMessage({
      type: "log_event",
      site: location.origin,
      action,
      details,
      actor
    });
  } catch { /* ignore (some sandboxed frames) */ }
}

// Classify by visible text + id + class (handles Fides/OneTrust/etc.)
function classify(label, el) {
  const L = (label || "").toLowerCase();
  const id = (el?.id || "").toLowerCase();
  const cls = (el?.className || "").toLowerCase();

  if (/(accept|agree|allow|consent)/.test(L) || /(accept|agree|allow|consent)/.test(id) || /(accept|agree|allow|consent)/.test(cls))
    return "accept_like";

  if (/(reject|decline|deny|refuse|necessary|essential)/.test(L) || /(reject|decline|deny|refuse|necessary|essential)/.test(id) || /(reject|decline|deny|refuse|necessary|essential)/.test(cls))
    return "reject_like";

  if (/(settings|preferences|manage|customize|option)/.test(L) || /(settings|preferences|manage|customize|option)/.test(id) || /(settings|preferences|manage|customize|option)/.test(cls))
    return "settings_like";

  return null;
}

// Find clickable, including Shadow DOM
function findClickable(start) {
  const match = (n) => n && n instanceof Element &&
    n.matches('button,[role="button"],a,input[type="button"],input[type="submit"]');

  const path = (start && typeof start.composedPath === "function" ? start.composedPath() : null) || window._lastPath || null;
  if (path) for (const n of path) if (match(n)) return n;

  return start?.closest?.('button,[role="button"],a,input[type="button"],input[type="submit"]') || null;
}

// Capture composedPath for Shadow DOM-aware clicks
addEventListener("click", (e) => { window._lastPath = e.composedPath?.() || null; }, { capture: true });

function getLabel(el) {
  const text =
    (el.innerText && el.innerText.trim()) ||
    (el.value && String(el.value).trim()) ||
    (el.getAttribute("aria-label") || "").trim() ||
    (el.getAttribute("title") || "").trim();
  return (text || "").replace(/\s+/g, " ");
}

function shortCssPath(el) {
  try {
    const parts = [];
    let n = el;
    while (n && parts.length < 5) {
      let piece = n.nodeName.toLowerCase();
      if (n.id) { parts.unshift(`${piece}#${n.id}`); break; }
      const cls = (n.className || "").toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) piece += "." + cls.map((c) => CSS.escape(c)).join(".");
      parts.unshift(piece);
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null; // climb out of shadow roots
    }
    return parts.join(" > ");
  } catch { return ""; }
}

function looksLikeBanner(node) {
  const el = node instanceof HTMLElement ? node : null;
  if (!el) return false;
  const txt = (el.innerText || "").toLowerCase();
  return (
    /cookie|consent|privacy|preferences/.test(txt) ||
    el.id?.toLowerCase().includes("consent") ||
    el.className?.toLowerCase().includes("consent") ||
    el.getAttribute("role") === "dialog"
  );
}
