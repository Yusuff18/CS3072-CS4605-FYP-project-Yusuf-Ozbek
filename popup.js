document.addEventListener('DOMContentLoaded', () => {
  const els = {
    enabled:      document.getElementById('enabled'),
    autoApply:    document.getElementById('autoApply'),
    policyMode:   document.getElementById('policyMode'),
    siteLearning: document.getElementById('siteLearning'),
    siteMode:     document.getElementById('siteMode'),
    siteName:     document.getElementById('siteName'),
    modeHint:     document.getElementById('modeHint'),

    encountered:  document.getElementById('encountered'),
    autofilled:   document.getElementById('autofilled'),
    sites:        document.getElementById('sites'),
    kinds:        document.getElementById('kinds'),
    cmps:         document.getElementById('cmps'),

    filter:       document.getElementById('filter'),
    sitesList:    document.getElementById('sitesList'),
    sitesToggle:  document.getElementById('sitesToggle'),

    clear:        document.getElementById('clear'),
    overlay:      document.getElementById('disabledOverlay'),
    overlayEnable:document.getElementById('overlayEnable'),

    insightsOpen:   document.getElementById('insightsOpen'),
    insightsClose:  document.getElementById('insightsClose'),
    insightsDrawer: document.getElementById('insightsDrawer'),
    insightsDim:    document.getElementById('insightsDim'),
    insightsBody:   document.getElementById('insightsBody'),
  };

  // Events
  els.enabled?.addEventListener('change', onToggleEnabled);
  els.autoApply?.addEventListener('change', onGlobalChanged);
  els.policyMode?.addEventListener('change', onGlobalChanged);
  els.siteLearning?.addEventListener('change', onSiteChanged);
  els.siteMode?.addEventListener('change', onSiteChanged);
  els.filter?.addEventListener('input', debounce(renderSites, 120));
  els.clear?.addEventListener('click', clearLedger);
  els.sitesToggle?.addEventListener('click', toggleSitesLimit);
  els.overlayEnable?.addEventListener('click', enableExtension);

  els.insightsOpen?.addEventListener('click', () => toggleInsights(true));
  els.insightsClose?.addEventListener('click', () => toggleInsights(false));
  els.insightsDim?.addEventListener('click', () => toggleInsights(false));

  let currentOrigin = null;
  let showFullSites = false;

  init().catch(console.error);

  // Init
  async function init() {
    const [settings, ledger, origin] = await Promise.all([
      getSettings(),
      getLedger(),
      getCurrentOrigin()
    ]);

    currentOrigin = origin;

    if (els.siteName) {
      els.siteName.textContent = origin ? `This site: ${origin}` : 'This site: unknown';
    }

    if (els.enabled) els.enabled.checked = !!settings.enabled;
    if (els.autoApply) els.autoApply.checked = !!settings.autoApply;
    if (els.policyMode) els.policyMode.value = settings.policyMode || 'balanced';
    updateModeHint();

    const per = (settings.perSite && origin) ? (settings.perSite[origin] || {}) : {};
    if (els.siteLearning) els.siteLearning.checked = !!per.learning;
    if (els.siteMode) els.siteMode.value = per.mode || '';

    if (!origin) {
      els.siteLearning.disabled = true;
      els.siteMode.disabled = true;
    }

    if (!settings.enabled) showOverlay();
    else hideOverlay();

    const marketingCleared = ledger.filter(e => e.action === 'marketing.optin.cleared').length;
    const permPrompts = ledger.filter(e => e.action === 'permission.requested').length;

    if (els.marketingCleared) els.marketingCleared.textContent = String(marketingCleared);
    if (els.permPrompts) els.permPrompts.textContent = String(permPrompts);

    draw(ledger);
  }

  function updateModeHint() {
    if (!els.modeHint) return;

    const m = els.policyMode?.value;
    if (m === 'strict') els.modeHint.textContent = 'Prefers reject cookies';
    else if (m === 'balanced') els.modeHint.textContent = 'Rejects if possible, else accept';
    else els.modeHint.textContent = 'Prefers accept cookies';
  }

  // Render
  function draw(ledger) {
    const encountered = ledger.filter(e => e.action === 'cmp.banner.detected').length;

    const autoFilled = ledger.filter(e =>
      e.action === 'policy.auto.apply' ||
      (e.action === 'cmp.button.click' && e.actor === 'auto')
    ).length;

    const siteCounts = groupBySite(ledger.filter(e => e.action === 'cmp.banner.detected'));

    els.encountered.textContent = String(encountered);
    els.autofilled.textContent = String(autoFilled);
    els.sites.textContent = String(Object.keys(siteCounts).length);

    const accepted = ledger.filter(e => e.action === 'cmp.button.click' && e.details?.kind === 'accept_like').length;
    const rejected = ledger.filter(e => e.action === 'cmp.button.click' && e.details?.kind === 'reject_like').length;
    const adjusted = ledger.filter(e => e.action === 'cmp.button.click' && e.details?.kind === 'settings_like').length;

    const marketingDetected = ledger.filter(e => e.action === 'marketing.optin.detected').length;
    const marketingCleared  = ledger.filter(e => e.action === 'marketing.optin.cleared').length;
    const permissionReqs    = ledger.filter(e => e.action === 'permission.requested').length;

    renderChips(els.kinds, [
      ['Accepted', accepted],
      ['Rejected', rejected],
      ['Adjusted settings', adjusted],
      ['Marketing found', marketingDetected],
      ['Marketing cleared', marketingCleared],
      ['Permission prompts', permissionReqs]
    ]);

    const cmpCounts = countBy(
      ledger.filter(e => e.details?.cmp),
      e => niceCMP(e.details.cmp)
    );
    renderChips(els.cmps, topPairs(cmpCounts, 3));

    els._siteCounts = siteCounts;
    renderSites();

    renderInsights(ledger);
  }

  function renderSites() {
    if (!els.sitesList) return;

    const q = (els.filter && els.filter.value || '').toLowerCase();
    const siteCounts = els._siteCounts || {};

    let items = Object.entries(siteCounts)
      .map(([site, info]) => ({ site, count: info.count, last: info.last }))
      .filter(x => !q || x.site.toLowerCase().includes(q))
      .sort((a, b) => b.last - a.last);

    const limit = 5;
    const showing = showFullSites ? items : items.slice(0, limit);

    els.sitesList.innerHTML = '';

    if (!items.length) {
      const row = document.createElement('div');
      row.className = 'site-row';
      row.textContent = 'No sites yet.';
      els.sitesList.appendChild(row);
      return;
    }

    for (const it of showing) {
      const row = document.createElement('div');
      row.className = 'site-row';

      const left = document.createElement('div');
      left.className = 'site-left';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initialFor(it.site);

      const textWrap = document.createElement('div');

      const url = document.createElement('div');
      url.className = 'site-url';
      url.textContent = humanizeSite(it.site);

      const meta = document.createElement('div');
      meta.className = 'site-meta';
      meta.textContent = timeAgo(it.last);

      textWrap.appendChild(url);
      textWrap.appendChild(meta);

      const right = document.createElement('div');
      right.className = 'badge';
      right.textContent = (it.count === 1 ? '1 time' : `${it.count} times`);

      left.appendChild(avatar);
      left.appendChild(textWrap);

      row.appendChild(left);
      row.appendChild(right);

      els.sitesList.appendChild(row);
    }

    els.sitesToggle.textContent = showFullSites ? 'Show less…' : 'Show more…';
  }

  function toggleSitesLimit() {
    showFullSites = !showFullSites;
    renderSites();
  }

  // Insights
  function toggleInsights(open) {
    if (!els.insightsDrawer || !els.insightsDim) return;

    if (open) {
      els.insightsDrawer.classList.add('open');
      els.insightsDim.classList.add('show');
    } else {
      els.insightsDrawer.classList.remove('open');
      els.insightsDim.classList.remove('show');
    }
  }

  function renderInsights(ledger) {
    if (!els.insightsBody) return;

    const marketingDetected = ledger.filter(e => e.action === 'marketing.optin.detected');
    const marketingCleared  = ledger.filter(e => e.action === 'marketing.optin.cleared');
    const perms             = ledger.filter(e => e.action === 'permission.requested');

    const clicks  = ledger.filter(e => e.action === 'cmp.button.click');
    const auto    = clicks.filter(e => e.actor === 'auto');
    const detects = ledger.filter(e => e.action === 'cmp.banner.detected');

    const rejects  = clicks.filter(e => e.details?.kind === 'reject_like').length;
    const accepts  = clicks.filter(e => e.details?.kind === 'accept_like').length;
    const settings = clicks.filter(e => e.details?.kind === 'settings_like').length;
    const total    = clicks.length || 1;

    const cmpCounts = {};
    for (const e of ledger) {
      const id = e.details?.cmp;
      if (!id) continue;
      const label = niceCMP(id);
      cmpCounts[label] = (cmpCounts[label] || 0) + 1;
    }
    const cmpTop = Object.entries(cmpCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const siteCounts = {};
    for (const e of detects) {
      const s = e.site || 'unknown';
      siteCounts[s] = siteCounts[s] || { count: 0, last: 0 };
      siteCounts[s].count += 1;
      siteCounts[s].last = Math.max(siteCounts[s].last, e.ts || 0);
    }
    const siteTop = Object.entries(siteCounts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    const timeSavedSec = auto.length * 3;

    els.insightsBody.innerHTML = `
      <div class="ins-card">
        <h4>Banner activity</h4>
        <div class="kv"><span class="k">Total interactions</span><span>${clicks.length}</span></div>
        <div class="kv"><span class="k">Auto-filled</span><span>${auto.length}</span></div>
        <div class="kv"><span class="k">Banners detected</span><span>${detects.length}</span></div>
      </div>

      <div class="ins-card">
        <h4>Other prompts</h4>
        <div class="kv"><span class="k">Marketing opt-ins found</span><span>${marketingDetected.length}</span></div>
        <div class="kv"><span class="k">Marketing opt-ins cleared</span><span>${marketingCleared.length}</span></div>
        <div class="kv"><span class="k">Permission prompts detected</span><span>${perms.length}</span></div>
      </div>

      <div class="ins-card">
        <h4>Action ratio</h4>
        <div class="kv"><span class="k">Reject</span><span>${Math.round(rejects / total * 100)}%</span></div>
        <div class="kv"><span class="k">Accept</span><span>${Math.round(accepts / total * 100)}%</span></div>
        <div class="kv"><span class="k">Settings</span><span>${Math.round(settings / total * 100)}%</span></div>
      </div>

      <div class="ins-card">
        <h4>Top CMPs</h4>
        <ul class="ul-plain">
          ${cmpTop.length
            ? cmpTop.map(([k, v]) => `<li>${k} <span class="k">(${v})</span></li>`).join('')
            : '<li>None</li>'}
        </ul>
      </div>

      <div class="ins-card">
        <h4>Most persistent sites</h4>
        <ul class="ul-plain">
          ${siteTop.length
            ? siteTop.map(([s, info]) => `<li>${humanizeSite(s)} <span class="k">(${info.count})</span></li>`).join('')
            : '<li>None</li>'}
        </ul>
      </div>

      <div class="ins-card">
        <h4>Time saved (est.)</h4>
        <div class="kv"><span class="k">Auto-fills × 3s</span><span>≈ ${timeSavedSec}s</span></div>
      </div>
    `;
  }

  // Overlay
  function showOverlay() { els.overlay?.classList.remove('hidden'); }
  function hideOverlay() { els.overlay?.classList.add('hidden'); }

  // Settings
  async function onToggleEnabled() {
    const enabled = !!(els.enabled && els.enabled.checked);
    await setSettings({ enabled });
    enabled ? hideOverlay() : showOverlay();
  }

  async function onGlobalChanged() {
    const patch = {
      autoApply: !!(els.autoApply && els.autoApply.checked),
      policyMode: (els.policyMode && els.policyMode.value) || 'balanced'
    };
    updateModeHint();
    await setSettings(patch);
  }

  async function onSiteChanged() {
    if (!currentOrigin) return;

    const patch = {
      perSite: {
        [currentOrigin]: {
          learning: !!(els.siteLearning && els.siteLearning.checked),
          mode: (els.siteMode && els.siteMode.value) || undefined
        }
      }
    };

    await setSettings(patch);
  }

  // Messaging
  function getLedger() {
    return new Promise(res =>
      chrome.runtime.sendMessage({ type: 'get_ledger' }, r => res(r?.list || []))
    );
  }
  function getSettings() {
    return new Promise(res =>
      chrome.runtime.sendMessage({ type: 'get_settings' }, r => res(r?.settings || {}))
    );
  }
  function setSettings(patch) {
    return new Promise(res =>
      chrome.runtime.sendMessage({ type: 'set_settings', patch }, r => res(r?.settings))
    );
  }

  async function getCurrentOrigin() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return null;
      return new URL(tab.url).origin;
    } catch {
      return null;
    }
  }

  // Helpers
  function humanizeSite(origin) {
    try {
      const host = new URL(origin).hostname.replace(/^www\./, '');
      const first = host.split('.')[0].replace(/-/g, ' ');
      return first.replace(/\b\w/g, x => x.toUpperCase());
    } catch {
      return origin;
    }
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const s = diff / 1000;
    if (s < 60) return 'just now';
    const m = s / 60; if (m < 60) return `${m | 0} min ago`;
    const h = m / 60; if (h < 24) return `${h | 0}h ago`;
    const d = h / 24; if (d < 7) return `${d | 0}d ago`;
    return `${(d / 7) | 0}w ago`;
  }

  async function enableExtension() {
    await setSettings({ enabled: true });
    if (els.enabled) els.enabled.checked = true;
    hideOverlay();
  }

  function renderChips(ul, pairs) {
    ul.innerHTML = '';
    for (const [label, n] of pairs) {
      const li = document.createElement('li');
      li.innerHTML = `${label}<span class="muted">${n}</span>`;
      ul.appendChild(li);
    }
  }

  function niceCMP(id) {
    const map = {
      onetrust: 'OneTrust',
      sourcepoint: 'Sourcepoint',
      cookiebot: 'Cookiebot',
      quantcast: 'Quantcast',
      trustarc: 'TrustArc',
      didomi: 'Didomi',
      iubenda: 'Iubenda',
      fides: 'Fides',
      consentmanager: 'ConsentManager',
      cookieyes: 'CookieYes',
      osano: 'Osano',
      klaro: 'Klaro',
      axeptio: 'Axeptio'
    };
    return map[id] || (id ? (id[0].toUpperCase() + id.slice(1)) : 'Unknown');
  }

  function groupBySite(rows) {
    const out = {};
    for (const r of rows) {
      const s = r.site || 'unknown';
      if (!out[s]) out[s] = { count: 0, last: 0 };
      out[s].count += 1;
      out[s].last = Math.max(out[s].last, r.ts || 0);
    }
    return out;
  }

  function countBy(rows, keyFn) {
    const out = {};
    for (const r of rows) {
      const k = keyFn(r);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  function topPairs(obj, n) {
    return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  async function clearLedger() {
    if (!confirm('Reset all stats? This clears your on-device log.')) return;

    chrome.runtime.sendMessage({ type: 'clear_ledger', reason: 'popup-reset' }, async () => {
      const ledger = await getLedger();
      draw(ledger);
      alert('Stats reset. A backup copy was saved (ledger_backup_v1).');
    });
  }

  function initialFor(site) {
    try {
      const host = new URL(site).hostname || site;
      const letter = (host.replace(/^www\./, '')[0] || '?').toUpperCase();
      return /[A-Z0-9]/.test(letter) ? letter : '•';
    } catch {
      return '•';
    }
  }
});