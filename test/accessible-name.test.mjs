/**
 * WHAT THIS PINS, AND WHY IT IS NARROW.
 *
 * `describeElement` gained `accessibleName` / `accessibleNameFrom` because a
 * control with no `id`, no `name` and no text came back INDISTINGUISHABLE from
 * every other one — nothing but a build-hashed `svelte-xxxxxxx` class, which is a
 * COMPONENT scope and matches the section and all its controls alike. Measured
 * 2026-08-15 over three live surfaces: 36 interactive elements, 9 mute that way,
 * all 9 carrying an accessible name the description threw away.
 *
 * ⭐ THE END-TO-END PROOF IS NOT HERE — it was made against the running app: a
 * selector composed MECHANICALLY as `[<from>="<value>"]` resolved, and
 * `act fill` answered `accepted: true`. That is a stronger fact than any fake DOM,
 * and this file does not try to restate it.
 *
 * 🔑 WHAT IS LEFT THAT CAN ROT IN SILENCE is the ORDER of preference and the
 * REPORTING of the source. Reorder the four attributes and every caller keeps
 * composing selectors that quietly name the wrong attribute; drop `from` and the
 * name becomes a handle that cannot be turned — the exact defect the first attempt
 * to USE this hit (guessing `placeholder` on an element whose name came from
 * `aria-label`, while its placeholder said something else). That is what this pins.
 *
 * ⚠ IT READS THE SHIPPED SOURCE rather than a copy: `probe.js` is an IIFE with no
 * exports, so the function is lifted out of the file by name. If it is renamed or
 * removed, this test fails loudly instead of passing against a stale duplicate.
 *
 * Run: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'probe.js');

/**
 * Lifts one named function out of the IIFE by brace matching.
 *
 * ⛔ Deliberately NOT a regex over the whole body: the function contains braces,
 * and a lazy match would cut it at the first `}` and then test a fragment that
 * happens to parse. Counting braces fails loudly instead.
 */
function liftFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `\`${name}\` is gone from probe.js — renamed, or removed`);
  let depth = 0;
  let seenBrace = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') {
      depth++;
      seenBrace = true;
    } else if (text[i] === '}') {
      depth--;
      if (seenBrace && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `unbalanced braces while lifting \`${name}\``);
  return text.slice(start, end);
}

/**
 * Lifts the whole naming cluster, because `accessibleName` no longer stands alone:
 * it delegates the bound to `bounded`, and the selector is composed by
 * `accessibleNameSelector`. Lifting only the entry point would fail with a
 * `ReferenceError` that says nothing about what actually broke.
 */
function liftNaming() {
  const text = readFileSync(SOURCE, 'utf8');
  const boundMatch = text.match(/var NAME_BOUND = (\d+);/);
  assert.notEqual(boundMatch, null, '`NAME_BOUND` is gone from probe.js');
  const selectorBound = text.match(/var SELECTOR_BOUND = (\d+);/);
  assert.notEqual(selectorBound, null, '`SELECTOR_BOUND` is gone from probe.js');
  const controls = text.match(/var CONTROL_CHARACTERS = .*;/);
  assert.notEqual(controls, null, '`CONTROL_CHARACTERS` is gone from probe.js');
  const namespace = text.match(/var HTML_NAMESPACE = .*;/);
  assert.notEqual(namespace, null, '`HTML_NAMESPACE` is gone from probe.js');
  const source = [
    `var NAME_BOUND = ${boundMatch[1]};`,
    `var SELECTOR_BOUND = ${selectorBound[1]};`,
    controls[0],
    namespace[0],
    liftFunction(text, 'isHighSurrogate'),
    liftFunction(text, 'isLowSurrogate'),
    liftFunction(text, 'hasNameSubstance'),
    liftFunction(text, 'sanitizeForTransport'),
    // The shared bounding gesture `bounded` now delegates to — and which `text` and
    // `value` use too. Lifted BEFORE `bounded`, which calls it.
    liftFunction(text, 'boundedField'),
    liftFunction(text, 'bounded'),
    liftFunction(text, 'escapeAttributeValue'),
    liftFunction(text, 'composablePrefix'),
    liftFunction(text, 'prefixForSelector'),
    liftFunction(text, 'accessibleNameSelector'),
    liftFunction(text, 'accessibleName'),
  ].join('\n');
  return new Function(
    'document',
    `${source}; return { accessibleName: accessibleName, accessibleNameSelector: accessibleNameSelector, boundedField: boundedField, NAME_BOUND: NAME_BOUND, SELECTOR_BOUND: SELECTOR_BOUND };`,
  );
}

