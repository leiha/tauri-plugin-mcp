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
 *   0. GENERATE the page first. It is gitignored — derived from the fixture JSON,
 *      which is the SSOT — so a fresh clone does NOT have it:
 *
 *        node test/fixtures/fixture-to-page.mjs
 *
 *   1. Serve it in a DEBUG-built app that embeds this plugin, and take its map.
 *      With oshun's light table:
 *
 *        oshun lightbox open-file "$PWD/test/fixtures/accessible-name-page.html"
 *        oshun lightbox tabs                      # ⛔ READ THE LABEL IT PRINTS
 *        oshun lightbox inspect <label> map > /tmp/map.json
 *
 *   2. Judge it:            node test/live-check.mjs /tmp/map.json
 *   3. Distrust it first:   node test/live-check.mjs /tmp/map.json --self-check
 *
 * ⛔ NEVER hard-code a tab label. It is assigned at open time and it MOVES —
 * `lightbox-0` one run, `lightbox-3` the next. A command sent to a stale label
 * answers `Webview not found` and, if nobody reads that line, the NEXT measurement
 * silently describes the wrong thing. ⚔ Measured twice on 2026-08-16, and a third
 * time on 2026-08-17 when a hand was mandated against a label that no longer
 * existed. `oshun lightbox tabs` is the only source of truth for it.
 *
 * ⚠ Steps 0 and 1 were WRONG here until 2026-08-17: this header named
 * `accessible-name-cases.html`, a file that has never existed, and it skipped the
 * generation step entirely. Anyone following the instructions to the letter got an
 * ENOENT. Found by independent falsification, in a file whose whole purpose is to
 * stop people trusting things nobody executed.
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
 * ⛔ AND IT JUDGES `map` ALONE — no other surface of the bridge is judged by
 * anything, here or elsewhere. `loadMap` expects an object carrying `.elements`,
 * and both judges iterate it; `inspect_click`, `inspect_fill`, `inspect_press` and
 * `inspect_wait` answer with their own descriptors (`clicked`, `filled`,
 * `activeAfter`) that NOTHING in this file reads.
 * ⚠ Read that boundary precisely, because it is not where it looks. Those surfaces
 * go through the same `describeElement`, so the six naming fields do travel with
 * them and a naming regression would surface here. But `value`, `valueLength`,
 * `valueTruncated` and `valueRedacted` are attached by `map()` itself and exist on
 * NO other surface — a leak or a bad cut confined to `fill` would leave this file
 * green. Extending the judge to a `clicked`/`filled` object is real work and has
 * not been done; saying so is cheaper than letting « the harness is green » be read
 * as « the bridge is green ».
 *
 * ⭐ AND IT MUST GO THROUGH THE ORDINARY PATH — `inspect map`, the command a caller
 * actually runs. This is the sharpest lesson of the whole episode, and it comes
 * from the falsification hand's post-mortem of her OWN instrument: every probe she
 * wrote reported characters as HEX CODES, because that is the natural gesture when
 * hunting invisible characters. Hex is precisely what neutralises the payload that
 * broke the channel. ⚔ Her tooling therefore removed from the wire the one thing
 * that broke it, and her component test faithfully reproduced that blind spot —
 * confirming a bias instead of exposing it. The defect surfaced the second someone
 * ran the ORDINARY command.
 * ⇒ Instrumenting to observe removes from the path the thing you are observing.
 * A judge that reaches the page through its own special channel is measuring its
 * own channel.
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

function readFixture() {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(
    readFileSync(join(here, 'fixtures', 'fixture-accessible-name.json'), 'utf8'));
  const all = [
    ...(fixture.attributeCases || []),
    ...(fixture.wrapperCases || []),
    ...(fixture.parsedCases || []),
    ...(fixture.boundedFieldCases || []),
  ];
  for (const c of all) {
    if (c.status === 'known-defect' && !c.shouldBe) {
      throw new Error(`fixture case ${c.id} is a known-defect with no shouldBe — it would grave a bug as the contract`);
    }
  }
  return fixture;
}

