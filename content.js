chrome.storage.local.get('settings_key', (obj) => {
  const enabled = obj?.settings_key?.enabled ?? true;
  if (!enabled) {
    console.log('[ConsentX] disabled — content script idle');
    return;
  }
  initConsentX();
});

function initConsentX() {
  (function init() {
    const inIframe = window.top !== window;
    window._consentXPageLoadTime = performance.now();
    console.log('[ConsentX] content loaded', { href: location.href, inIframe });
    sendLog('page.load', { title: document.title, path: location.pathname, href: location.href });

    installPermissionMonitors();

    // click handler
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
        const interactionTimeMs = parseFloat((performance.now() - (window._consentXPageLoadTime || 0)).toFixed(2));
        console.log('[ConsentX] button interaction at', interactionTimeMs, 'ms since page load');

        sendLog('cmp.button.click', {
          label,
          kind,
          selector,
          href: location.href,
          id: el.id || null,
          className: el.className || null,
          cmp,
          signatureHash: sig,
          availableKinds: available,
          interactionTimeMs
        }, 'user');

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

    window.addEventListener('click', handler, { capture: true });
    window.addEventListener('pointerup', handler, { capture: true });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      handler(e);
    }, { capture: true });

    // mutation observer
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

    // timed sweeps
    scheduleScans([0, 300, 1000, 2500, 4500, 7000]);
    scheduleMarketingScans([1200, 3000, 6000]);
  })();
}

// --- banner scanning ---

const _seenSignatures = new Set();
const _seenNodes = new WeakSet();

function scheduleScans(delays) {
  for (const d of delays) setTimeout(() => safeScan(), d);
}

function safeScan() {
  try { scanEntireDocument(); } catch {}
}

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

// --- button selection ---

function chooseTargetButton(root, kind) {
  const btns = Array.from(
    root.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]')
  );

  const candidates = btns
    .filter((b) => classify(getLabel(b), b) === kind)
    .filter(isVisible)
    .filter(isInViewport);

  if (candidates.length !== 1) return null;
  return candidates[0];
}

function isVisible(el) {
  const style = window.getComputedStyle(el);
  return style && style.visibility !== 'hidden' && style.display !== 'none' && el.offsetParent !== null;
}

function isInViewport(el) {
  const r = el.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.top >= 0 &&
    r.left >= 0 &&
    r.bottom <= (window.innerHeight || document.documentElement.clientHeight)
  );
}

// --- signature hashing ---