/** Composes straight from an element, the way `describeElement` does. */
function selectorFor(attributes, document = NO_DOCUMENT) {
  const { accessibleName, accessibleNameSelector } = liftNaming()(document);
  return accessibleNameSelector(accessibleName(element(attributes)));
}

/** Kept so the existing tests read unchanged where the change does not concern them. */
function liftAccessibleName() {
  return (document) => liftNaming()(document).accessibleName;
}

/** The smallest element this function actually needs: `getAttribute`, nothing else. */
function element(attributes) {
  return { getAttribute: (key) => (key in attributes ? attributes[key] : null) };
}

const NO_DOCUMENT = { getElementById: () => null };

test('nothing to report when the four attributes are empty', () => {
  const accessibleName = liftAccessibleName()(NO_DOCUMENT);
  assert.equal(accessibleName(element({})), null);
  assert.equal(accessibleName(null), null);
  // An element without `getAttribute` is not an element — it must not throw.
  assert.equal(accessibleName({}), null);
});

test('every source is reported by name, never inferred by the caller', () => {
  const accessibleName = liftAccessibleName()(NO_DOCUMENT);
  for (const attribute of ['aria-label', 'alt', 'placeholder', 'title']) {
    assert.deepEqual(accessibleName(element({ [attribute]: 'a name' })), {
      value: 'a name',
      from: attribute,
      truncated: false,
      length: 6,
      raw: 'a name',
    });
  }
});

test('the W3C order holds, and it is what makes a composed selector correct', () => {
  const accessibleName = liftAccessibleName()(NO_DOCUMENT);
  // The real case that sent this here: a control whose name is on `aria-label`
  // while its `placeholder` says something else entirely. Preferring the
  // placeholder would hand back a selector that does not resolve.
  const all = element({
    'aria-label': 'the name',
    alt: 'the alt',
    placeholder: 'the placeholder',
    title: 'the title',
  });
  assert.deepEqual(accessibleName(all), {
    value: 'the name',
    from: 'aria-label',
    truncated: false,
    length: 8,
    raw: 'the name',
  });
  assert.equal(accessibleName(element({ alt: 'x', placeholder: 'y', title: 'z' })).from, 'alt');
  assert.equal(accessibleName(element({ placeholder: 'y', title: 'z' })).from, 'placeholder');
  assert.equal(accessibleName(element({ title: 'z' })).from, 'title');
});

test('aria-labelledby wins, and says so — because it is the one that cannot compose', () => {
  const document = {
    getElementById: (id) => (id === 'lbl' ? { textContent: 'from elsewhere' } : null),
  };
  const accessibleName = liftAccessibleName()(document);
  assert.deepEqual(accessibleName(element({ 'aria-labelledby': 'lbl', 'aria-label': 'ignored' })), {
    value: 'from elsewhere',
    from: 'aria-labelledby',
    truncated: false,
    length: 14,
    raw: 'from elsewhere',
  });
  // An id list that resolves to nothing must FALL BACK, not report an empty name:
  // a blank `value` would read as "this element has no name" and hide the label.
  assert.deepEqual(accessibleName(element({ 'aria-labelledby': 'absent', 'aria-label': 'used' })), {
    value: 'used',
    from: 'aria-label',
    truncated: false,
    length: 4,
    raw: 'used',
  });
});

