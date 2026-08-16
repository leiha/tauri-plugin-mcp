/**
 * Renders the fixture back into a page. Nothing is read from any original page: if
 * the fixture lost a character on the way out, this page no longer reproduces the
 * measurements, and the verifier says so.
 *
 * ⭐ ORIGIN — this fixture, its encoding and its `status`/`shouldBe` discipline were
 * built by the independent falsification hand that killed four successive repairs
 * of `accessibleNameSelector` on 2026-08-16. Every value in it was MEASURED in a
 * live webview, never reasoned about. Versioned here so it outlives the session.
 *
 *   node test/fixtures/fixture-to-page.mjs [output.html]
 *
 * ⚠ Values are ASCII by construction: each one is the inside of a JSON string, so
 * a NBSP, a BOM or a lone surrogate appears as an escape and can be reviewed. Runs
 * of 20+ identical characters are folded as `{{c*N}}`, or the file is unreadable.
 * The folded character may itself be a surrogate PAIR — written
 * `{{\ud83d\ude00*40}}` in the fixture, so it stays ASCII on disk. Added with the
 * hors-BMP bounded cases, whose whole point is that 40 emoji are 80 units, 40 code
 * points and 160 bytes at once, and that an ASCII-only corpus cannot tell the three
 * apart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = process.argv[2] || join(here, 'accessible-name-page.html');
const fixture = JSON.parse(readFileSync(join(here, 'fixture-accessible-name.json'), 'utf8'));

const page = `<meta charset="utf-8">
<title>fixture replay — accessibleNameSelector</title>
<style>body{font:12px/1.4 system-ui,sans-serif;padding:1rem}button,input{display:block;margin:.1rem 0;min-width:200px;text-align:left}</style>
<h1>Rejeu de la fixture</h1>
<div id="host"></div>
<div id="parsed"></div>
<div id="bounded"></div>
<script id="fixture" type="application/json">${JSON.stringify(fixture)}</script>
<script>
  var fixture = JSON.parse(document.getElementById('fixture').textContent);

  // Decode: JSON string escapes first, then the {{c*N}} run tokens.
  // ⛔ The repeated CHARACTER may be a surrogate PAIR, and the alternation has to come
  // first because \`.\` matches a single UTF-16 unit — it would fold half an emoji and
  // hand the page a text made of orphans, which is precisely the defect the hors-BMP
  // cases exist to catch. Written out, 100 emoji cost 1200 characters of escapes in a
  // fixture whose encoding rule exists to keep long runs readable.
  function decode(encoded) {
    var text = JSON.parse('"' + encoded + '"');
    return text.replace(/\\{\\{([\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|.)\\*(\\d+)\\}\\}/g, function (whole, character, count) {
      return new Array(Number(count) + 1).join(character);
    });
  }

  var host = document.getElementById('host');
  var label = document.createElement('span');
  label.id = 'lbl-1';
  label.textContent = 'Ouvrir le panneau';
  host.appendChild(label);

  fixture.attributeCases.forEach(function (c) {
    var b = document.createElement('button');
    b.id = c.id;
    Object.keys(c.attributes).forEach(function (k) { b.setAttribute(k, decode(c.attributes[k])); });
    b.textContent = c.id;
    host.appendChild(b);
  });

  var wrap = document.createElement('div');
  wrap.id = 'c-nested-parent';
  wrap.setAttribute('role', 'button');
  wrap.setAttribute('aria-label', 'Zone de reglages');
  wrap.appendChild(document.getElementById('c-nested-child'));
  host.appendChild(wrap);

  document.getElementById('parsed').innerHTML =
    fixture.parsedCases.map(function (c) { return c.html; }).join('');

  // The bounded-field family: built element by element rather than from an HTML
  // string, because these cases carry LEADING and TRAILING blanks that matter, and
  // innerHTML would hand them to the parser instead of to the DOM property.
  var boundedHost = document.getElementById('bounded');
  (fixture.boundedFieldCases || []).forEach(function (c) {
    var el = document.createElement(c.tag);
    el.id = c.id;
    Object.keys(c.attributes || {}).forEach(function (k) {
      el.setAttribute(k, decode(c.attributes[k]));
    });
    if (c.text) el.textContent = decode(c.text);
    boundedHost.appendChild(el);
  });
</script>
`;

writeFileSync(OUTPUT, page);
const built =
  fixture.attributeCases.length + fixture.parsedCases.length +
  (fixture.boundedFieldCases || []).length + 1;
console.log(`${OUTPUT}\n  written from the fixture alone: ${built} elements`);
