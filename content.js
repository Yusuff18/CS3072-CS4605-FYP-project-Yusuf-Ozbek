// Content script: robust detect + signature hashing + learned storage + safe auto-apply (policy engine)
// Automation respects: learned signatures, per-site learning, drift detection, single visible target

chrome.storage.local.get('settings_v1', (obj) => {
  const enabled = obj?.settings_v1?.enabled ?? true;
  if (!enabled) {
    console.log('[ConsentX] disabled — content script idle');
    return;
  }
  initConsentX();
});

function initConsentX() {
  (function init() {
    const inIframe = window.top !== window;
    console.log("[ConsentX] content loaded", { href: location.href, inIframe });

    // Page/frame load
    sendLog("page.load", { title: document.title, path: location.pathname, href: location.href });

    // --- User click handler (logs + learns) ---
    const handler = (e) => {
      const el = findClickable(e.target);
      if (!el) return;

      const label = getLabel(el);
      const kind = classify(label, el);
      if (!kind) return;

      const bannerRoot = findBannerRoot(el) || document.body;
      const cmp = detectCMP(el) || null;
      const available = findAvailableKinds(bannerRoot);

      computeBannerSignature(bannerRoot, cmp, available).then((sig) => {
        const selector = shortCssPath(el);

        sendLog("cmp.button.click", {
          label,
          kind,
          selector,
          href: location.href,
          id: el.id || null,
          className: el.className || null,
          cmp,
          signatureHash: sig,
          availableKinds: available
        }, 'user');

        // Learn from user choice
        chrome.runtime.sendMessage({
          type: 'learn_signature',
          record: {
            signatureHash: sig,
            site: location.origin,
            cmp,
            decidedKind: kind,
            decidedBy: 'user',
            labelExample: label || null,
            selectorExample: selector || null
          }
        });
      });
    };

    window.addEventListener("click", handler, { capture: true });
    window.addEventListener("pointerup", handler, { capture: true });
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      handler(e);
    }, { capture: true });

    // --- MutationObserver for async banners ---
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (!node.isConnected) continue;
          scanNodeForBanner(node);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // --- Initial + delayed scans ---
    scheduleScans([0, 300, 1000, 2500, 4500, 7000]);
  })();
}

/* ---------------- Banner scanning & auto-apply ---------------- */

const _seenSignatures = new Set();
const _seenNodes = new WeakSet();

function scheduleScans(delays) { for (const d of delays) setTimeout(() => safeScan(), d); }
function safeScan() { try { scanEntireDocument(); } catch {} }

function scanEntireDocument() {
  const selectors = [
    '#onetrust-banner-sdk', '.ot-sdk-container', '.ot-sdk-row',
    '#sp_message_container_*, .sp_message_container', '.sp_veil', '.sp_choice_type_11',
    '.qc-cmp2-container', '#qc-cmp2-container',
    '.didomi-popup-container', '.didomi-consent-popup',
    '#cookie-law-info-bar', '.cookie-law-info-bar',
    '.cookiebanner', '#cookiebanner', '.cookie-banner', '#cookie-banner',
    '#cookieConsent', '.cookieConsent',
    '.consent', '#consent', '.consent-banner', '#consent-banner',
    '.gdpr', '#gdpr', '.gdpr-consent', '#gdpr-consent',
    '[role="dialog"]', '[aria-modal="true"]'
  ].join(',');

  const candidates = new Set();
  document.querySelectorAll(selectors).forEach(el => candidates.add(el));

  const containerGuess = Array.from(document.body.querySelectorAll('div,section,aside,dialog'))
    .slice(0, 400);
  for (const node of containerGuess) {
    if (_seenNodes.has(node)) continue;
    if (looksLikeBanner(node)) candidates.add(node);
  }
  for (const el of candidates) scanNodeForBanner(el);
}

function scanNodeForBanner(node) {
  if (!(node instanceof HTMLElement)) return;
  if (_seenNodes.has(node)) return;

  if (looksLikeBanner(node)) {
    const cmp = detectCMP(node) || null;
    const available = findAvailableKinds(node);

    computeBannerSignature(node, cmp, available).then((sig) => {
      if (_seenSignatures.has(sig)) return;
      _seenSignatures.add(sig);
      _seenNodes.add(node);

      sendLog("cmp.banner.detected", {
        tag: node.tagName.toLowerCase(),
        classes: node.className || "",
        href: location.href,
        cmp,
        signatureHash: sig,
        availableKinds: available
      });

      // === AUTO-APPLY DECISION ===
      chrome.runtime.sendMessage({
        type: 'policy_check',
        payload: {
          site: location.origin,
          cmp,
          signatureHash: sig,
          availableKinds: available
        }
      }, (resp) => {
        const decision = resp?.decision;
        if (!decision?.apply || !decision.decidedKind) return;

        const target = chooseTargetButton(node, decision.decidedKind);
        if (!target) {
          sendLog('policy.skip', { reason: 'no safe target', decidedKind: decision.decidedKind, signatureHash: sig }, 'auto');
          return;
        }

        try {
          target.click();

          const label = getLabel(target);
          const selector = shortCssPath(target);

          // Record the click (actor = auto)
          sendLog("cmp.button.click", {
            label,
            kind: decision.decidedKind,
            selector,
            href: location.href,
            cmp,
            signatureHash: sig,
            autoReason: decision.reason
          }, 'auto');

          // Learn (actor = auto) so future drift checks have context
          chrome.runtime.sendMessage({
            type: 'learn_signature',
            record: {
              signatureHash: sig,
              site: location.origin,
              cmp,
              decidedKind: decision.decidedKind,
              decidedBy: 'auto',
              labelExample: label || null,
              selectorExample: selector || null
            }
          });
        } catch (e) {
          sendLog('policy.skip', { reason: 'click threw', error: String(e), decidedKind: decision.decidedKind, signatureHash: sig }, 'auto');
        }
      });
    }).catch(() => {});
  }
}

