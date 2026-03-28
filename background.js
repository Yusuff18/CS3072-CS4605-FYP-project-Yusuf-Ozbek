const LEDGER_KEY = 'ledger_key';
const SETTINGS_KEY = 'settings_key';
const LEARNED_KEY = 'learned_signature';
const LEDGER_BACKUP_KEY = 'ledger_backup_v1';
const SITE_HASHES_KEY = 'site_hashes_v1';

const defaultSettings = {
  enabled: true,
  policyMode: 'balanced',
  autoApply: true,
  perSite: {}
};

console.log('[SW] loaded');
chrome.runtime.onInstalled.addListener(() => {
  console.log('[SW] installed');
});

// storage helpers

async function getLedger() {
  const obj = await chrome.storage.local.get(LEDGER_KEY);
  return Array.isArray(obj[LEDGER_KEY]) ? obj[LEDGER_KEY] : [];
}

async function setLedger(list) {
  await chrome.storage.local.set({ [LEDGER_KEY]: list });
}

async function getSettings() {
  const obj = await chrome.storage.local.get(SETTINGS_KEY);
  const cur = obj[SETTINGS_KEY] ?? defaultSettings;

  const merged = {
    ...defaultSettings,
    ...cur,
    perSite: { ...(cur.perSite || {}) }
  };

  if (JSON.stringify(merged) !== JSON.stringify(cur)) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  }

  return merged;
}

async function setSettings(next) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function getLearnedMap() {
  const obj = await chrome.storage.local.get(LEARNED_KEY);
  return obj[LEARNED_KEY] || {};
}

async function setLearnedMap(map) {
  await chrome.storage.local.set({ [LEARNED_KEY]: map });
}

// site hash registering 

async function getSiteHashes() {
  const obj = await chrome.storage.local.get(SITE_HASHES_KEY);
  return obj[SITE_HASHES_KEY] || {};
}

async function setSiteHashes(map) {
  await chrome.storage.local.set({ [SITE_HASHES_KEY]: map });
}

async function registerSiteHash(site, signatureHash) {
  const map = await getSiteHashes();
  if (!map[site]) map[site] = [];
  if (!map[site].includes(signatureHash)) {
    map[site].push(signatureHash);
    await setSiteHashes(map);
  }
}

async function hashIsKnownForSite(site, signatureHash) {
  const map = await getSiteHashes();
  return Array.isArray(map[site]) && map[site].includes(signatureHash);
}

async function siteHasKnownHashes(site) {
  const map = await getSiteHashes();
  return Array.isArray(map[site]) && map[site].length > 0;
}

// ledger for contextual info

async function logEvent(site, action, details = {}, actor = 'user') {
  const entry = {
    id: cryptoRandomId(),
    site,
    ts: Date.now(),
    actor,
    action,
    details
  };

  const list = await getLedger();
  list.push(entry);

  await setLedger(list.length > 5000 ? list.slice(-5000) : list);
  return entry;
}

async function tryRestoreLedgerIfEmpty() {
  const current = await getLedger();
  if (current.length) return false;

  const obj = await chrome.storage.local.get([LEDGER_BACKUP_KEY]);
  const backup = obj[LEDGER_BACKUP_KEY] || [];
  if (!backup.length) return false;

  await setLedger(backup);
  return true;
}

// utilities 

function originFromUrl(url) {
  try { return new URL(url).origin; } catch { return 'unknown'; }
}

function cryptoRandomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}

function setBadgeSafe(tabId, text, color = '#4f46e5', clearAfterMs = 0) {
  if (tabId == null) return;

  chrome.tabs.get(tabId).then(() => {
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});

    if (clearAfterMs > 0) {
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      }, clearAfterMs);
    }
  }).catch(() => {});
}

// signature learning

async function learnSignature(record) {
  if (!record?.signatureHash || !record.decidedKind) return null;

  const map = await getLearnedMap();
  const prev = map[record.signatureHash];

  const merged = prev ? {
    ...prev,
    cmp: record.cmp ?? prev.cmp ?? null,
    decidedKind: record.decidedKind,
    decidedBy: record.decidedBy || prev.decidedBy || 'user',
    site: record.site || prev.site,
    labelExample: record.labelExample || prev.labelExample,
    selectorExample: record.selectorExample || prev.selectorExample,
    seenCount: (prev.seenCount || 0) + 1,
    lastSeen: Date.now()
  } : {
    signatureHash: record.signatureHash,
    cmp: record.cmp ?? null,
    site: record.site,
    decidedKind: record.decidedKind,
    decidedBy: record.decidedBy || 'user',
    labelExample: record.labelExample || null,
    selectorExample: record.selectorExample || null,
    seenCount: 1,
    lastSeen: Date.now()
  };

  map[record.signatureHash] = merged;
  await setLearnedMap(map);

  if (record.site) {
    await registerSiteHash(record.site, record.signatureHash);
  }

  await logEvent(
    record.site || 'unknown',
    'policy.learned',
    {
      signatureHash: record.signatureHash,
      decidedKind: merged.decidedKind,
      seenCount: merged.seenCount
    },
    merged.decidedBy === 'auto' ? 'auto' : 'user'
  );

  return merged;
}

