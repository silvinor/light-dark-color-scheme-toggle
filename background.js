// State lives in chrome.storage.sync as two keys:
//
//   colorScheme  the global default: "dark", "light", or null (follow system)
//   sites        { [origin]: "dark" | "light" } — per-site overrides
//
// A site with an entry in `sites` uses it; everything else uses the global.
// The registered content scripts ARE the state at page load: force-dark.js is
// registered for every origin resolving to dark, force-light.js for every
// origin resolving to light. They read nothing, so nothing is awaited before
// first paint and there is no flash.
//
// Everything flows one way: write to storage, and the storage.onChanged
// listener at the bottom applies it. That listener also fires for a value
// synced from another machine, so there is exactly one path to effect.

const GLOBAL_KEY = 'colorScheme';
const SITES_KEY = 'sites';

// The sizes Chrome draws in the toolbar: 16 at 1x, 24 at 1.5x, 32 at 2x.
// (48 and 128 exist for the extensions page and the store listing, and are
// declared under "icons" in the manifest rather than swapped at runtime.)
const SIZES = [16, 24, 32];

const ALL_URLS = ['http://*/*', 'https://*/*'];

function isScheme(value) {
  return value === 'dark' || value === 'light';
}

// The click cycle, for a site entry and for the global alike:
// null (default: no entry) → dark → light → null.
function nextScheme(scheme) {
  return scheme === 'dark' ? 'light' : scheme === 'light' ? null : 'dark';
}

async function getState() {
  const stored = await chrome.storage.sync.get([GLOBAL_KEY, SITES_KEY]);
  const global = isScheme(stored[GLOBAL_KEY]) ? stored[GLOBAL_KEY] : null;
  const sites = {};
  for (const [origin, scheme] of Object.entries(stored[SITES_KEY] ?? {})) {
    if (isScheme(scheme)) sites[origin] = scheme;
  }
  return { global, sites };
}

// The origin key for a URL, or null for anything we cannot act on
// (chrome://, about:, view-source:, and the like).
function originOf(url) {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? origin : null;
  } catch {
    return null;
  }
}

function isHttpPage(url) {
  try {
    return new URL(url).protocol === 'http:';
  } catch {
    return false;
  }
}

// What a given origin resolves to, override first.
function schemeFor(origin, state) {
  return state.sites[origin] ?? state.global;
}

// A content script match pattern covering exactly one origin.
function patternFor(origin) {
  return `${origin}/*`;
}

// Registration only affects the NEXT navigation.
//
// Per scheme: the global match (all URLs, when that scheme is the default)
// minus the origins overridden away from it, plus the origins overridden to
// it. Content script matches have no "except" syntax, so an origin overridden
// away from the global default is handled by excludeMatches.
async function register(state) {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({
      ids: existing.map((script) => script.id)
    });
  }

  const scripts = [];
  for (const scheme of ['dark', 'light']) {
    const pinned = Object.entries(state.sites)
      .filter(([, value]) => value === scheme)
      .map(([origin]) => patternFor(origin));

    const isDefault = state.global === scheme;
    const matches = isDefault ? ALL_URLS : pinned;
    if (!matches.length) continue;

    // When this scheme is the global default, every origin pinned to
    // something else has to be carved back out of the all-URLs match.
    const excludeMatches = isDefault
      ? Object.entries(state.sites)
          .filter(([, value]) => value !== scheme)
          .map(([origin]) => patternFor(origin))
      : [];

    scripts.push({
      id: `force-${scheme}`,
      js: [`world/force-${scheme}.js`],
      matches,
      ...(excludeMatches.length ? { excludeMatches } : {}),
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      persistAcrossSessions: true
    });
  }

  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

// Already-open tabs never see the registration, so push the value directly.
// Each tab gets the scheme its own origin resolves to.
async function applyToOpenTabs(state) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) => {
      const origin = originOf(tab.url ?? '');
      if (!origin) return undefined;
      return chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: 'MAIN',
          injectImmediately: true,
          func: (value) => {
            const pref = navigator.preferences?.colorScheme;
            if (!pref) return false; // API missing: the flag is off.
            const done = value ? pref.requestOverride(value) : pref.clearOverride();
            Promise.resolve(done).catch(() => {});
            return true;
          },
          args: [schemeFor(origin, state)]
        })
        // chrome:// and other restricted pages always reject. Expected.
        .catch(() => undefined);
    })
  );
}

// Whether the Web Preferences API is available, cached for the life of the
// service worker.
//
// The API is behind a flag, so an install with the flag off silently does
// nothing — which reads as a broken extension. It is a page API, so only page
// context can see it, which means an executeScript round-trip.
//
// CACHE THIS. The check is far too slow to sit on the click path or in
// updateAction, which runs on every tab switch — doing it per call made
// toggling visibly laggy. The flag cannot change without relaunching Chrome,
// and that restarts this worker, so one answer per worker lifetime is right.
//
// Undefined means "not yet known" or "could not tell" (a chrome:// tab, an
// injection that was refused). It is deliberately distinct from false, so a
// restricted tab never triggers the warning state, and it is not cached —
// only a definite answer is.
let apiCache;