test('a name is trimmed, collapsed and bounded — it is a handle, not a payload', () => {
  const accessibleName = liftAccessibleName()(NO_DOCUMENT);
  assert.equal(accessibleName(element({ 'aria-label': '  spaced \n  out  ' })).value, 'spaced out');
  // Whitespace only is not a name.
  assert.equal(accessibleName(element({ 'aria-label': '   ' })), null);
  const long = accessibleName(element({ 'aria-label': 'x'.repeat(200) }));
  assert.equal(long.value.length, 80, 'the 80-char bound is what keeps a map readable');
  // ⭐ The bound is allowed to stay ONLY because it is now reported. An unreported
  // cut is what produced a selector resolving to zero nodes.
  assert.equal(long.truncated, true);
  assert.equal(accessibleName(element({ 'aria-label': 'x'.repeat(80) })).truncated, false);
});

/**
 * ⭐ THE SHARED BOUNDING GESTURE — and what these assertions can and cannot prove.
 *
 * They pin the ARITHMETIC of the cut: what `length` counts, when `truncated` flips,
 * and that normalising is opt-in per field. They CANNOT prove the numbers reach a
 * caller, and that distinction is the whole point of this repair: `bounded()` had
 * computed `truncated` correctly since the first round, and `describeElement`
 * dropped it on the floor. Every unit test here was green throughout. ⇒ The
 * emission proof is in `test/live-check.mjs`, against a real map.
 */
test('the bound is reported, not merely applied — length counts the NORMALISED text', () => {
  const { boundedField, NAME_BOUND } = liftNaming()(NO_DOCUMENT);

  const short = boundedField('ok', true);
  assert.deepEqual(short, { value: 'ok', length: 2, truncated: false });

  // Exact AT the boundary, not merely near it: 80 is whole, 81 is cut.
  assert.equal(boundedField('b'.repeat(NAME_BOUND), true).truncated, false);
  assert.equal(boundedField('c'.repeat(NAME_BOUND + 1), true).truncated, true);

  // ⚔ THE MEASURED CASE (2026-08-16): 200 characters in, 80 reported, and nothing
  // said so. `length` is what tells the reader 120 are missing.
  const long = boundedField('a'.repeat(200), true);
  assert.equal(long.value.length, NAME_BOUND);
  assert.equal(long.length, 200);
  assert.equal(long.truncated, true);

  // ⛔ `length` IS THE NORMALISED LENGTH. Were it the raw one, this case would
  // report 18 for a 12-character display and read as a truncation that never
  // happened — trading a false negative for a false positive.
  assert.deepEqual(boundedField('  deux   espaces  ', true), {
    value: 'deux espaces',
    length: 12,
    truncated: false,
  });

  // Normalising is per-field, and a control's VALUE keeps its blanks: it is a
  // working payload, re-read to answer « did my input take? ».
  assert.deepEqual(boundedField('  a   b  ', false), {
    value: '  a   b  ',
    length: 9,
    truncated: false,
  });

  // An empty value is a value. Reporting it as absent is a different claim.
  assert.deepEqual(boundedField('', false), { value: '', length: 0, truncated: false });
});

/**
 * WHAT THE SELECTOR TESTS PIN, AND WHAT THEY CANNOT.
 *
 * They pin the FORM of the composed selector — the operator, the escaping, the null.
 * They do NOT prove it RESOLVES: there is no DOM here, and a string that looks like
 * a selector is exactly the false green this whole defect was made of. The
 * resolution proof is made against the running app, where the same three cases are
 * replayed through `document.querySelectorAll`.
 */
test('a whole name composes an exact selector', () => {
  const { accessibleName, accessibleNameSelector } = liftNaming()(NO_DOCUMENT);
  const named = accessibleName(element({ 'aria-label': 'Réglages (Ctrl+,)' }));
  assert.equal(accessibleNameSelector(named), '[aria-label="Réglages (Ctrl+,)"]');
  assert.equal(accessibleNameSelector(null), null);
});

