const SETTINGS_KEY = 'settings_v1';
const LEARNED_KEY  = 'learned_signatures_v1';

const defaultSettings = {
  enabled: true,
  policyMode: 'balanced',         
  autoApply: true,                 
  perSite: {}                     
};

console.log('[SW] background.js loaded!');
chrome.runtime.onInstalled.addListener(() => console.log('[SW] onInstalled'));


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
  const withDefaults = { ...defaultSettings, ...cur, perSite: { ...(cur.perSite || {}) } };
  if (JSON.stringify(withDefaults) !== JSON.stringify(cur)) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: withDefaults });
  }
  return withDefaults;
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
  const bounded = list.length > 5000 ? list.slice(-5000) : list;
  await setLedger(bounded);
  return entry;
}

async function tryRestoreLedgerIfEmpty(){
  const now = await getLedger();
  if (now.length) return false;
  const obj = await chrome.storage.local.get(['ledger_backup_v1']);
  const backup = obj.ledger_backup_v1 || [];
  if (!backup.length) return false;
  await setLedger(backup);
  console.warn('[SW] ledger restored from ledger_backup_v1');
  return true;
}

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
  chrome.tabs.get(tabId).then(
    () => {
      chrome.action.setBadgeText({ tabId, text }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
      if (clearAfterMs > 0) {
        setTimeout(() => {
          chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
        }, clearAfterMs);
      }
    },
    () => { /* tab closed */ }
  ).catch(() => {});
}


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
  await logEvent(record.site || 'unknown', 'policy.learned', {
    signatureHash: record.signatureHash,
    cmp: merged.cmp,
    decidedKind: merged.decidedKind,
    seenCount: merged.seenCount
  }, merged.decidedBy === 'auto' ? 'auto' : 'user');

  return merged;
}


function chooseDefaultByMode(mode, availableKinds = []) {
  const has = (k) => availableKinds.includes(k);
  switch (mode) {
    case 'strict':
      return has('reject_like') ? 'reject_like' : (has('settings_like') ? 'settings_like' : (has('accept_like') ? 'accept_like' : null));
    case 'allow':
      return has('accept_like') ? 'accept_like' : (has('settings_like') ? 'settings_like' : (has('reject_like') ? 'reject_like' : null));
    case 'balanced':
    default:
      if (has('reject_like')) return 'reject_like';
      if (has('accept_like')) return 'accept_like';
      if (has('settings_like')) return 'settings_like';
      return null;
  }
}

function safeMatchSignature(learned, incoming) {
  if (!learned || !incoming) return { ok: false, reason: 'no learned record' };
  if (learned.signatureHash !== incoming.signatureHash) return { ok: false, reason: 'hash mismatch' };
  if (learned.cmp && incoming.cmp && learned.cmp !== incoming.cmp) return { ok: false, reason: 'cmp mismatch' };
  if (!incoming.availableKinds?.includes(learned.decidedKind)) return { ok: false, reason: 'kind not available' };
  return { ok: true, reason: 'exact signature match' };
}

/** decide whether to auto-apply */
async function decidePolicy({ site, cmp, signatureHash, availableKinds }) {
  const settings = await getSettings();
  if (!settings.enabled)   return { apply: false, decidedKind: null, reason: 'disabled' };
  if (!settings.autoApply) return { apply: false, decidedKind: null, reason: 'autoApply off' };

  const learnedMap = await getLearnedMap();
  const learned = learnedMap[signatureHash];
  const siteCfg = settings.perSite?.[site] || {};
  const mode = siteCfg.mode || settings.policyMode;

    // Per-site kill switch
  if (siteCfg.disabled === true) {
    return { apply: false, decidedKind: null, reason: 'site disabled' };
  }


  // If learned exists and matches safely → apply learned
  if (learned) {
    const safe = safeMatchSignature(learned, { signatureHash, cmp, availableKinds });
    if (safe.ok) return { apply: true, decidedKind: learned.decidedKind, reason: 'learned:' + safe.reason };
    // signature drift → skip
    return { apply: false, decidedKind: null, reason: 'drift:' + safe.reason };
  }

  // Otherwise, only apply default if site opted-in to learning
  if (siteCfg.learning !== true) {
    return { apply: false, decidedKind: null, reason: 'learning not enabled for site' };
  }

  const fallback = chooseDefaultByMode(mode, availableKinds || []);
  if (fallback) return { apply: true, decidedKind: fallback, reason: `default:${mode}` };
  return { apply: false, decidedKind: null, reason: 'no available action' };
}

// ---------- message bus ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ping') {
    sendResponse({ pong: true, when: Date.now() });
    return true;
  }

  if (msg.type === 'log_event') {
    const site = msg.site || (sender?.tab?.url ? originFromUrl(sender.tab.url) : 'unknown');
    logEvent(site, msg.action, msg.details, msg.actor).then((entry) => {
      if (sender?.tab?.id != null) setBadgeSafe(sender.tab.id, '•', '#4f46e5', 3000);
      sendResponse({ ok: true, entry });
    });
    return true;
  }

  if (msg.type === 'get_ledger') {
  (async () => {
    sendResponse({ ok: true, list: await getLedger() });
  })();
  return true;
}

  if (msg.type === 'clear_ledger') {
  (async () => {
    // Hard-delete: remove ledger + backup so nothing can be restored
    await chrome.storage.local.set({
      [LEDGER_KEY]: [],
      last_clear_ledger: { ts: Date.now(), reason: msg.reason || 'manual' }
    });

    // Remove any backups explicitly
await chrome.storage.local.remove(['ledger_backup_v1', LEARNED_KEY]);
    sendResponse({ ok: true });
  })();
  return true;
}

  if (msg.type === 'get_settings') {
    (async () => {
      const settings = await getSettings();
      sendResponse({ ok: true, settings });
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

      if (next.enabled) chrome.action.setBadgeText({ text: '' });
      else chrome.action.setBadgeText({ text: '⏸' });

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
      const map = await getLearnedMap();
      sendResponse({ ok: true, learned: map });
    })();
    return true;
  }

  if (msg.type === 'policy_check') {
    (async () => {
      const payload = msg.payload || {};
      const decision = await decidePolicy(payload);
      await logEvent(payload.site, decision.apply ? 'policy.auto.apply' : 'policy.skip', {
        ...payload,
        decidedKind: decision.decidedKind,
        reason: decision.reason
      }, 'auto');
      sendResponse({ ok: true, decision });
    })();
    return true;
  }
});
