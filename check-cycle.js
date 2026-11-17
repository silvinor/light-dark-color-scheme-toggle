// Checks the toolbar click cycle in background.js. Run: node check-cycle.js
// Whatever the global default is, clicks on a site must step its entry
// through default (no entry) → dark → light → default, and a saved entry
// must win over the default.
const assert = require('assert');
const src = require('fs').readFileSync(`${__dirname}/background.js`, 'utf8');
const grab = (name) => src.match(new RegExp(`function ${name}[\\s\\S]*?\\n}`))[0];
eval(grab('nextScheme') + grab('schemeFor') + grab('isHttpPage'));

assert.strictEqual(isHttpPage('http://example.com'), true);
assert.strictEqual(isHttpPage('https://example.com'), false);
assert.strictEqual(isHttpPage('chrome://settings'), false);

for (const global of [null, 'dark', 'light']) {
  const state = { global, sites: {} };
  const origin = 'https://example.com';
  for (const expected of ['dark', 'light', undefined, 'dark', 'light', undefined]) {
    const next = nextScheme(state.sites[origin]);
    if (next) state.sites[origin] = next;
    else delete state.sites[origin];
    assert.strictEqual(state.sites[origin], expected);
    assert.strictEqual(schemeFor(origin, state), expected ?? global);
  }
}
console.log('ok');
