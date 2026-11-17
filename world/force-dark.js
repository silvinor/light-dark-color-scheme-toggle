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

  // Optional, safe to delete: hide the page for the few ms before the
  // override lands, so it never paints the wrong scheme first. Three
  // independent removals, so a rejection can't leave the page blank.
  const style = document.createElement('style');
  style.textContent = ':root { visibility: hidden !important; }';
  (document.head || document.documentElement).appendChild(style);
  const reveal = () => style.remove();
  setTimeout(reveal, 100);
  requestAnimationFrame(reveal);

  Promise.resolve(pref.requestOverride('dark')).catch(() => {}).finally(reveal);
})();
