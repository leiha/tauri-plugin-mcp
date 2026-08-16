/**
 * A MAP MUST NOT CARRY SECRETS OFF THE PAGE.
 *
 * WHAT THIS PINS, and why it is not a style preference. `map()` is a PASSIVE SWEEP:
 * a caller asks "what is on this page?" and gets every value on it. Measured on a
 * canary page on 2026-08-16, that included the password in clear text —
 * `type: "password"` sitting next to `value: "SUPERSECRET-CANARY-9931"` — copied into
 * an agent's context and from there into transcripts and logs, by a reader who never
 * asked for it and cannot unsee it.
 *
 * ⭐ THE ECHO IS NOT THE SWEEP. `inspect_fill` still returns the value it read back,
 * deliberately: there the caller supplied the secret one call earlier, so echoing it
 * discloses nothing, and `accepted` would be unverifiable without it. Do not "fix"
 * that by symmetry — the asymmetry is the design.
 *
 * ⚠ IT READS THE SHIPPED SOURCE rather than a copy: `probe.js` is an IIFE with no
 * exports, so functions are lifted out of the file by name. A rename or a removal
 * fails loudly instead of passing against a stale duplicate.
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
 * ⚠ KNOWINGLY A TWIN of the helper in `accessible-name.test.mjs`. Hoisting it into a
 * shared module would mean editing a 502-line file that this change does not
 * otherwise touch, to spare twenty lines — the wrong trade while a repair is in
 * flight. Whoever next opens that file should hoist it and delete this copy.
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

const loadIsSecretField = () => {
  const lifted = liftFunction(readFileSync(SOURCE, 'utf8'), 'isSecretField');
  return new Function(`${lifted}; return isSecretField;`)();
};

/** A control with just enough surface for the predicate — no DOM needed. */
const control = (type, autocomplete) => ({
  type,
  getAttribute: (name) => (name === 'autocomplete' ? (autocomplete ?? null) : null),
});

test('a password field is a secret, whatever else it carries', () => {
  const isSecretField = loadIsSecretField();

  assert.equal(isSecretField(control('password', null)), true);
  assert.equal(isSecretField(control('PASSWORD', null)), true);
  assert.equal(isSecretField(control('password', 'current-password')), true);
});

test('a secret hides behind type=text, and autocomplete is the only tell', () => {
  const isSecretField = loadIsSecretField();

  // ⛔ These are the cases a type check alone would leak. A one-time code and a
  // password-manager field are routinely `type="text"`.
  assert.equal(isSecretField(control('text', 'current-password')), true);
  assert.equal(isSecretField(control('text', 'new-password')), true);
  assert.equal(isSecretField(control('text', 'one-time-code')), true);
  assert.equal(isSecretField(control('text', 'ONE-TIME-CODE')), true);
  assert.equal(isSecretField(control('text', 'section-blue billing new-password')), true);
});

test('card fields are secrets too — the sweep does not care what KIND of secret it is', () => {
  const isSecretField = loadIsSecretField();

  // ⚠ Added 2026-08-16 after an independent attack observed the first version stopped
  // at passwords. The page that motivated this whole repair is a booking dashboard
  // showing settled payments — card fields are not hypothetical there.
  assert.equal(isSecretField(control('text', 'cc-number')), true);
  assert.equal(isSecretField(control('text', 'cc-csc')), true);
  assert.equal(isSecretField(control('text', 'cc-exp')), true);
  // `cc-exp` is a prefix on purpose, so the two dated variants need no naming.
  assert.equal(isSecretField(control('text', 'cc-exp-month')), true);
  assert.equal(isSecretField(control('text', 'cc-exp-year')), true);
  assert.equal(isSecretField(control('text', 'section-pay shipping cc-number')), true);
});

test('what redaction does NOT claim to catch — stated, so it is not mistaken for coverage', () => {
  const isSecretField = loadIsSecretField();

  // ⛔ NOT A BUG, A BORDER. Matching `name`/`id` substrings is a guess, not a contract:
  // `password-hint` and `password-strength-meter` are ordinary readable fields, and a
  // flag that fires on a guess teaches callers to distrust it. This test exists so the
  // gap is DELIBERATE and visible, rather than discovered later as an oversight. If it
  // ever goes red, someone widened the rule — make sure they meant to.
  assert.equal(isSecretField(control('text', null)), false);
  assert.equal(
    isSecretField({ type: 'text', name: 'password', getAttribute: () => null }),
    false,
    'a plain text field named "password" is NOT redacted — see the note in probe.js',
  );
});

