/**
 * The fingerprint of `probe.js` — what makes a live verdict mean something.
 *
 * ⭐ WHY THIS EXISTS. The probe already exposed a version number. It said `2`, and
 * `2` designated FOUR different contracts at once — measured on the binaries
 * themselves on 2026-08-16:
 *
 *     aworan-app     version 2, no accessible name at all
 *     ona-app        version 2, no accessible name at all
 *     obatala-app    version 2, accessibleNameSelector but no match count
 *     oshun (live)   version 2, the current contract
 *
 * So a harness pointed at « a light table » that comes back GREEN does not say
 * WHICH code is green. That is the very shape of the false green this whole module
 * was built to kill, moved up one floor: instead of a selector that silently
 * resolves to nothing, a harness that silently validates an unknown.
 *
 * ⚠ And the failure is ASYMMETRIC, which makes it worse. Against a stale app the
 * harness goes red — loud, someone fixes it. Against a freshly rebuilt one it goes
 * green — and it goes green in EXACTLY the same way whether the other ten binaries
 * are current or eight months old. The green carries no information about
 * deployment.
 *
 * ⇒ `probe.js` carries a fingerprint of its own text, `map()` reports it, and
 * `live-check.mjs` REFUSES to judge when it does not match the `probe.js` sitting
 * next to it. A verdict on an unknown text is not a verdict.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *
 *   node test/fingerprint.mjs           # print the fingerprint of src/probe.js
 *   node test/fingerprint.mjs --write   # stamp it into src/probe.js
 *   node test/fingerprint.mjs --check   # exit 1 if the stamp is stale
 *
 * ⛔ The hash is computed over the file with its own stamp line NEUTRALISED —
 * otherwise writing the hash would change the hash it is supposed to describe.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'probe.js');
const STAMP = /var PROBE_FINGERPRINT = '([0-9a-f]*)';/;
const NEUTRAL = "var PROBE_FINGERPRINT = '';";

export function fingerprintOf(text) {
  if (!STAMP.test(text)) {
    throw new Error('probe.js carries no PROBE_FINGERPRINT line — nothing to stamp');
  }
  const neutralised = text.replace(STAMP, NEUTRAL);
  return createHash('sha256').update(neutralised, 'utf8').digest('hex').slice(0, 12);
}

export function readProbe() {
  return readFileSync(PROBE, 'utf8');
}

function main() {
  const mode = process.argv[2];
  const text = readProbe();
  const expected = fingerprintOf(text);
  const stamped = (text.match(STAMP) || [])[1];

  if (mode === '--write') {
    writeFileSync(PROBE, text.replace(STAMP, `var PROBE_FINGERPRINT = '${expected}';`));
    console.log(`stamped ${expected}`);
    return;
  }
  if (mode === '--check') {
    if (stamped !== expected) {
      console.error(`⛔ stale fingerprint: probe.js is stamped ${stamped || '(empty)'} but hashes to ${expected}`);
      console.error('   run: node test/fingerprint.mjs --write');
      process.exit(1);
    }
    console.log(`✅ fingerprint up to date (${expected})`);
    return;
  }
  console.log(expected);
}

if (process.argv[1] && process.argv[1].endsWith('fingerprint.mjs')) main();
