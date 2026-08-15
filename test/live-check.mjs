/**
 * ⭐ THE PROOF THE UNIT SUITE STRUCTURALLY CANNOT MAKE.
 *
 * `accessible-name.test.mjs` has no DOM. It can pin the SHAPE of a selector — the
 * operator, the escaping, the null — and nothing more. Whether that selector
 * RESOLVES is decided by a real CSS engine, and by nothing else.
 *
 * ⚔ THAT GAP COST FOUR ROUNDS IN ONE DAY (2026-08-16). Four times the unit suite
 * was green, four times the fix was declared finished, four times independent
 * falsification killed it — on resolution, never on shape. The runtime proof was
 * remade by hand each round and then lost: a green nobody could replay, and
 * therefore « a green that cannot go red ».
 *
 * ── HOW TO RUN IT ────────────────────────────────────────────────────────────
 *
 *   1. Serve the fixture in a DEBUG-built app that embeds this plugin, and take
 *      its map. With oshun's light table:
 *
 *        oshun lightbox open-file <path>/test/fixtures/accessible-name-cases.html
 *        oshun lightbox inspect <label> map > /tmp/map.json
 *
 *   2. Judge it:            node test/live-check.mjs /tmp/map.json
 *   3. Distrust it first:   node test/live-check.mjs /tmp/map.json --self-check
 *
 * ⛔ IT REFUSES TO JUDGE A MAP IT CANNOT IDENTIFY. The probe stamps its own text
 * fingerprint into every map; this runner compares it to the `probe.js` sitting
 * next to it and STOPS if they differ. ⚔ The reason is measured: the probe's
 * `version` field said `2` on four binaries carrying four DIFFERENT contracts, so
 * a version number cannot tell you what you just validated. A green against an
 * unknown text is not a green — and the failure is asymmetric, since a stale
 * binary that happens to pass looks exactly like a current one.
 *
 * ⚠ IT IS A MANUAL GESTURE AND IT ALWAYS WILL BE: the bridge is compiled under
 * `#[cfg(debug_assertions)]`, so it needs a debug build, a live window and a
 * screen. It can never be a pre-commit hook or a CI job. Manual gestures get
 * skipped — which is exactly how the first repair shipped unverified. Say it here
 * rather than let someone discover it.
 *
 * ⛔ It takes a map rather than driving an app ITSELF, deliberately: the plugin
 * must not grow a dependency on any one application to test itself.
 *
 * Exit 0 = every expectation held. Exit 1 = at least one did not, each named.
 * Exit 2 = it refused to judge, and says why.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprintOf, readProbe } from './fingerprint.mjs';

/**
 * The expectations come from the FIXTURE, never from this file.
 *
 * ⭐ ORIGIN — the fixture and its discipline were built by the independent
 * falsification hand that killed four successive repairs on 2026-08-16. Every value
 * in it was MEASURED in a live webview, never reasoned about.
 *
 * ⛔ `status: "known-defect"` marks a case whose CURRENT behaviour is a bug rather
 * than the contract, and such a case MUST carry `shouldBe`. Without that, a fixture
 * quietly graves today's bugs as the spec, and whoever fixes one later sees a red
 * line and "repairs" the fixture. That is how a golden file dies.
 *
 * ⚠ THE STANDING TEMPTATION, named so it can be resisted: the day a legitimate
 * refactor turns twenty lines red, the obvious gesture is to regenerate the
 * expectations from current behaviour. At that instant the fixture stops being a
 * judge and becomes a mirror — it can only assert that the code does what the code
 * does. Every case carries an `intent` in prose precisely so that re-deriving an
 * expectation forces you to read WHY the case exists.
 */
const RESOLUTION = {
  unique: { test: (n) => n === 1, say: 'exactly 1 match, its own element' },
  ambiguous: { test: (n) => n > 1, say: 'more than 1 match, reported as such' },
  zero: { test: (n) => n === 0, say: '0 matches (a defect, deliberately recorded)' },
};

function loadFixture() {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, 'fixtures', 'fixture-accessible-name.json'), 'utf8');
  const fixture = JSON.parse(raw);
  const cases = [
    ...(fixture.attributeCases || []),
    ...(fixture.wrapperCases || []),
    ...(fixture.parsedCases || []),
  ];
  for (const c of cases) {
    if (c.status === 'known-defect' && !c.shouldBe) {
      throw new Error(`fixture case ${c.id} is a known-defect with no shouldBe — it would grave a bug as the contract`);
    }
  }
  return new Map(cases.map((c) => [c.id, c]));
}

function loadMap(path) {
  const raw = readFileSync(path, 'utf8');
  const start = raw.indexOf('{');
  if (start === -1) throw new Error(`no JSON object in ${path}`);
  return JSON.parse(raw.slice(start));
}