test('ordinary controls stay readable — over-redacting blinds the caller', () => {
  const isSecretField = loadIsSecretField();

  // Without these, the test could not go red for the right reason: a predicate that
  // answered `true` to everything would pass every case above.
  assert.equal(isSecretField(control('text', null)), false);
  assert.equal(isSecretField(control('text', 'email')), false);
  assert.equal(isSecretField(control('text', 'username')), false);
  assert.equal(isSecretField(control('checkbox', null)), false);
  assert.equal(isSecretField(control('hidden', null)), false);
  assert.equal(isSecretField(control('', null)), false);
});

test('a malformed element is not a crash — an observer must never break its subject', () => {
  const isSecretField = loadIsSecretField();

  assert.equal(isSecretField(null), false);
  assert.equal(isSecretField(undefined), false);
  assert.equal(isSecretField({}), false);
});

test('the secret does not escape by `text` either — a textarea IS its own value', () => {
  // ⚔ THE HOLE AN INDEPENDENT ATTACK FOUND IN THIS VERY REPAIR, hours after it
  // shipped. `<textarea autocomplete="one-time-code">SECRET</textarea>` came back with
  // `value: null` and `valueRedacted: true` — the guard working perfectly — and
  // `text: "SECRET"` on the same line, because for a textarea `textContent` IS the
  // value. Redacting one field while a neighbour publishes is not a redaction.
  const describe = liftFunction(readFileSync(SOURCE, 'utf8'), 'describeElement');

  assert.match(
    describe,
    /var secret = isSecretField\(el\)/,
    '`describeElement` no longer consults the secret guard — `text` leaks again',
  );
  // The guard must GOVERN the text field, not merely be computed next to it.
  // ⛔ THE FIRST VERSION OF THIS ASSERTION DID NOT BITE. It sliced the assignment
  // with `/var textField\s*=([\s\S]*?);\n/` and looked for `secret` inside — but a
  // trailing comment pushes the `;` off the end of its line, so the capture ran on
  // and swallowed the guard it was supposed to be missing. Removing the guard left
  // all nine cases GREEN. Caught by mutation, never by reading — the fourth test of
  // the day to need it. The shape below cannot run on: it demands the ternary sit
  // immediately before the call it is meant to bypass.
  assert.match(
    describe,
    /secret\s*\n?\s*\?[\s\S]{0,160}boundedField\(el\.innerText/,
    '`describeElement` builds `text` without consulting the guard — a textarea would leak',
  );
  // And the flag must live here, so EVERY surface carries it — not only `map()`.
  assert.match(
    describe,
    /valueRedacted: secret/,
    'the redaction flag left the shared descriptor — click/fill would publish silently',
  );
});

test('map() actually CONSULTS the predicate — keeping it unused would leak just as much', () => {
  // ⛔ The predicate can be perfect and the leak remain: the defect was never in
  // knowing what a password is, it was in copying values without asking. This pins
  // the call site, which is the part that actually stops the disclosure.
  const map = liftFunction(readFileSync(SOURCE, 'utf8'), 'map');

  assert.match(map, /isSecretField\(el\)/, '`map()` no longer consults `isSecretField`');
  assert.match(map, /valueRedacted/, '`map()` no longer reports that a value was withheld');

  // ⭐ CALLING THE GUARD IS NOT BEING GOVERNED BY IT, and the difference is the whole
  // test. The first draft asserted only that `isSecretField(el)` appeared somewhere in
  // `map()`. Removing `|| secret` from the value expression re-opened the leak in full
  // — and all six tests stayed green, because the CALL was still there, computing a
  // `secret` nobody used. Caught on 2026-08-16 by mutating the source on purpose; it
  // would never have shown up by reading. So the assertion now reads the value
  // EXPRESSION itself and demands the guard inside it.
  const valueExpression = /var valueField\s*=([\s\S]*?);/.exec(map);
  assert.notEqual(valueExpression, null, '`map()` no longer computes `valueField`');
  assert.match(
    valueExpression[1],
    /\bsecret\b/,
    '`map()` computes a value without consulting the secret guard — the leak is back',
  );
});

test('a withheld value is DISTINGUISHABLE from an absent one', () => {
  // A button has no value; a password field has one that is deliberately not shown.
  // If both came back as `value: null` alone, a reader would take the password field
  // for empty and go hunting for the value elsewhere — which is how a redaction turns
  // into a wild goose chase. `valueRedacted` is what separates the two.
  const map = liftFunction(readFileSync(SOURCE, 'utf8'), 'map');

  assert.match(
    map,
    /d\.valueRedacted\s*=\s*secret/,
    '`map()` no longer marks WHY a value is missing',
  );
  // The length of a password is itself a secret: it must not survive the redaction.
  assert.match(
    map,
    /d\.valueLength\s*=\s*valueField\s*\?/,
    '`map()` reports a length outside the guarded path — a password length would leak',
  );
});
