// Runs at document_start in the MAIN world, where navigator.preferences lives.
// No chrome.* here — none exists in that world.
//
// This file being the registered one IS the extension's state. It reads
// nothing, so nothing is awaited before first paint and there is no flash.
// Do not merge it with world/force-light.js: registerContentScripts takes
// files only, so one file per value is what makes that possible.
(() => {
  const pref = navigator.preferences?.colorScheme;
  if (!pref) return; // Behind a flag, or not a secure context.

  Promise.resolve(pref.requestOverride('dark')).catch(() => {});
})();