function norm(str) {
  return (str || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function collectButtonLabels(root) {
  const labels = [];
  const btns = root.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]');
  for (const b of btns) {
    const t = getLabel(b);
    if (t) labels.push(norm(t));
  }
  return labels.sort();
}

function extractBannerText(root) {
  const txt = norm(root.innerText || '');
  return txt.slice(0, 2000);
}

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeBannerSignature(root, cmp, availableKinds) {
  const text = extractBannerText(root);
  const btns = collectButtonLabels(root);
  const cmpNorm = (cmp || '').toLowerCase();
  const raw = JSON.stringify({
    cmp: cmpNorm,
    text,
    btns,
    kinds: (availableKinds || []).slice().sort()
  });

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

function sendLog(action, details, actor) {
  try {
    chrome.runtime.sendMessage({ type: 'log_event', site: location.origin, action, details, actor });
  } catch {}
}

// --- classification ---

function classify(label, el) {
  const L = (label || '').toLowerCase();
  const id = (el?.id || '').toLowerCase();
  const cls = (el?.className || '').toLowerCase();
  const has = (s) => new RegExp(s, 'i').test(L) || new RegExp(s, 'i').test(id) || new RegExp(s, 'i').test(cls);

  if (has('\\b(accept|agree|allow|consent|yes|okay|ok)\\b')) return 'accept_like';
  if (has('\\b(reject|decline|deny|refuse|disagree|no)\\b') || has('\\b(necessary|essential only)\\b')) return 'reject_like';
  if (has('\\b(settings|preferences|manage|customize|options|choices)\\b')) return 'settings_like';
  return null;
}

function findClickable(start) {
  const match = (n) =>
    n &&
    n instanceof Element &&
    n.matches('button,[role="button"],a,input[type="button"],input[type="submit"]');

  const path =
    (start && typeof start.composedPath === 'function' ? start.composedPath() : null) ||
    window._lastPath ||
    null;

  if (path) for (const n of path) if (match(n)) return n;

  return start?.closest?.('button,[role="button"],a,input[type="button"],input[type="submit"]') || null;
}

addEventListener('click', (e) => {
  window._lastPath = e.composedPath?.() || null;
}, { capture: true });

function getLabel(el) {
  const text =
    (el.innerText && el.innerText.trim()) ||
    (el.value && String(el.value).trim()) ||
    (el.getAttribute('aria-label') || '').trim() ||
    (el.getAttribute('title') || '').trim();
  return (text || '').replace(/\s+/g, ' ');
}

function shortCssPath(el) {
  try {
    const parts = [];
    let n = el;

    while (n && parts.length < 5) {
      let piece = n.nodeName.toLowerCase();

      if (n.id) {
        parts.unshift(`${piece}#${n.id}`);
        break;
      }

      const cls = (n.className || '')
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);

      if (cls.length) piece += '.' + cls.map((c) => CSS.escape(c)).join('.');
      parts.unshift(piece);

      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }

    return parts.join(' > ');
  } catch {
    return '';
  }
}

// --- banner detection heuristics ---

function looksLikeBanner(node) {
  const el = node instanceof HTMLElement ? node : null;
  if (!el) return false;

  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'dialog' || el.getAttribute('aria-modal') === 'true') {
    const t = (el.innerText || '').toLowerCase();
    if (/\bcookie|gdpr|consent|privacy|your privacy|privacy choices|do not sell|manage cookies/.test(t)) return true;
  }

  const txt = (el.innerText || '').toLowerCase();
  if (/\bcookie|cookies|gdpr|consent|privacy|preferences|manage cookies|do not sell|privacy choices/.test(txt)) return true;

  const idc = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
  if (/(cookie|consent|gdpr|privacy|ot-)/.test(idc)) return true;

  if (el.matches?.('#onetrust-banner-sdk, .qc-cmp2-container, #qc-cmp2-container, .sp_message_container, .didomi-consent-popup, .didomi-popup-container')) return true;

  return false;
}

// --- CMP detection ---