/**
 * Every key `judge()` knows how to read — and the list exists so that a key it does
 * NOT know cannot be written.
 *
 * ⚔ MEASURED 2026-08-16 by independent falsification: `tagQualified` had been
 * carried by two SVG cases, with an explicit intent, and was read by NOBODY. The
 * asymmetry was the whole defect — `loadBoundedFieldCases` threw on an unknown key
 * from its first day, `loadFixture` validated nothing at all, so the neighbouring
 * family got the silence the other one had been protected from. A guard that exists
 * for one family and not for its neighbour is the shape this harness keeps failing
 * in; the fixture reads as if it asserted something, and it asserted nothing.
 */
const SELECTOR_EXPECT_KEYS = new Set(['operator', 'resolution', 'tagQualified']);

function loadFixture(fixture) {
  const cases = [
    ...(fixture.attributeCases || []),
    ...(fixture.wrapperCases || []),
    ...(fixture.parsedCases || []),
  ];
  for (const c of cases) {
    for (const key of Object.keys(c.expect || {})) {
      if (!SELECTOR_EXPECT_KEYS.has(key)) {
        throw new Error(`fixture case ${c.id} expects unknown key \`${key}\` — a silently ignored expectation is worse than none`);
      }
    }
  }
  return new Map(cases.map((c) => [c.id, c]));
}

/**
 * ⭐ THE SECOND CONTRACT THIS FILE JUDGES — and it exists because a flag can be
 * CORRECT and never reach anyone.
 *
 * `bounded()` computed `truncated` from the first repair onward. `describeElement`
 * never emitted it, `text` and `value` never had one, and the whole unit suite was
 * green throughout: there is no fake DOM in which « the map does not carry this
 * field » can be observed. ⚔ What it cost, measured 2026-08-16 by independent
 * falsification: an input filled with 200 characters read back as 80 with nothing
 * saying so, so the ordinary verification gesture — fill, re-read — concluded the
 * input had been cut when the DOM held it whole.
 *
 * ⛔ ABSENT AND NULL ARE DIFFERENT ANSWERS, and this judge separates them by hand.
 * `element.valueLength === undefined` means the probe does not emit the field at all
 * — the defect itself; `null` means it emits it and the control genuinely has no
 * value. A plain `!==` would conflate the two and report the emission defect as a
 * mere wrong value, which is how it stayed invisible for a day.
 */
const BOUNDED_FIELD_OF = {
  textEquals: 'text',
  textLength: 'textLength',
  textTruncated: 'textTruncated',
  valueEquals: 'value',
  valueLength: 'valueLength',
  valueTruncated: 'valueTruncated',
  valueRedacted: 'valueRedacted',
  accessibleNameEquals: 'accessibleName',
  // ⛔ WHICH ATTRIBUTE WON, and it is the field the published contract tells every
  // consumer to read rather than assume (« lis `accessibleNameFrom` plutôt que de
  // supposer la source »). The resolution order changed on 2026-08-16 — `title` now
  // precedes `placeholder`, per HTML-AAM §4.1.1 — and nothing live watched the order
  // at all: a case can assert the NAME and still be blind to WHERE it came from,
  // because two attributes carrying the same string produce the same name.
  accessibleNameFromEquals: 'accessibleNameFrom',
  accessibleNameLength: 'accessibleNameLength',
  accessibleNameTruncated: 'accessibleNameTruncated',
};

/**
 * ⭐ THE THIRD CONTRACT — a value the map does not carry as a field, and the only
 * way to see WHICH UNIT the cut counts in.
 *
 * ⚔ MEASURED 2026-08-16, and it is the sharpest of the six blind spots: a
 * `boundedField` cutting in CODE POINTS instead of UTF-16 units still reports
 * `textLength: 200` and `textTruncated: true` — every field the fixture watched
 * stayed exactly right — while the field it HANDS BACK silently grew from 80 units
 * to 160. The 80-unit display bound is the entire reason this cluster exists
 * (« keeps a 200-element map readable » under a 64 KB transport ceiling), and it
 * could double without one expectation moving.
 * ⛔ So the length of the SHOWN text is asserted directly. It cannot be asserted as
 * a string: the fixture's `expect` block is deliberately ASCII-literal-only, so no
 * decoder has to exist twice, and these cases are made of emoji.
 * ⚠ The emission check still runs on the underlying field — an absent `text` is an
 * emission defect here exactly as it is above, never a length of zero.
 */
const BOUNDED_DERIVED_OF = {
  textShownLength: { field: 'text', read: (v) => (v === null ? null : String(v).length) },
};