// policy

function chooseDefaultByMode(mode, availableKinds = []) {
  const has = k => availableKinds.includes(k);

  if (mode === 'strict') {
    return has('reject_like') ? 'reject_like'
         : has('settings_like') ? 'settings_like'
         : has('accept_like') ? 'accept_like'
         : null;
  }

  if (mode === 'allow') {
    return has('accept_like') ? 'accept_like'
         : has('settings_like') ? 'settings_like'
         : has('reject_like') ? 'reject_like'
         : null;
  }

  if (has('reject_like')) return 'reject_like';
  if (has('accept_like')) return 'accept_like';
  if (has('settings_like')) return 'settings_like';
  return null;
}

function safeMatchSignature(learned, incoming) {
  if (!learned || !incoming) return { ok: false };
  if (learned.signatureHash !== incoming.signatureHash) return { ok: false };
  if (learned.cmp && incoming.cmp && learned.cmp !== incoming.cmp) return { ok: false };
  if (!incoming.availableKinds?.includes(learned.decidedKind)) return { ok: false };
  return { ok: true };
}

async function decidePolicy({ site, cmp, signatureHash, availableKinds }) {
  const settings = await getSettings();

  if (!settings.enabled || !settings.autoApply) {
    return { apply: false, decidedKind: null, reason: 'disabled' };
  }

  const siteCfg = settings.perSite?.[site] || {};
  if (siteCfg.disabled === true) {
    return { apply: false, decidedKind: null, reason: 'site disabled' };
  }

  const learnedMap = await getLearnedMap();
  const learned = learnedMap[signatureHash];
  const mode = siteCfg.mode || settings.policyMode;

  if (learned) {
    const safe = safeMatchSignature(learned, { signatureHash, cmp, availableKinds });
    if (safe.ok) {
      return { apply: true, decidedKind: learned.decidedKind, reason: 'learned' };
    }
    return { apply: false, decidedKind: null, reason: 'drift' };
  }

  if (siteCfg.learning !== true) {
    return { apply: false, decidedKind: null, reason: 'learning disabled' };
  }

  const fallback = chooseDefaultByMode(mode, availableKinds || []);
  if (fallback) {
    return { apply: true, decidedKind: fallback, reason: 'default' };
  }

  return { apply: false, decidedKind: null, reason: 'no action' };
}

// message bus to handle incoming messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ping') {
    sendResponse({ pong: true });
    return true;
  }

  if (msg.type === 'log_event') {
    const site = msg.site || (sender?.tab?.url ? originFromUrl(sender.tab.url) : 'unknown');
    logEvent(site, msg.action, msg.details, msg.actor).then(entry => {
      if (sender?.tab?.id != null) setBadgeSafe(sender.tab.id, '•', '#4f46e5', 3000);
      sendResponse({ ok: true, entry });
    });
    return true;
  }

  if (msg.type === 'get_ledger') {
    (async () => {
      await tryRestoreLedgerIfEmpty();
      sendResponse({ ok: true, list: await getLedger() });
    })();
    return true;
  }

  if (msg.type === 'clear_ledger') {
    (async () => {
      await chrome.storage.local.set({
        [LEDGER_KEY]: [],
        last_clear_ledger: { ts: Date.now(), reason: msg.reason || 'manual' }
      });
      await chrome.storage.local.remove([LEDGER_BACKUP_KEY, LEARNED_KEY, SITE_HASHES_KEY]);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'get_settings') {
    (async () => {
      sendResponse({ ok: true, settings: await getSettings() });
    })();
    return true;
  }

  if (msg.type === 'set_settings') {
    (async () => {
      const prev = await getSettings();
      const next = {
        ...prev,
        ...(msg.patch || {}),
        perSite: { ...(prev.perSite || {}), ...(msg.patch?.perSite || {}) }
      };
      await setSettings(next);
      chrome.action.setBadgeText({ text: next.enabled ? '' : '⏸' }).catch(() => {});
      sendResponse({ ok: true, settings: next });
    })();
    return true;
  }

  if (msg.type === 'learn_signature') {
    (async () => {
      const rec = await learnSignature(msg.record);
      sendResponse({ ok: !!rec, record: rec });
    })();
    return true;
  }

  if (msg.type === 'get_learned') {
    (async () => {
      sendResponse({ ok: true, learned: await getLearnedMap() });
    })();
    return true;
  }

  if (msg.type === 'policy_check') {
    (async () => {
      const payload = msg.payload || {};
      const decision = await decidePolicy(payload);

      await logEvent(
        payload.site,
        decision.apply ? 'policy.auto.apply' : 'policy.skip',
        { ...payload, decidedKind: decision.decidedKind, reason: decision.reason },
        'auto'
      );

      sendResponse({ ok: true, decision });
    })();
    return true;
  }
});