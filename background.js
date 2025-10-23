// MV3 service worker: ledger + message bus
const LEDGER_KEY = 'ledger_v1';

console.log('[SW] background.js loaded!');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SW] onInstalled');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // Debug helper to wake/verify SW
  if (msg.type === 'ping') {
    console.log('[SW] got ping from', sender?.tab?.url || 'extension');
    sendResponse({ pong: true, when: Date.now() });
    return true;
  }

  // Append a ledger entry
  if (msg.type === 'log_event') {
    const site = msg.site || (sender?.tab?.url ? originFromUrl(sender.tab.url) : 'unknown');
    console.log('[SW] log_event from tab:', sender?.tab?.url || '(no tab)', 'frameId:', sender?.frameId, msg.action);
    logEvent(site, msg.action, msg.details, msg.actor).then((entry) => {
      // tiny badge nudge on activity (optional)
      if (sender?.tab?.id != null) {
        chrome.action.setBadgeText({ text: '•', tabId: sender.tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
        setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: sender.tab.id }), 3000);
      }
      sendResponse({ ok: true, entry });
    });
    return true; // async
  }

  // Read full ledger
  if (msg.type === 'get_ledger') {
    getLedger().then((list) => sendResponse({ ok: true, list }));
    return true; // async
  }

  // Optional: clear ledger
  if (msg.type === 'clear_ledger') {
    chrome.storage.local.set({ [LEDGER_KEY]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---- helpers ----
async function logEvent(site, action, details = {}, actor = 'user') {
  const entry = {
    id: cryptoRandomId(),
    site,
    ts: Date.now(),
    actor,    // 'user' | 'auto'
    action,   // e.g., 'page.load' | 'cmp.banner.detected' | 'cmp.button.click'
    details
  };
  const list = await getLedger();
  list.push(entry);
  const bounded = list.length > 5000 ? list.slice(-5000) : list;
  await chrome.storage.local.set({ [LEDGER_KEY]: bounded });
  return entry;
}

async function getLedger() {
  const obj = await chrome.storage.local.get(LEDGER_KEY);
  return Array.isArray(obj[LEDGER_KEY]) ? obj[LEDGER_KEY] : [];
}

function originFromUrl(url) {
  try { return new URL(url).origin; } catch { return 'unknown'; }
}

function cryptoRandomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}
