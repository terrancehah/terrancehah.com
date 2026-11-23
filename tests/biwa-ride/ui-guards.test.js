// Static UI guards for checkpoint skipping and badge shape — no DOM and
// no runtime: these read the shipped sources and the i18n module to pin
// the contract the skip/badge design relies on. Behavioural coverage of
// the same rules lives in rules.test.js / trip-store.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI_SRC = fs.readFileSync(
  path.join(ROOT, 'projects/biwa-ride/biwa-ride.js'),
  'utf8'
);
const CSS_SRC = fs.readFileSync(
  path.join(ROOT, 'projects/biwa-ride/biwa-ride.css'),
  'utf8'
);
const I18n = require('../../projects/biwa-ride/biwa-i18n.js');

// --- badges: a single shore chip, never a programme chip ---------------------

test('official badges render the shore part only — English', () => {
  I18n.setLang('en');
  const parts = I18n.badgeParts('Official · South');
  assert.strictEqual(parts.length, 1, 'one chip, not programme + shore');
  assert.strictEqual(parts[0].text, 'South');
  assert.strictEqual(parts[0].programme, 'official');
  assert.strictEqual(parts[0].area, 'south');
  assert.strictEqual(I18n.badge('Official · East'), 'East');
});

test('official badges render the shore part only — Chinese compact shore', () => {
  I18n.setLang('zh');
  const cases = {
    'Official · East': '湖东',
    'Official · South': '湖南',
    'Official · West': '湖西',
    'Official · North': '湖北'
  };
  Object.keys(cases).forEach(function (badge) {
    const parts = I18n.badgeParts(badge);
    assert.strictEqual(parts.length, 1, badge + ' is a single chip');
    assert.strictEqual(parts[0].text, cases[badge]);
    assert.strictEqual(I18n.badge(badge), cases[badge]);
  });
  I18n.setLang('en');
});

// --- skipping: no check-in path may bypass a skipped occurrence --------------

test('a skipped stop exposes no completion toggle or external check-in', () => {
  // The sheet action code must gate every check-in surface on skipped
  // occurrences — the Undo-skip branch returns before the official link
  // and the manual tick can render.
  assert.ok(
    UI_SRC.indexOf('Visit anyway') === -1,
    'no direct skipped -> visited control exists'
  );
  const actions = UI_SRC.slice(UI_SRC.indexOf('function renderSheetActions'));
  const undoIdx = actions.indexOf('skippedOccs');
  const linkIdx = actions.indexOf('OFFICIAL_CHECKIN_URL');
  const tickIdx = actions.indexOf('"sheet-tick"');
  assert.ok(undoIdx !== -1, 'skipped occurrences gate the action row');
  assert.ok(
    undoIdx < linkIdx && undoIdx < tickIdx,
    'the undo gate precedes both the official link and the tick'
  );
});

test('no rendered "Skipped" tag or day-route undo control remains', () => {
  assert.ok(
    UI_SRC.indexOf('biwa-skip-tag') === -1,
    'the Skipped text tag is gone from cards, sheet and day list'
  );
  assert.ok(
    CSS_SRC.indexOf('.biwa-skip-tag') === -1,
    'the tag rule went with the markup'
  );
  assert.ok(
    UI_SRC.indexOf('biwa-dayroute-undo') === -1,
    'day-route rows carry no Undo skip control — the sheet owns undo'
  );
  assert.ok(
    UI_SRC.indexOf('biwa-dayroute-skip-icon') !== -1,
    'day-route rows keep the icon-only skipped glyph'
  );
});
