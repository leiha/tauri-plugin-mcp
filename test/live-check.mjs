/**
 * ⭐ THE PROOF THE UNIT SUITE STRUCTURALLY CANNOT MAKE.
 *
 * `accessible-name.test.mjs` has no DOM. It can pin the SHAPE of a selector — the
 * operator, the escaping, the null — and nothing more. Whether that selector
 * RESOLVES is decided by a real CSS engine, and by nothing else.
 *
 * ⚔ THAT GAP COST THREE ROUNDS IN ONE DAY (2026-08-16). Three times the unit suite
 * was green, three times the fix was declared finished, three times independent
 * falsification killed it — on resolution, never on shape. The runtime proof was
 * remade by hand each round and then lost: a green nobody could replay, and
 * therefore, in the falsifier's words, « a green that cannot go red ».
 *
 * This script is that green made replayable.
 *
 * ── HOW TO RUN IT ────────────────────────────────────────────────────────────
 *
 *   1. Serve `test/fixtures/accessible-name-cases.html` in a debug-built app that
 *      embeds this plugin, and get its map. With oshun's light table:
 *
 *        oshun lightbox open-file <path>/test/fixtures/accessible-name-cases.html
 *        oshun lightbox inspect <label> map > /tmp/map.json
 *
 *   2. Judge it:
 *
 *        node test/live-check.mjs /tmp/map.json
 *
 * ⛔ It takes a map rather than driving an app ITSELF, deliberately: the plugin
 * must not grow a dependency on any one application to test itself. Produce the
 * map however you like — CLI, MCP tool, raw socket — the verdict is the same.
 *
 * ⚠ A binary that has not been REBUILT since the probe changed will answer with
 * the old fields. `probe.js` is embedded by `include_str!`, so a bumped
 * `Cargo.toml` proves nothing. If every case fails at once, suspect the build
 * before suspecting the code.
 *
 * Exit 0 = every expectation held. Exit 1 = at least one did not, and each is
 * named with what was expected and what was measured.
 */
import { readFileSync } from 'node:fs';

/**
 * What each case must produce, and WHY it is in the fixture.
 *
 * `matches` is the number of elements the composed selector must hit. The default
 * is 1. The three deviations are deliberate and each one guards a property that
 * would otherwise rot silently.
 */
const EXPECTATIONS = {
  labelledby: {
    selector: null,
    why: 'the name lives in ANOTHER element — no attribute selector can carry it',
  },
  'shared-a': {
    matches: 2,
    why: 'two elements share a name; the count MUST expose the ambiguity, not hide it',
  },
  'shared-b': {
    matches: 2,
    why: 'the other half of the shared-name pair',
  },
};

const DEFAULT_EXPECTATION = { matches: 1 };

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node test/live-check.mjs <map.json>');
    console.error('       (see the header of this file for how to produce the map)');
    process.exit(2);
  }

  const raw = readFileSync(path, 'utf8');
  const start = raw.indexOf('{');
  if (start === -1) throw new Error(`no JSON object in ${path}`);
  const map = JSON.parse(raw.slice(start));

  const elements = (map.elements || []).filter((e) => e.id);
  if (elements.length === 0) {
    console.error('⛔ the map carries no identified element — wrong page, or a page that never loaded');
    process.exit(1);
  }

  // ⭐ A map produced by a stale binary has no such field at all. Saying so beats
  // reporting forty identical failures whose real cause is the build.
  const carriesSelector = elements.some((e) => 'accessibleNameSelector' in e);
  const carriesCount = elements.some((e) => 'accessibleNameSelectorMatches' in e);
  if (!carriesSelector || !carriesCount) {
    console.error('⛔ this map has no `accessibleNameSelector`/`…Matches` field.');
    console.error('   The app was NOT rebuilt since the probe changed — `include_str!`');
    console.error('   embeds probe.js, so bumping the Cargo.toml rev is not enough.');
    process.exit(1);
  }

  const failures = [];
  for (const element of elements) {
    const expected = EXPECTATIONS[element.id] || DEFAULT_EXPECTATION;
    const selector = element.accessibleNameSelector;
    const matches = element.accessibleNameSelectorMatches;

    if ('selector' in expected) {
      if (selector !== expected.selector) {
        failures.push({ id: element.id, expected: `selector ${expected.selector}`, got: `selector ${JSON.stringify(selector)}`, why: expected.why });
      }
      continue;
    }
    if (selector === null) {
      failures.push({ id: element.id, expected: `${expected.matches} match(es)`, got: 'no selector at all', why: expected.why });
      continue;
    }
    if (matches !== expected.matches) {
      failures.push({
        id: element.id,
        expected: `${expected.matches} match(es)`,
        got: `${matches}`,
        why: expected.why || 'the selector must reach its own element, and only it',
        selector,
      });
    }
  }

  console.log(`${elements.length} cases judged from ${path}`);
  if (failures.length === 0) {
    console.log('✅ every expectation held');
    process.exit(0);
  }
  console.log(`❌ ${failures.length} failed:\n`);
  for (const f of failures) {
    console.log(`  ${f.id}`);
    console.log(`     expected : ${f.expected}`);
    console.log(`     measured : ${f.got}`);
    if (f.selector) console.log(`     selector : ${f.selector}`);
    console.log(`     why it is here : ${f.why}\n`);
  }
  process.exit(1);
}

main();