/** Refuses, loudly, rather than judging something it cannot identify. */
function assertJudgeable(map) {
  const elements = (map.elements || []).filter((e) => e.id);
  if (elements.length === 0) {
    return 'the map carries no identified element — wrong page, or a page that never loaded';
  }
  const expected = fingerprintOf(readProbe());
  const actual = map.probeFingerprint;
  if (!actual) {
    return [
      'this map carries no `probeFingerprint`.',
      '   The app runs a probe OLDER than the fingerprint mechanism, so there is no',
      '   way to know which contract it implements. `version` cannot tell you: it said',
      '   `2` on four binaries carrying four different contracts.',
      '   ⇒ Rebuild the app. `include_str!` embeds probe.js, so bumping the Cargo.toml',
      '     rev is NOT enough.',
    ].join('\n');
  }
  if (actual !== expected) {
    return [
      `fingerprint mismatch — this map was produced by a DIFFERENT probe.js.`,
      `     map says : ${actual}`,
      `     local is : ${expected}`,
      '   ⇒ Either the app was not rebuilt since you edited probe.js, or you are',
      '     pointing at another app. Judging it would validate an unknown text.',
    ].join('\n');
  }
  return null;
}

function judge(map, expectations) {
  const failures = [];
  for (const element of (map.elements || []).filter((e) => e.id)) {
    const expected = expectations.get(element.id);
    if (!expected) continue;                    // not a fixture element
    const selector = element.accessibleNameSelector;
    const matches = element.accessibleNameSelectorMatches;
    const want = expected.expect || {};

    const fail = (wanted, got) => failures.push({
      id: element.id, expected: wanted, got, selector,
      why: expected.intent,
      knownDefect: expected.status === 'known-defect' ? expected.shouldBe : null,
    });

    if (want.resolution === 'none') {
      if (selector !== null) fail('no selector at all', `selector ${JSON.stringify(selector)}`);
      continue;
    }
    if (selector === null) {
      fail(`${want.resolution} (${want.operator || '?'})`, 'no selector at all');
      continue;
    }
    const operator = selector.includes('^="') ? '^=' : '=';
    if (want.operator && operator !== want.operator) {
      fail(`operator ${want.operator}`, `operator ${operator}`);
      continue;
    }
    const rule = RESOLUTION[want.resolution];
    if (rule && !rule.test(matches)) fail(rule.say, `${matches} match(es)`);
  }
  return failures;
}

/**
 * ⭐ PROVES THE JUDGE CAN SAY NO, before anyone believes it when it says yes.
 *
 * A harness that cannot go red is worse than no harness — it converts « I checked »
 * into an unfalsifiable claim, which is the defect this whole module is made of.
 * ⚠ The NEUTRAL mutant is the load-bearing one: without a mutation that must stay
 * GREEN, three reds prove only that the judge rejects everything.
 */
function selfCheck(map, expectations) {
  const clone = () => JSON.parse(JSON.stringify(map));
  const mutate = (label, mustFail, fn) => {
    const mutant = clone();
    fn(mutant);
    const red = judge(mutant, expectations).length > 0;
    const ok = red === mustFail;
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(34)} ${red ? 'RED  ' : 'GREEN'} (expected ${mustFail ? 'RED' : 'GREEN'})`);
    return ok;
  };

  console.log('self-check — the judge must go red on real damage, and stay green otherwise:\n');
  const results = [
    mutate('a selector reaching nothing', true, (m) => {
      const target = m.elements.find((e) => e.accessibleNameSelectorMatches === 1);
      target.accessibleNameSelectorMatches = 0;
    }),
    mutate('an ambiguity hidden (N -> 1)', true, (m) => {
      const ambiguous = m.elements.find((e) => e.accessibleNameSelectorMatches > 1);
      ambiguous.accessibleNameSelectorMatches = 1;
    }),
    mutate('a selector silently dropped', true, (m) => {
      const target = m.elements.find((e) => e.accessibleNameSelectorMatches === 1);
      target.accessibleNameSelector = null;
    }),
    mutate('NEUTRAL — an unrelated field added', false, (m) => {
      for (const e of m.elements) e.unrelated = 'ignore me';
    }),
  ];
  return results.every(Boolean);
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node test/live-check.mjs <map.json> [--self-check]');
    console.error('       (see the header of this file for how to produce the map)');
    process.exit(2);
  }
  const map = loadMap(path);
  const expectations = loadFixture();

  const refusal = assertJudgeable(map);
  if (refusal) {
    console.error(`⛔ REFUSING TO JUDGE — ${refusal}`);
    process.exit(2);
  }

  if (process.argv.includes('--self-check')) {
    const sound = selfCheck(map, expectations);
    console.log(sound ? '\n✅ the judge can go red — its greens are worth reading' : '\n❌ the judge is NOT sound — do not trust any verdict it gives');
    process.exit(sound ? 0 : 1);
  }

  const cases = (map.elements || []).filter((e) => e.id && expectations.has(e.id));
  const failures = judge(map, expectations);
  console.log(`${cases.length} fixture cases judged from ${path}  (probe ${map.probeFingerprint})`);
  if (cases.length === 0) {
    console.error('⛔ none of the map elements is a fixture case — wrong page?');
    process.exit(2);
  }
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
    console.log(`     why it is here : ${f.why}`);
    if (f.knownDefect) console.log(`     ⚠ RECORDED AS A KNOWN DEFECT — should be: ${f.knownDefect}`);
    console.log('');
  }
  process.exit(1);
}

main();