function detectCMP(el) {
  const hay = [
    el?.id,
    el?.className,
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

function scanNodeForBanner(node) {
  if (!(node instanceof HTMLElement)) return;
  if (_seenNodes.has(node)) return;
  if (!looksLikeBanner(node)) return;

  const cmp = detectCMP(node) || null;
  const available = findAvailableKinds(node);

  computeBannerSignature(node, cmp, available).then((sig) => {
    if (_seenSignatures.has(sig)) return;

    _seenSignatures.add(sig);
    _seenNodes.add(node);

    const detectionTimeMs = parseFloat((performance.now() - (window._consentXPageLoadTime || 0)).toFixed(2));
    console.log('[ConsentX] banner detected in', detectionTimeMs, 'ms');
    sendLog('cmp.banner.detected', {
      tag: node.tagName.toLowerCase(),
      classes: node.className || '',
      href: location.href,
      cmp,
      signatureHash: sig,
      availableKinds: available,
      detectionTimeMs
    });

    const bannerRoot = node;

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
      console.log('[ConsentX] policy decision received', decision);
      if (!decision?.apply || !decision.decidedKind) {
        if (decision?.reason === 'drift') {
          console.warn('[ConsentX] drift detected — automation paused', { signatureHash: sig, site: location.origin });
          if (typeof showConsentXToast === 'function') {
            showConsentXToast({
              title: 'ConsentX: Automation paused',
              sub: 'Consent banner has changed since your last visit.',
              meta: `Site: ${location.hostname} • Please review and re-consent manually.`,
            });
            sendLog('policy.drift.notified', {
              signatureHash: sig,
              site: location.origin,
              href: location.href
            }, 'auto');
          }
        }
        return;
      }

      const target = chooseTargetButton(bannerRoot, decision.decidedKind);
      if (!target) {
        sendLog('policy.skip', {
          reason: 'no safe target',
          decidedKind: decision.decidedKind,
          signatureHash: sig,
          href: location.href
        }, 'auto');
        return;
      }

      try {
        const automationTimeMs = parseFloat((performance.now() - (window._consentXPageLoadTime || 0)).toFixed(2));
        console.log('[ConsentX] automation applied in', automationTimeMs, 'ms since page load');
        target.click();

        const label = getLabel(target);
        const selector = shortCssPath(target);

        sendLog('cmp.button.click', {
          label,
          kind: decision.decidedKind,
          selector,
          href: location.href,
          cmp,
          signatureHash: sig,
          autoReason: decision.reason,
          automationTimeMs
        }, 'auto');

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

        if (typeof showConsentXToast === 'function' && typeof niceKind === 'function') {
          const decisionText = `${niceKind(decision.decidedKind)} applied`;
          const reasonText = decision.reason || 'policy decision';
          const cmpText = (cmp ? `CMP: ${cmp}` : 'CMP: unknown');

          showConsentXToast({
            title: `ConsentX: ${decisionText}`,
            sub: `Reason: ${reasonText}`,
            meta: `${cmpText} • Site: ${location.hostname}`,

            onUndo: async () => {
              const ok = (typeof attemptUndoViaSettings === 'function')
                ? await attemptUndoViaSettings(bannerRoot)
                : false;

              if (!ok) {
                sendLog('policy.undo.unavailable', {
                  reason: 'no unique settings button',
                  href: location.href,
                  signatureHash: sig
                }, 'user');

                try {
                  bannerRoot.style.outline = '3px solid rgba(59,130,246,.6)';
                  setTimeout(() => { bannerRoot.style.outline = ''; }, 1800);
                } catch {}
              }
            },

            onDisableSite: async () => {
              if (typeof disableAutomationOnThisSite === 'function') {
                await disableAutomationOnThisSite();
              }
              sendLog('policy.site.disabled', { site: location.origin, href: location.href }, 'user');
            }
          });
        }
      } catch (e) {
        sendLog('policy.skip', {
          reason: 'click threw',
          error: String(e),
          decidedKind: decision.decidedKind,
          signatureHash: sig,
          href: location.href
        }, 'auto');
      }
    });
  }).catch(() => {});
}

// --- settings bridge ---

function getSettings() {
  return new Promise((res) => {
    chrome.runtime.sendMessage({ type: 'get_settings' }, (r) => res(r?.settings || {}));
  });
}

function setSettings(patch) {
  return new Promise((res) => {
    chrome.runtime.sendMessage({ type: 'set_settings', patch }, (r) => res(r?.settings || {}));
  });
}

// --- toast ---

function niceKind(kind) {
  if (kind === 'accept_like') return 'Accept';
  if (kind === 'reject_like') return 'Reject';
  if (kind === 'settings_like') return 'Settings';
  return 'Action';
}

async function attemptUndoViaSettings(bannerRoot) {
  try {
    if (!bannerRoot || !(bannerRoot instanceof HTMLElement)) return false;

    const btns = Array.from(
      bannerRoot.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]')
    );

    const candidates = btns
      .filter((b) => classify(getLabel(b), b) === 'settings_like')
      .filter(isVisible);

    if (candidates.length !== 1) return false;

    candidates[0].click();
    return true;
  } catch {
    return false;
  }
}

async function disableAutomationOnThisSite() {
  const origin = location.origin;
  const patch = { perSite: { [origin]: { disabled: true } } };
  await setSettings(patch);
}