/** The map field an expectation ultimately reads — direct or derived. */
function fieldOfExpectKey(key) {
  if (BOUNDED_FIELD_OF[key]) return BOUNDED_FIELD_OF[key];
  return BOUNDED_DERIVED_OF[key] ? BOUNDED_DERIVED_OF[key].field : null;
}

function loadBoundedFieldCases(fixture) {
  const cases = fixture.boundedFieldCases || [];
  for (const c of cases) {
    for (const key of Object.keys(c.expect || {})) {
      if (!fieldOfExpectKey(key)) {
        throw new Error(`fixture case ${c.id} expects unknown key \`${key}\` — a silently ignored expectation is worse than none`);
      }
    }
  }
  return new Map(cases.map((c) => [c.id, c]));
}

function judgeBoundedFields(map, cases) {
  const failures = [];
  for (const element of (map.elements || []).filter((e) => e.id)) {
    const expected = cases.get(element.id);
    if (!expected) continue;
    for (const [key, want] of Object.entries(expected.expect || {})) {
      const derived = BOUNDED_DERIVED_OF[key];
      const field = fieldOfExpectKey(key);
      const fail = (got) => failures.push({
        id: `${element.id} · ${derived ? `${key} (over \`${field}\`)` : field}`,
        expected: JSON.stringify(want),
        got,
        selector: null,
        why: expected.intent,
        knownDefect: expected.status === 'known-defect' ? expected.shouldBe : null,
      });
      if (!Object.prototype.hasOwnProperty.call(element, field)) {
        fail(`the map does not carry \`${field}\` AT ALL — an emission defect, not a wrong value`);
        continue;
      }
      const got = derived ? derived.read(element[field]) : element[field];
      if (got !== want) fail(JSON.stringify(got));
    }
  }
  return failures;
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
    // ⛔ THE TAG MUST BE OMITTED ON SVG, and nothing checked it. `e-svg-a` and
    // `e-svg-rect` have carried `tagQualified: false` with an explicit intent — SVG
    // tag names are CASE-SENSITIVE in selectors, so a tag taken from `el.tagName`
    // would compose `RECT[...]` and resolve to nothing.
    // ⚔ MEASURED 2026-08-16: both SVG selectors replaced by the tag-qualified form
    // the intent forbids, and the run stayed « every expectation held », exit 0.
    // ⚠ `resolution: unique` does NOT rescue this. Lower-case `a` and `rect` still
    // match their own SVG element, so the count stays 1 and nothing moves; the case
    // that would break is a camel-cased tag such as `linearGradient`, and the
    // corpus carries none. Judging the SHAPE is therefore the only guard available.
    if (Object.prototype.hasOwnProperty.call(want, 'tagQualified')) {
      const qualified = !selector.startsWith('[');
      if (qualified !== want.tagQualified) {
        fail(
          want.tagQualified ? 'a tag-qualified selector' : 'NO tag qualification (SVG tag names are case-sensitive)',
          `selector ${JSON.stringify(selector)}`);
        continue;
      }
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
function selfCheck(map, expectations, boundedCases) {
  const clone = () => JSON.parse(JSON.stringify(map));
  const mutate = (label, mustFail, fn) => {
    const mutant = clone();
    const target = fn(mutant);
    if (target === null) {
      console.log(`  ❌ ${label.padEnd(38)} NO TARGET (the map carries no element this mutation can damage)`);
      return false;
    }
    const red = judgeAll(mutant, expectations, boundedCases).length > 0;
    const ok = red === mustFail;
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(38)} ${red ? 'RED  ' : 'GREEN'} (expected ${mustFail ? 'RED' : 'GREEN'})`);
    return ok;
  };

  // ⛔ Every mutation targets an element the relevant judge actually WATCHES. A
  // mutation landing on an unwatched element stays green and reads as « the judge
  // is blind » — and once the map grew a second family of cases, picking « the
  // first element with one match » could land on one the selector judge ignores.
  const watchedBySelector = (m) => m.elements.filter((e) => expectations.has(e.id));
  const pick = (list) => (list.length > 0 ? list[0] : null);

  /**
   * ⛔ WATCHED BY THE CASE IS NOT ENOUGH — IT MUST WATCH THE KEY BEING DAMAGED.
   *
   * ⚔ MEASURED 2026-08-17, by this very self-check, reported by an independent
   * session: `a length field not emitted at all` deleted `valueLength` from the
   * FIRST bounded case carrying it — `f-text-plain`, whose `expect` names only
   * `text*`. The field was genuinely removed and genuinely unjudged, so the run
   * came back GREEN and read as « the judge cannot see an absent field ». The
   * judge could. The mutation had simply landed where nothing was watching.
   *
   * ⚠ Same family as a defect measured on 2026-08-15 on the neighbouring harness
   * (four mutations reported as « does not bite » that had never been applied):
   * A MUTATION THAT DOES NOT REACH WHAT IS JUDGED RETURNS A VERDICT ABOUT NOTHING.
   * There, the mutation never ran; here it ran on a blind spot — and the second
   * shape is the harder one, because the damage is real and visible in the diff.
   *
   * ⇒ Picking by key rather than by field makes the miss impossible to write,
   * instead of correcting each mutation one at a time. A `null` return surfaces as
   * NO TARGET, never as a pass.
   */
  const pickWatching = (m, expectKey, predicate = () => true) => {
    const field = fieldOfExpectKey(expectKey);
    return pick(m.elements.filter((e) => {
      const c = boundedCases.get(e.id);
      return c
        && Object.prototype.hasOwnProperty.call(c.expect || {}, expectKey)
        && Object.prototype.hasOwnProperty.call(e, field)
        && predicate(e);
    }));
  };

  console.log('self-check — the judge must go red on real damage, and stay green otherwise:\n');
  const results = [
    mutate('a selector reaching nothing', true, (m) => {
      const target = pick(watchedBySelector(m).filter((e) => e.accessibleNameSelectorMatches === 1));
      if (target) target.accessibleNameSelectorMatches = 0;
      return target;
    }),
    mutate('an ambiguity hidden (N -> 1)', true, (m) => {
      const target = pick(watchedBySelector(m).filter((e) => e.accessibleNameSelectorMatches > 1));
      if (target) target.accessibleNameSelectorMatches = 1;
      return target;
    }),
    mutate('a selector silently dropped', true, (m) => {
      const target = pick(watchedBySelector(m).filter((e) => e.accessibleNameSelectorMatches === 1));
      if (target) target.accessibleNameSelector = null;
      return target;
    }),
    // ⭐ THE MUTATION THAT REPRODUCES THE DEFECT ITSELF: a cut that stops declaring
    // itself. If this stays green, the repair is unfalsifiable and worth nothing.
    mutate('a truncation flag flipped to false', true, (m) => {
      const target = pickWatching(m, 'textTruncated', (e) => e.textTruncated === true);
      if (target) target.textTruncated = false;
      return target;
    }),
    // ⭐ AND THE EXACT SHAPE THE DEFECT HAD — not a wrong value, an ABSENT field.
    // No unit test can produce this state; only a real map can.
    mutate('a length field not emitted at all', true, (m) => {
      const target = pickWatching(m, 'valueLength');
      if (target) delete target.valueLength;
      return target;
    }),
    mutate('a length off by one', true, (m) => {
      const target = pickWatching(m, 'textLength', (e) => typeof e.textLength === 'number');
      if (target) target.textLength += 1;
      return target;
    }),
    // ⛔ THE THREE BELOW EXIST BECAUSE THE PROOF COVERED HALF THE CLAIM. The list
    // above damages `textTruncated`, `valueLength` and `textLength` and stops there,
    // while the contract has SIX bounded fields. `judgeBoundedFields` is generic over
    // `BOUNDED_FIELD_OF`, so the ability to go red does transport — but transporting
    // is an inference, and this file's whole promise is that it does not infer. ⚠ It
    // is mechanism 8 of `docs/explanation/pourquoi-un-instrument-de-verification-ment.md`
    // to the letter: the calibration is CORRECT and INCOMPLETE, which reads exactly
    // like a complete one.
    mutate('a value truncation flag flipped', true, (m) => {
      const target = pickWatching(m, 'valueTruncated', (e) => e.valueTruncated === true);
      if (target) target.valueTruncated = false;
      return target;
    }),
    mutate('a name length off by one', true, (m) => {
      const target = pickWatching(m, 'accessibleNameLength', (e) => typeof e.accessibleNameLength === 'number');
      if (target) target.accessibleNameLength += 1;
      return target;
    }),
    mutate('a name taken from the wrong attribute', true, (m) => {
      const target = pickWatching(m, 'accessibleNameFromEquals', (e) => e.accessibleNameFrom === 'title');
      if (target) target.accessibleNameFrom = 'placeholder';
      return target;
    }),
    mutate('a name truncation flag flipped', true, (m) => {
      const target = pickWatching(m, 'accessibleNameTruncated', (e) => e.accessibleNameTruncated === true);
      if (target) target.accessibleNameTruncated = false;
      return target;
    }),
    // ⭐ THE LEAK REOPENED, in the exact shape it had: the value comes back and the
    // flag stops saying it was withheld. A redaction nobody can see regress is a
    // redaction that lasts until the next refactor.
    mutate('a redacted secret handed back', true, (m) => {
      const target = pickWatching(m, 'valueRedacted', (e) => e.valueRedacted === true);
      if (target) {
        target.valueRedacted = false;
        target.value = 'the-secret-is-back';
        target.valueLength = 18;
      }
      return target;
    }),
    // ⭐ AND THE CUT THAT CHANGES UNIT WITHOUT CHANGING ONE REPORTED FIELD — the
    // damage `textLength` and `textTruncated` are both blind to. See BOUNDED_DERIVED_OF.
    mutate('the display cut silently doubled', true, (m) => {
      const target = pickWatching(m, 'textShownLength', (e) => typeof e.text === 'string');
      if (target) target.text += target.text;
      return target;
    }),
    mutate('NEUTRAL — an unrelated field added', false, (m) => {
      for (const e of m.elements) e.unrelated = 'ignore me';
      return m.elements[0] || null;
    }),
  ];
  return results.every(Boolean);
}

function judgeAll(map, expectations, boundedCases) {
  return [...judge(map, expectations), ...judgeBoundedFields(map, boundedCases)];
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node test/live-check.mjs <map.json> [--self-check]');
    console.error('       (see the header of this file for how to produce the map)');
    process.exit(2);
  }
  const map = loadMap(path);
  const fixture = readFixture();
  const expectations = loadFixture(fixture);
  const boundedCases = loadBoundedFieldCases(fixture);

  const refusal = assertJudgeable(map);
  if (refusal) {
    console.error(`⛔ REFUSING TO JUDGE — ${refusal}`);
    process.exit(2);
  }

  if (process.argv.includes('--self-check')) {
    const sound = selfCheck(map, expectations, boundedCases);
    console.log(sound ? '\n✅ the judge can go red — its greens are worth reading' : '\n❌ the judge is NOT sound — do not trust any verdict it gives');
    process.exit(sound ? 0 : 1);
  }

  const seen = (map.elements || []).filter((e) => e.id);
  const cases = seen.filter((e) => expectations.has(e.id));
  const bounded = seen.filter((e) => boundedCases.has(e.id));
  const failures = judgeAll(map, expectations, boundedCases);
  console.log(`${cases.length} selector cases + ${bounded.length} bounded-field cases judged from ${path}  (probe ${map.probeFingerprint})`);
  // ⛔ A family that reaches ZERO elements is a silent pass, and this fixture has
  // been served from a stale generated page before. Name it rather than count it in.
  if (bounded.length !== boundedCases.size) {
    console.error(`⛔ ${boundedCases.size - bounded.length} bounded-field case(s) never appeared in the map — regenerate the page (node test/fixtures/fixture-to-page.mjs) and reopen it.`);
    process.exit(2);
  }
  // ⛔ THE SAME GUARD FOR THE SELECTOR FAMILY, and its absence made the count above
  // a decoration. Only `cases.length === 0` used to be tested, so SEVENTY of the
  // seventy-one could vanish and the run still printed « every expectation held »
  // and exited 0. ⚔ MEASURED 2026-08-16: a real map amputated of 70 selector cases
  // came back green. Every ordinary cause empties a family PARTIALLY rather than
  // completely — a page generated before a case was added, a `visibleOnly` filter,
  // the `limit` reached, one `querySelectorAll` clause that stops matching — so the
  // zero test was guarding the one shape that almost never occurs.
  if (cases.length !== expectations.size) {
    const missing = expectations.size - cases.length;
    const none = cases.length === 0 ? ' — NOT ONE of them did, so this is very likely the wrong page' : '';
    console.error(`⛔ ${missing} selector case(s) never appeared in the map${none} — regenerate the page (node test/fixtures/fixture-to-page.mjs) and reopen it.`);
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
