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
 * Lifts `accessibleName` out of the IIFE by brace matching.
 *
 * ⛔ Deliberately NOT a regex over the whole body: the function contains braces,
 * and a lazy match would cut it at the first `}` and then test a fragment that
 * happens to parse. Counting braces fails loudly instead.
 */
function liftAccessibleName() {
  const text = readFileSync(SOURCE, 'utf8');
  const start = text.indexOf('function accessibleName(');
  assert.notEqual(start, -1, '`accessibleName` is gone from probe.js — renamed, or removed');
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
  assert.notEqual(end, -1, 'unbalanced braces while lifting `accessibleName`');
  const factory = new Function('document', `${text.slice(start, end)}; return accessibleName;`);
  return factory;
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
  assert.deepEqual(accessibleName(all), { value: 'the name', from: 'aria-label' });
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
  });
  // An id list that resolves to nothing must FALL BACK, not report an empty name:
  // a blank `value` would read as "this element has no name" and hide the label.
  assert.deepEqual(accessibleName(element({ 'aria-labelledby': 'absent', 'aria-label': 'used' })), {
    value: 'used',
    from: 'aria-label',
  });
});

test('a name is trimmed, collapsed and bounded — it is a handle, not a payload', () => {
  const accessibleName = liftAccessibleName()(NO_DOCUMENT);
  assert.equal(accessibleName(element({ 'aria-label': '  spaced \n  out  ' })).value, 'spaced out');
  // Whitespace only is not a name.
  assert.equal(accessibleName(element({ 'aria-label': '   ' })), null);
  const long = accessibleName(element({ 'aria-label': 'x'.repeat(200) })).value;
  assert.equal(long.length, 80, 'the 80-char bound is what keeps a map readable');
});