function ensureToastHost() {
  if (document.getElementById('consentx-toast-host')) return;

  const style = document.createElement('style');
  style.id = 'consentx-toast-style';
  style.textContent = `
    #consentx-toast-host{
      position:fixed;
      right:16px;
      bottom:16px;
      z-index:2147483647;
      font:13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif;
      color:#0f172a;
    }
    .cx-toast{
      width:320px;
      background:#ffffff;
      border:1px solid rgba(15,23,42,.12);
      border-radius:14px;
      box-shadow:0 12px 30px rgba(2,6,23,.18);
      padding:12px 12px 10px;
      overflow:hidden;
    }
    .cx-title{ font-weight:800; font-size:13px; margin:0 0 6px; }
    .cx-sub{ margin:0 0 6px; color:rgba(15,23,42,.78); }
    .cx-meta{ margin:0 0 10px; color:rgba(15,23,42,.55); font-size:12px; }
    .cx-actions{ display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
    .cx-btn{
      border:1px solid rgba(15,23,42,.14);
      background:#f8fafc;
      border-radius:999px;
      padding:6px 10px;
      cursor:pointer;
      font-weight:700;
      font-size:12px;
    }
    .cx-btn:hover{ background:#eef2ff; }
    .cx-btn.primary{
      border:none;
      background:linear-gradient(90deg,#22c55e,#16a34a);
      color:#fff;
    }
    .cx-btn.primary:hover{ filter:brightness(1.03); }
    .cx-btn.danger{
      border:none;
      background:#ef4444;
      color:#fff;
    }
    .cx-btn.danger:hover{ filter:brightness(1.02); }
  `;
  document.documentElement.appendChild(style);

  const host = document.createElement('div');
  host.id = 'consentx-toast-host';
  document.documentElement.appendChild(host);
}

function showConsentXToast({ title, sub, meta, onUndo, onDisableSite, primaryText, onPrimary }) {
  ensureToastHost();

  const host = document.getElementById('consentx-toast-host');
  host.innerHTML = '';

  const toast = document.createElement('div');
  toast.className = 'cx-toast';

  const t = document.createElement('div');
  t.className = 'cx-title';
  t.textContent = title || 'ConsentX';

  const s = document.createElement('p');
  s.className = 'cx-sub';
  s.textContent = sub || '';

  const m = document.createElement('p');
  m.className = 'cx-meta';
  m.textContent = meta || '';

  const actions = document.createElement('div');
  actions.className = 'cx-actions';

  if (typeof onPrimary === 'function') {
    const btn = document.createElement('button');
    btn.className = 'cx-btn primary';
    btn.textContent = primaryText || 'Apply';
    btn.addEventListener('click', async () => {
      try { await onPrimary(); } finally { host.innerHTML = ''; }
    });
    actions.appendChild(btn);
  }

  if (typeof onUndo === 'function') {
    const undo = document.createElement('button');
    undo.className = 'cx-btn';
    undo.textContent = 'Undo';
    undo.addEventListener('click', async () => {
      try { await onUndo(); } finally { host.innerHTML = ''; }
    });
    actions.appendChild(undo);
  }

  if (typeof onDisableSite === 'function') {
    const dis = document.createElement('button');
    dis.className = 'cx-btn danger';
    dis.textContent = 'Disable on this site';
    dis.addEventListener('click', async () => {
      try { await onDisableSite(); } finally { host.innerHTML = ''; }
    });
    actions.appendChild(dis);
  }

  const close = document.createElement('button');
  close.className = 'cx-btn';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => { host.innerHTML = ''; });
  actions.appendChild(close);

  toast.appendChild(t);
  if (sub) toast.appendChild(s);
  if (meta) toast.appendChild(m);
  toast.appendChild(actions);

  host.appendChild(toast);

  setTimeout(() => {
    if (host.contains(toast)) host.innerHTML = '';
  }, 8000);
}

// --- marketing opt-ins ---

let _marketingToastShown = false;

function scheduleMarketingScans(delays) {
  for (const d of delays) setTimeout(() => {
    try { scanMarketingOptIns(); } catch {}
  }, d);
}