async function detectApi() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!originOf(tab?.url ?? '')) return undefined;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => Boolean(navigator.preferences?.colorScheme)
    });
    return result?.result;
  } catch {
    return undefined;
  }
}

// The cached answer, without ever hitting the network path. Callers on a hot
// path use this; nothing awaits a fresh detection.
function apiAvailable() {
  return apiCache;
}

// Refresh the cache in the background, then repaint if the answer changed.
// Never awaited by a click.
async function refreshApiCache() {
  const seen = await detectApi();
  if (seen === undefined || seen === apiCache) return;
  apiCache = seen;
  await getState().then(updateAction);
}

// The icon reflects the ACTIVE tab's own setting, since that is what a click
// cycles: moon for dark, sun for light, half circle for default (no entry).
// When the API is off or the page uses HTTP, it shows nop instead. On a page
// with no site (chrome://), it shows the global the same way. The title names
// the setting and what a click sets it to.
async function updateAction(state) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  const origin = originOf(url);
  const setting = origin ? state.sites[origin] : state.global;
  const available = apiAvailable();
  const unusable = available === false || isHttpPage(url);
  const glyph = unusable ? 'nop' : setting === 'dark' ? 'moon' : setting === 'light' ? 'sun' : 'system';
  await chrome.action.setIcon({
    path: Object.fromEntries(SIZES.map((s) => [s, `icons/${glyph}-${s}.png`]))
  });

  if (unusable) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({
      title: available === false
        ? 'Color scheme toggle — setup needed\n' +
          'Chrome\'s Web Preferences API is off, so this cannot work yet.\n' +
          'Click for the one-step fix.'
        : 'Color scheme toggle — unavailable on HTTP pages'
    });
    return;
  }
  if (available === true) await chrome.action.setBadgeText({ text: '' });

  const label = (value) => (value === 'dark' ? 'Dark' : value === 'light' ? 'Light' : 'Default');
  await chrome.action.setTitle({
    title: `${label(setting)} » set to ${label(nextScheme(setting))}`
  });
}

async function apply(state) {
  await register(state);
  await applyToOpenTabs(state);
  await updateAction(state);
}

// Writers. The storage listener does the applying, so a click here and a value
// arriving from another machine take exactly the same path.

function setGlobal(scheme) {
  return chrome.storage.sync.set({ [GLOBAL_KEY]: scheme });
}

async function setSite(origin, scheme) {
  const { sites } = await getState();
  if (scheme) sites[origin] = scheme;
  else delete sites[origin];
  await chrome.storage.sync.set({ [SITES_KEY]: sites });
}

// Clicking moves the ACTIVE SITE's entry to the next step of the cycle,
// whatever the global is. With no active site (a chrome:// page), fall back to
// cycling the global default.
async function toggleActiveSite() {
  // With the flag off, toggling would silently do nothing. Show the fix
  // instead. Reads the cache; never blocks the click on a detection
  // round-trip.
  if (apiAvailable() === false) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  const origin = originOf(url);
  if (isHttpPage(url)) return;
  if (!origin) return toggleGlobal();
  const state = await getState();
  await setSite(origin, nextScheme(state.sites[origin]));
}

// Drop this site's override so it follows the global default again.
async function unpinActiveSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  const origin = originOf(url);
  if (isHttpPage(url)) return;
  if (origin) await setSite(origin, null);
}

async function toggleGlobal() {
  const { global } = await getState();
  await setGlobal(nextScheme(global));
}

chrome.action.onClicked.addListener(() => toggleActiveSite());

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle') toggleActiveSite();
  else if (command === 'toggle-global') toggleGlobal();
  else if (command === 'unpin-site') unpinActiveSite();
  else if (command === 'follow-system') setGlobal(null);
});

// The single path from stored state to actual effect.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (GLOBAL_KEY in changes || SITES_KEY in changes)) {
    getState().then(apply);
  }
});

// The icon is per-site, so it has to follow the user between tabs. These only
// repaint the action — no registration work, and no detection round-trip.
chrome.tabs.onActivated.addListener(() => getState().then(updateAction));
chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  if (changeInfo.url && tab.active) getState().then(updateAction);
});

// Detection runs off the hot path: once when the worker wakes, and again on
// navigation while the answer is still unknown (the first checks may land on
// a chrome:// tab, which cannot answer).
chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active && apiCache === undefined) {
    refreshApiCache();
  }
});

// Storage does not change on a cold start, so re-apply from what is stored.
chrome.runtime.onInstalled.addListener(() => getState().then(apply));
chrome.runtime.onStartup.addListener(() => getState().then(apply));

// Warm the detection cache once per worker lifetime, off the hot path.
refreshApiCache();