test('the DISPLAY bound never widens the selector — the two bounds are independent', () => {
  const { accessibleName, accessibleNameSelector, NAME_BOUND, SELECTOR_BOUND } =
    liftNaming()(NO_DOCUMENT);
  assert.ok(SELECTOR_BOUND > NAME_BOUND, 'the selector may carry more than the map shows');

  // ⭐ A name too long to DISPLAY still composes an EXACT match, because the
  // selector is built from the raw value. The first fix got this wrong: it
  // widened to `^=` as soon as the DISPLAY was cut, losing precision for nothing.
  const longer = 'y'.repeat(NAME_BOUND + 20);
  const named = accessibleName(element({ title: longer }));
  assert.equal(named.truncated, true, 'the displayed name IS cut');
  assert.equal(accessibleNameSelector(named), `[title="${longer}"]`);

  // Only a value beyond the SELECTOR bound yields a prefix.
  const huge = 'z'.repeat(SELECTOR_BOUND + 50);
  const selector = accessibleNameSelector(accessibleName(element({ title: huge })));
  assert.equal(selector, `[title^="${'z'.repeat(SELECTOR_BOUND)}"]`);

  // And a short whole name still composes an equality match.
  assert.equal(accessibleNameSelector(accessibleName(element({ title: 'short' }))), '[title="short"]');
});

test('aria-labelledby composes NOTHING, and that is the honest answer', () => {
  const document = { getElementById: () => ({ textContent: 'label held elsewhere' }) };
  const { accessibleName, accessibleNameSelector } = liftNaming()(document);
  const named = accessibleName(element({ 'aria-labelledby': 'lbl' }));
  // The name is still reported — it is what the element IS. Only the selector is
  // withheld, because no attribute selector over THIS element can carry it.
  assert.equal(named.value, 'label held elsewhere');
  assert.equal(accessibleNameSelector(named), null);
});

test('quotes and backslashes are escaped — they made querySelector THROW', () => {
  const { accessibleName, accessibleNameSelector } = liftNaming()(NO_DOCUMENT);
  const named = accessibleName(element({ title: 'dit "bonjour" \\ ok' }));
  assert.equal(accessibleNameSelector(named), '[title="dit \\"bonjour\\" \\\\ ok"]');
  // Every quote inside the value must be preceded by a backslash — otherwise the
  // string closes early and the selector is a SyntaxError, not a miss.
  const body = accessibleNameSelector(named).slice('[title="'.length, -2);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '"') assert.equal(body[i - 1], '\\', 'an unescaped quote closes the string');
  }
});

/**
 * ⭐ WHAT THE SECOND ROUND OF THIS DEFECT TAUGHT — pinned here because it is the
 * part that looked finished and was not.
 *
 * The first fix composed the selector from the DISPLAYED name (normalised,
 * bounded). `querySelector` compares against the attribute as the DOM holds it,
 * so every element whose attribute carries a blank the normalisation eats got a
 * selector resolving to ZERO nodes — the very failure the fix existed to remove,
 * one level down. Found by independent falsification, on a REAL element of ona.
 *
 * ⚠ Every exotic character below is written as an ESCAPE, never as a literal: a
 * literal NBSP or BOM in a source file is invisible in review and in a diff.
 *
 * These tests pin FORM only. The resolution proof is made in a live webview.
 */
test('the selector is built from the RAW attribute, never from the displayed name', () => {
  // Each of these is eaten by `\s+ -> ' '` and/or `trim()`, and each one made the
  // previous selector miss. The displayed name stays normalised — it is for reading.
  const cases = [
    ' Reglages ',                  // edge spaces
    'Mode  focus',                 // inner double space
    'colonne\tvaleur',             // tab
    'Ctrl\u00a0+\u00a0,',          // NBSP — `\s` eats it, the DOM does not
    'avant\u2028apres',            // line separator
    'zero\ufeffwidth',             // BOM
  ];
  for (const raw of cases) {
    const { accessibleName, accessibleNameSelector } = liftNaming()(NO_DOCUMENT);
    const named = accessibleName(element({ title: raw }));
    assert.equal(named.raw, raw, 'the raw attribute must survive verbatim');
    const selector = accessibleNameSelector(named);
    const body = selector.slice('[title="'.length, -2);
    // What the selector carries is the RAW value (escapes aside), not the name.
    const unescaped = body.replace(/\\([0-9a-f]+) /g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)));
    assert.equal(unescaped, raw, `selector must carry the raw value, got ${JSON.stringify(body)}`);
  }
});