// Choose a single visible, interactable target of decided kind
function chooseTargetButton(root, kind) {
  const btns = Array.from(root.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]'));
  const candidates = btns.filter((b) => classify(getLabel(b), b) === kind)
    .filter(isVisible)
    .filter(isInViewport);

  if (candidates.length !== 1) return null; // require exactly one to be safe
  return candidates[0];
}

function isVisible(el) {
  const style = window.getComputedStyle(el);
  return style && style.visibility !== 'hidden' && style.display !== 'none' && el.offsetParent !== null;
}
function isInViewport(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight);
}

/* ---------------- Signature helpers ---------------- */
function norm(str) { return (str || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function collectButtonLabels(root) {
  const labels = [];
  const btns = root.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]');
  for (const b of btns) { const t = getLabel(b); if (t) labels.push(norm(t)); }
  return labels.sort();
}
function extractBannerText(root) { const txt = norm(root.innerText || ""); return txt.slice(0, 2000); }
async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}
async function computeBannerSignature(root, cmp, availableKinds) {
  const text = extractBannerText(root);
  const btns = collectButtonLabels(root);
  const cmpNorm = (cmp || "").toLowerCase();
  const raw = JSON.stringify({ cmp: cmpNorm, text, btns, kinds: (availableKinds || []).slice().sort() });
  const full = await sha256(raw);
  return full.slice(0, 12);
}
function findBannerRoot(el) {
  let n = el;
  while (n && n !== document.body) {
    if (looksLikeBanner(n)) return n;
    n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  }
  return null;
}

/* ---------------- Utilities ---------------- */
function sendLog(action, details, actor) {
  try {
    chrome.runtime.sendMessage({ type: "log_event", site: location.origin, action, details, actor });
  } catch {}
}

function classify(label, el) {
  const L = (label || "").toLowerCase();
  const id = (el?.id || "").toLowerCase();
  const cls = (el?.className || "").toLowerCase();
  const has = (s) => new RegExp(s, 'i').test(L) || new RegExp(s, 'i').test(id) || new RegExp(s, 'i').test(cls);

  if (has('\\b(accept|agree|allow|consent|yes|okay|ok)\\b')) return "accept_like";
  if (has('\\b(reject|decline|deny|refuse|disagree|no)\\b') || has('\\b(necessary|essential only)\\b')) return "reject_like";
  if (has('\\b(settings|preferences|manage|customize|options|choices)\\b')) return "settings_like";
  return null;
}

function findClickable(start) {
  const match = (n) => n && n instanceof Element &&
    n.matches('button,[role="button"],a,input[type="button"],input[type="submit"]');
  const path = (start && typeof start.composedPath === "function" ? start.composedPath() : null) || window._lastPath || null;
  if (path) for (const n of path) if (match(n)) return n;
  return start?.closest?.('button,[role="button"],a,input[type="button"],input[type="submit"]') || null;
}
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
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }
    return parts.join(" > ");
  } catch { return ""; }
}

function looksLikeBanner(node) {
  const el = node instanceof HTMLElement ? node : null;
  if (!el) return false;

  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'dialog' || el.getAttribute('aria-modal') === 'true') {
    const t = (el.innerText || '').toLowerCase();
    if (/\bcookie|gdpr|consent|privacy|your privacy|privacy choices|do not sell|manage cookies/.test(t)) return true;
  }

  const txt = ((el.innerText || '').toLowerCase());
  if (/\bcookie|cookies|gdpr|consent|privacy|preferences|manage cookies|do not sell|privacy choices/.test(txt)) return true;

  const idc = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
  if (/(cookie|consent|gdpr|privacy|ot-)/.test(idc)) return true;

  if (el.matches?.('#onetrust-banner-sdk, .qc-cmp2-container, #qc-cmp2-container, .sp_message_container, .didomi-consent-popup, .didomi-popup-container')) return true;

  return false;
}

function detectCMP(el) {
  const hay = [
    el?.id, el?.className,
    document.documentElement?.className,
    document.documentElement?.id
  ].join(' ').toLowerCase();

  if (/fides|ethyca/.test(hay)) return 'fides';
  if (/onetrust|ot-/.test(hay)) return 'onetrust';
  if (/quantcast|qc-cmp|qc-cmp2/.test(hay)) return 'quantcast';
  if (/trustarc|truste/.test(hay)) return 'trustarc';
  if (/didomi/.test(hay)) return 'didomi';
  if (/iubenda/.test(hay)) return 'iubenda';
  if (/cookiebot|cybot/.test(hay)) return 'cookiebot';
  if (/sourcepoint|sp_(consent|choice)|sp_message_container/.test(hay)) return 'sourcepoint';
  if (/consentmanager|uc-cmp/.test(hay)) return 'consentmanager';
  if (/cookieyes|cky-/.test(hay)) return 'cookieyes';
  if (/osano|cookieconsent/.test(hay)) return 'osano';
  if (/klaro/.test(hay)) return 'klaro';
  if (/axeptio/.test(hay)) return 'axeptio';
  return null;
}

function findAvailableKinds(root) {
  const found = new Set();
  const btns = root.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]');
  for (const b of btns) {
    const k = classify(getLabel(b), b);
    if (k) found.add(k);
  }
  return Array.from(found);
}