function scanMarketingOptIns() {
  if (_marketingToastShown) return;

  const hits = findMarketingOptIns();
  if (!hits.length) return;

  sendLog('marketing.optin.detected', {
    href: location.href,
    count: hits.length,
    examples: hits.slice(0, 3).map(h => h.text)
  }, 'auto');

  const checked = hits.filter(h => h.checked);
  if (!checked.length) return;

  _marketingToastShown = true;

  showConsentXToast({
    title: 'ConsentX: Marketing opt-in found',
    sub: 'This page has optional marketing preferences (e.g., newsletters or promotions).',
    meta: `Site: ${location.hostname}`,
    primaryText: 'Uncheck marketing',
    onPrimary: async () => {
      const changed = uncheckMarketingOptIns(checked);
      sendLog('marketing.optin.cleared', { href: location.href, changed }, 'user');
    },
    onDisableSite: async () => {
      await disableAutomationOnThisSite();
      sendLog('policy.site.disabled', { site: location.origin, href: location.href }, 'user');
    }
  });
}

function looksLikeMarketingText(text) {
  const t = (text || '').toLowerCase();
  return /\b(marketing|newsletter|offers|promotions|promo|updates|email|sms|partner|third[- ]party|personalised|personalized)\b/.test(t);
}

function labelTextForInput(input) {
  try {
    const id = input.getAttribute('id');
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab && lab.innerText) return lab.innerText.trim();
    }

    const parentLabel = input.closest('label');
    if (parentLabel && parentLabel.innerText) return parentLabel.innerText.trim();

    const wrap = input.closest('div,li,p,section,form') || input.parentElement;
    return wrap?.innerText ? wrap.innerText.trim() : '';
  } catch {
    return '';
  }
}

function findMarketingOptIns() {
  const out = [];
  const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]'));

  for (const inp of inputs) {
    if (!inp.isConnected) continue;
    if (!isVisible(inp)) continue;

    const text = labelTextForInput(inp);
    if (!looksLikeMarketingText(text)) continue;

    out.push({
      el: inp,
      checked: !!inp.checked,
      text: (text || '').slice(0, 110)
    });
  }

  out.sort((a, b) => (b.checked - a.checked));
  return out;
}

function uncheckMarketingOptIns(list) {
  let changed = 0;

  for (const it of list) {
    const el = it.el;
    if (!el || !el.isConnected) continue;

    if (el.checked) {
      el.click();
      changed++;
    }
  }

  return changed;
}

// --- permission monitors ---

let _permToastShown = false;

function installPermissionMonitors() {
  // notifications
  try {
    if (window.Notification && typeof Notification.requestPermission === 'function') {
      const orig = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = async function (...args) {
        onPermissionRequested('notifications');
        return orig(...args);
      };
    }
  } catch {}

  // geolocation
  try {
    const geo = navigator.geolocation;
    if (geo) {
      const origGet = geo.getCurrentPosition?.bind(geo);
      const origWatch = geo.watchPosition?.bind(geo);

      if (origGet) {
        geo.getCurrentPosition = function (...args) {
          onPermissionRequested('location');
          return origGet(...args);
        };
      }

      if (origWatch) {
        geo.watchPosition = function (...args) {
          onPermissionRequested('location (watch)');
          return origWatch(...args);
        };
      }
    }
  } catch {}

  // camera/mic
  try {
    const md = navigator.mediaDevices;
    if (md && typeof md.getUserMedia === 'function') {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async function (constraints) {
        onPermissionRequested('camera/microphone');
        return orig(constraints);
      };
    }
  } catch {}
}

function onPermissionRequested(kind) {
  sendLog('permission.requested', { kind, href: location.href }, 'auto');

  if (_permToastShown) return;
  _permToastShown = true;

  showConsentXToast({
    title: 'ConsentX: Permission request detected',
    sub: `This site requested ${kind} permission. This prompt is controlled by the browser.`,
    meta: `Site: ${location.hostname}`,
    onDisableSite: async () => {
      await disableAutomationOnThisSite();
      sendLog('policy.site.disabled', { site: location.origin, href: location.href }, 'user');
    }
  });
}