test('control characters are hex-escaped — a raw newline makes querySelector THROW', () => {
  const selector = selectorFor({ title: 'Ligne un\nLigne deux' });
  // `\a ` is the CSS hex escape for U+000A, closed by the space CSS requires.
  assert.equal(selector, '[title="Ligne un\\a Ligne deux"]');
  assert.ok(!selector.includes('\n'), 'a literal newline cannot live in a CSS string');
});

test('the cut never splits a surrogate pair — the fix must not reproduce the defect', () => {
  const { SELECTOR_BOUND } = liftNaming()(NO_DOCUMENT);
  // Place a 2-unit emoji so the bound falls INSIDE it.
  const raw = 'x'.repeat(SELECTOR_BOUND - 1) + '\u{1F4BE}' + ' tail';
  const selector = selectorFor({ title: raw });
  const body = selector.slice('[title^="'.length, -2);
  const last = body.charCodeAt(body.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'a lone high surrogate makes `^=` resolve to zero');
  assert.ok(selector.startsWith('[title^="'), 'an over-long value must yield a prefix match');
});

test('a NUL forces a prefix, because equality is unreachable through it', () => {
  const selector = selectorFor({ title: 'avant\u0000apres' });
  assert.equal(selector, '[title^="avant"]');
});

test('nothing composable yields null, never a selector matching everything', () => {
  // A value entirely cut away would leave `[title^=""]`, which matches EVERY
  // element carrying the attribute — worse than answering nothing.
  assert.equal(selectorFor({ title: '\u0000leading nul' }), null);
});

/**
 * ⭐ WHAT THE THIRD ROUND ADDED — the count, and why it matters more than the
 * cases it closes.
 *
 * Both earlier rounds failed the same way: a selector resolving to ZERO while
 * looking perfectly well-formed, with no way for a caller to tell. Reporting how
 * many elements the selector hits closes the CLASS rather than the instances —
 * `0` becomes readable in the map itself, and so does `7`.
 *
 * ⚠ `selectorMatchCount` needs a real `document`, so it is exercised in a live
 * webview, not here. What is pinned here is the TAG qualification, which narrows
 * the selector for free and must never be guessed on a non-HTML element.
 */
test('the selector is qualified by tag — but only when the tag is safe to lower-case', () => {
  const { accessibleName, accessibleNameSelector } = liftNaming()(NO_DOCUMENT);
  const named = accessibleName(element({ 'aria-label': 'Fermer' }));

  const html = { tagName: 'BUTTON', namespaceURI: 'http://www.w3.org/1999/xhtml' };
  assert.equal(accessibleNameSelector(named, html), 'button[aria-label="Fermer"]');

  // ⛔ SVG tag names are case-SENSITIVE in selectors: lower-casing `linearGradient`
  // would match nothing. The tag is dropped rather than guessed.
  const svg = { tagName: 'linearGradient', namespaceURI: 'http://www.w3.org/2000/svg' };
  assert.equal(accessibleNameSelector(named, svg), '[aria-label="Fermer"]');

  // No element at all (the function is also called without one) stays valid.
  assert.equal(accessibleNameSelector(named), '[aria-label="Fermer"]');
});


/**
 * ⭐ WHAT THE FOURTH ROUND ADDED — and every one of these was found by
 * falsification, never by the author.
 */
test('a lone surrogate ANYWHERE stops the selector, not only at the cut edge', () => {
  // ⚔ The first guard checked the LAST code unit for a HIGH surrogate only. A lone
  // LOW surrogate in front, and a lone HIGH surrogate in the middle, both sailed
  // into the selector and resolved to ZERO nodes. Position was never the property.
  const leading = selectorFor({ title: '\uDCBEabcdefgh' });
  assert.equal(leading, null, 'nothing composable before a leading lone surrogate');

  const middle = selectorFor({ title: 'abcdefgh\uD83Dijkl' });
  assert.equal(middle, '[title^="abcdefgh"]', 'the run BEFORE the lone half is still usable');

  // A well-formed pair must survive untouched — the guard must not eat real emoji.
  assert.equal(selectorFor({ title: 'ok \u{1F4BE} fin' }), '[title="ok \u{1F4BE} fin"]');
});

test('a value with no composable substance is NOT a name — it must fall through', () => {
  const { accessibleName } = liftNaming()(NO_DOCUMENT);
  // ⚔ An `aria-label` holding a single NUL MASKED a valid `title`: NUL is neither
  // whitespace nor trimmable, so it passed as a name and the W3C walk stopped.
  // The probe then answered « no selector can carry this » for an element that
  // `[title="…"]` reached in one hop — a false NEGATIVE, and the only member of
  // this family that the match count cannot expose.
  const masked = accessibleName(element({ 'aria-label': '\u0000', title: 'le vrai nom' }));
  assert.equal(masked.from, 'title', 'the NUL-only label must not win');
  assert.equal(masked.value, 'le vrai nom');

  // Same for a lone surrogate, and for a control character.
  assert.equal(accessibleName(element({ 'aria-label': '\uD83D', title: 'vrai' })).from, 'title');
  assert.equal(accessibleName(element({ 'aria-label': '\u0007', title: 'vrai' })).from, 'title');

  // ⚠ And a NBSP-only label still falls through, as it always did — that path went
  // through `trim()`. The two must agree, or the behaviour depends on which
  // invisible character happened to be used.
  assert.equal(accessibleName(element({ 'aria-label': '\u00a0', title: 'vrai' })).from, 'title');

  // Nothing at all anywhere stays null.
  assert.equal(accessibleName(element({ 'aria-label': '\u0000' })), null);
});

test('the selector bound is exact AT the boundary, not merely near it', () => {
  const { accessibleName, accessibleNameSelector, SELECTOR_BOUND } = liftNaming()(NO_DOCUMENT);
  // ⚔ A mutation turning `>` into `>=` survived the whole suite: every existing
  // case jumped OVER the boundary (bound + 50, bound + 20). A boundary is exactly
  // where an off-by-one lives, so it is tested exactly there.
  const at = 'y'.repeat(SELECTOR_BOUND);
  assert.equal(
    accessibleNameSelector(accessibleName(element({ title: at }))),
    `[title="${at}"]`,
    'a value of exactly SELECTOR_BOUND must still compose an EQUALITY',
  );
  const over = 'y'.repeat(SELECTOR_BOUND + 1);
  assert.equal(
    accessibleNameSelector(accessibleName(element({ title: over }))),
    `[title^="${'y'.repeat(SELECTOR_BOUND)}"]`,
    'one character more must switch to a prefix',
  );
});


/**
 * ⭐ ONE POISONED ELEMENT MUST NEVER COST THE WHOLE ANSWER.
 *
 * ⚔ MEASURED 2026-08-16 — and found by the live harness built to judge the
 * selector, not by reasoning: a page carrying ONE element whose name held a lone
 * surrogate made the ENTIRE map unreadable across the reply channel
 * (« unexpected end of hex escape at line 1 column 5495 »). Not that row — every
 * row, for the whole page. Dropping the offending cases made the same map parse.
 *
 * ⚠ An earlier analysis had concluded « the channel holds », having tested
 * `JSON.stringify` and `encodeURIComponent` in isolation. The real path said
 * otherwise. A negative on a component is not a negative on the system.
 */
test('a lone surrogate in a NAME cannot poison the whole map', () => {
  const { accessibleName } = liftNaming()(NO_DOCUMENT);
  const REPLACEMENT = '�';

  const lone = accessibleName(element({ 'aria-label': 'avant \uD83D apres' }));
  assert.equal(lone.value, `avant ${REPLACEMENT} apres`, 'a lone half becomes U+FFFD');
  assert.ok(!/[\uD800-\uDFFF]/.test(lone.value) || /💾/.test(lone.value));

  // ⛔ A well-formed pair must survive untouched — sanitising must not eat emoji.
  const pair = accessibleName(element({ 'aria-label': 'ok \u{1F4BE} fin' }));
  assert.equal(pair.value, 'ok \u{1F4BE} fin');

  // ⚠ `raw` is NOT sanitised: it never leaves the page, and the selector is
  // composed from it. Sanitising it would corrupt the very thing that must match.
  assert.equal(pair.raw, 'ok \u{1F4BE} fin');
  assert.equal(lone.raw, 'avant \uD83D apres', 'raw keeps the page verbatim');
});
