// Tauri MCP universal probe — console, network, and a reply channel that works
// on ANY page, including one the host application does not own.
//
// WHY THIS EXISTS
//   Every other instrument in this plugin answers through `emit_and_wait`: the host
//   emits a Tauri event and waits for the page to emit a correlated reply. The
//   listener that replies lives in `guest-js/index.ts`, which a page loads only if
//   its own bundle imports it. A remote page never does — so `get_dom`,
//   `execute_js` and the rest time out on exactly the pages an agent most needs to
//   look at. Measured 2026-08-07 on an oshun lightbox tab:
//   "Timeout waiting for got-dom-content response".
//
//   The outbound half was never the problem: `on_page_load` already runs
//   `webview.eval(...)` on every page, ours or not. What was missing is the way
//   BACK.
//
// THE REPLY CHANNEL, and why cookies
//   Rust reads `webview.cookies()` NATIVELY (`tools/cookies.rs:30`) — no IPC, no
//   event, no listener, no permission. So the page writes its answer into cookies
//   and the host reads them directly. The alternatives were each ruled out:
//     · Tauri events   → need `guest-js` and an ACL the page does not have;
//     · a local HTTP endpoint → blocked as mixed content from an https page;
//     · `location.hash` → universal, but it rewrites the URL and breaks
//       hash-routed applications.
//   Cookies are the only channel that is native on the host side AND free of
//   permissions on the page side.
//
// ⚠ ITS LIMITS, stated rather than discovered later
//   · A cookie holds ~4 KB, so answers are CHUNKED and reassembled by the host.
//   · A page with no cookie jar (`file://`, some sandboxes) cannot reply. Serve
//     over http/https — which is what the lightbox already does.
//   · Everything here is best-effort and MUST NOT break the page it observes: the
//     whole body is wrapped, every hook falls through to the original, and a
//     failure to instrument is silent by design. An observer that breaks its
//     subject is worse than no observer.
(function () {
    if (typeof window === 'undefined' || window.__TMCP__) return;

    var MAX_CONSOLE = 500;     // ring buffer — a chatty page must not eat memory
    var MAX_NETWORK = 500;
    var CHUNK = 3000;          // conservative: cookie limit is ~4096 including the name
    var PREFIX = '__tmcp_';

    /**
     * ⭐ THE IDENTITY OF THIS TEXT — not a version number.
     *
     * `version` below says `2`, and `2` has designated FOUR different contracts on
     * four binaries at the same time (measured 2026-08-16). A number a human bumps
     * cannot identify a text; a hash of the text can. `map()` reports it, and
     * `test/live-check.mjs` REFUSES to judge a map whose fingerprint does not match
     * the `probe.js` it was launched from — because a verdict on an unknown text is
     * not a verdict.
     * ⚠ Maintained by `node test/fingerprint.mjs --write`; never edit by hand.
     */
    var PROBE_FINGERPRINT = 'dd6980e001c7';

    var consoleLog = [];
    var networkLog = [];
    var started = Date.now();

    function push(buf, entry, max) {
        buf.push(entry);
        if (buf.length > max) buf.shift();
    }

    function stamp() {
        return Date.now() - started;
    }

    // ── console ──────────────────────────────────────────────────────────────
    // Hooked at PageLoadEvent::Started, so BEFORE the page's own script runs.
    // That ordering is the whole point: a console buffer installed later would
    // miss the boot errors, which are the ones worth having.
    try {
        var LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
        for (var i = 0; i < LEVELS.length; i++) {
            (function (level) {
                var original = console[level];
                console[level] = function () {
                    try {
                        var parts = [];
                        for (var j = 0; j < arguments.length; j++) {
                            parts.push(describe(arguments[j]));
                        }
                        push(consoleLog, { at: stamp(), level: level, text: parts.join(' ') }, MAX_CONSOLE);
                    } catch (e) { /* never break the page's own logging */ }
                    if (original) return original.apply(console, arguments);
                };
            })(LEVELS[i]);
        }

        window.addEventListener('error', function (e) {
            push(consoleLog, {
                at: stamp(), level: 'uncaught',
                text: String(e && e.message) + ' @ ' + String(e && e.filename) + ':' + String(e && e.lineno)
            }, MAX_CONSOLE);
        });

        window.addEventListener('unhandledrejection', function (e) {
            push(consoleLog, {
                at: stamp(), level: 'unhandled-rejection',
                text: describe(e && e.reason)
            }, MAX_CONSOLE);
        });

        // ⭐ RESOURCE LOAD FAILURES — the hole that cost a whole diagnosis.
        //
        // A `<script>`, `<link>` or `<img>` that fails to load fires an `error` event on
        // the ELEMENT. It does not bubble, so it reaches `window` only in the CAPTURE
        // phase, and it goes through none of the hooks above — not `console.error`, not
        // the `window.onerror` handler, not `fetch`. Measured 2026-08-07: a dashboard
        // whose Vue bundle was blocked as mixed content left this buffer completely
        // empty, and the cause was found only by fetching the URL by hand.
        //
        // The `true` third argument is the whole point of this listener.
        window.addEventListener('error', function (e) {
            var el = e && e.target;
            if (!el || el === window || !el.tagName) return;   // already covered above
            var url = el.src || el.href || '';
            if (!url) return;
            push(consoleLog, {
                at: stamp(), level: 'resource-failed',
                text: el.tagName.toLowerCase() + ' did not load: ' + String(url)
            }, MAX_CONSOLE);
            push(networkLog, {
                at: stamp(), via: 'resource', method: 'GET', url: String(url),
                status: null, ms: null, failed: true,
                error: 'load failed (blocked, unreachable, or refused)'
            }, MAX_NETWORK);
        }, true);
    } catch (e) { /* instrumentation is best-effort */ }

    /** Renders an argument without ever throwing — a circular object must not kill the hook. */
    function describe(v) {
        if (typeof v === 'string') return v;
        if (v instanceof Error) return v.name + ': ' + v.message;
        try { return JSON.stringify(v); } catch (e) { return String(v); }
    }

    // ── network ──────────────────────────────────────────────────────────────
    // `fetch` and `XMLHttpRequest` are hooked because they carry the INTENT
    // (method, body, the caller's own URL). `performance.getEntriesByType` is kept
    // as a fallback in `snapshot()`: it sees every resource — images, styles,
    // beacons — but knows no status code. The two answer different questions and
    // both are exposed.
    try {
        var origFetch = window.fetch;
        if (origFetch) {
            window.fetch = function (input, init) {
                var url = typeof input === 'string' ? input : (input && input.url) || String(input);
                var method = (init && init.method) || (input && input.method) || 'GET';
                var t0 = Date.now();
                var entry = { at: stamp(), via: 'fetch', method: method, url: url, status: null, ms: null, failed: false };
                push(networkLog, entry, MAX_NETWORK);
                return origFetch.apply(this, arguments).then(function (res) {
                    entry.status = res.status;
                    entry.ms = Date.now() - t0;
                    return res;
                }, function (err) {
                    entry.failed = true;
                    entry.ms = Date.now() - t0;
                    entry.error = String(err);
                    throw err;
                });
            };
        }

        var XHR = window.XMLHttpRequest;
        if (XHR && XHR.prototype) {
            var origOpen = XHR.prototype.open;
            var origSend = XHR.prototype.send;
            XHR.prototype.open = function (method, url) {
                this.__tmcp = { method: method, url: url };
                return origOpen.apply(this, arguments);
            };
            XHR.prototype.send = function () {
                var self = this;
                var meta = self.__tmcp || {};
                var t0 = Date.now();
                var entry = {
                    at: stamp(), via: 'xhr', method: meta.method || 'GET',
                    url: meta.url || '', status: null, ms: null, failed: false
                };
                push(networkLog, entry, MAX_NETWORK);
                self.addEventListener('loadend', function () {
                    entry.status = self.status;
                    entry.ms = Date.now() - t0;
                    entry.failed = self.status === 0;
                });
                return origSend.apply(this, arguments);
            };
        }
    } catch (e) { /* instrumentation is best-effort */ }

    // ── the reply channel ────────────────────────────────────────────────────

    /** base64url without padding — `=` and `;` are cookie separators. */
    function encode(text) {
        var utf8 = unescape(encodeURIComponent(text));
        var b64 = btoa(utf8);
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function writeCookie(name, value) {
        // Session cookie, path-wide. No expiry: it must not outlive the page.
        document.cookie = name + '=' + value + ';path=/;SameSite=Lax';
    }

    function clearCookie(name) {
        document.cookie = name + '=;path=/;max-age=0;SameSite=Lax';
    }

    /** Serialises a settled result and writes it back as chunked cookies. */
    function deliver(id, payload) {
        var encoded = encode(payload);
        var chunks = [];
        for (var i = 0; i < encoded.length; i += CHUNK) chunks.push(encoded.slice(i, i + CHUNK));
        if (chunks.length === 0) chunks.push('');

        for (var k = 0; k < chunks.length; k++) writeCookie(PREFIX + id + '_' + k, chunks[k]);
        // Written LAST — the host polls for this one and only then reads the chunks.
        // Writing the count last is what makes a partially written answer unreadable
        // rather than silently truncated.
        writeCookie(PREFIX + id + '_n', String(chunks.length));
    }

    function ok(value) {
        return JSON.stringify({ ok: true, value: value === undefined ? null : value });
    }

    function ko(e) {
        return JSON.stringify({ ok: false, error: String((e && (e.message || e.reason)) || e) });
    }

    /**
     * Answers a request: evaluates `expression` and writes the result back.
     *
     * ⭐ IT AWAITS A THENABLE, and that is the whole reason this channel can do more
     * than read. Before, the value was serialised the instant `eval` returned, so a
     * promise came back as `{}` — a shape that reads like "empty", not like "not
     * ready". Measured 2026-08-07 on a live app: `1+1` returned `2`, and
     * `Promise.resolve(42)` returned `{}`. Every Tauri command returns a promise, so
     * `invoke('list_lightbox_tabs')` returned `{}` while four tabs were open, and the
     * caller read that as "no tabs". A silent empty is worse than an error.
     *
     * Awaiting here — rather than in each caller — is what lets everything ASYNCHRONOUS
     * ride the same channel: waiting for an element, observing what a click caused,
     * reading the outcome of a fetch. The action library below is built entirely on it
     * and needs no mechanism of its own.
     *
     * ⚠ There is deliberately NO page-side timeout. A promise that never settles is
     * held by the host's own deadline, which reports what it waited for. A second
     * timer here would race it and produce two different stories about one failure.
     */
    function answer(id, expression) {
        var value;
        try {
            /* eslint-disable no-eval */
            value = (0, eval)(expression);
        } catch (e) {
            deliver(id, ko(e));
            return;
        }

        // Duck-typed on purpose: a value from another realm (an iframe, a bundled
        // polyfill) is thenable without being `instanceof Promise`.
        if (value && typeof value.then === 'function') {
            try {
                value.then(
                    function (settled) { deliver(id, ok(settled)); },
                    function (rejection) { deliver(id, ko(rejection)); }
                );
            } catch (e) {
                deliver(id, ko(e));
            }
            return;
        }

        try {
            deliver(id, ok(value));
        } catch (e) {
            // A circular or non-serialisable value must answer, not hang.
            deliver(id, ko(e));
        }
    }

    function clear(id, count) {
        for (var k = 0; k < count; k++) clearCookie(PREFIX + id + '_' + k);
        clearCookie(PREFIX + id + '_n');
    }

    /** Resource timings — every request, including those no hook can see. */
    function timings() {
        try {
            if (!window.performance || !performance.getEntriesByType) return [];
            return performance.getEntriesByType('resource').map(function (r) {
                return {
                    via: 'timing', url: r.name, kind: r.initiatorType,
                    ms: Math.round(r.duration), at: Math.round(r.startTime), status: null
                };
            });
        } catch (e) { return []; }
    }

    // ── acting on the page ───────────────────────────────────────────────────
    //
    // WHY THESE LIVE HERE rather than as host-side commands
    //   The host already has `inspect_eval`, so any of these COULD be written as a
    //   one-off expression by each caller. They live here because the hard part is
    //   not reaching the page — it is doing the gesture in a way frameworks actually
    //   observe, and reporting an outcome that can be FALSIFIED. Both are easy to get
    //   subtly wrong, and a gesture that silently does nothing is the worst result
    //   this channel can produce.
    //
    // ⭐ EVERY ACTION RETURNS WHAT PROVES ITS EFFECT, never a bare `ok`. `fill` reads
    //   the value back; `click` reports what it actually hit. An action that could
    //   only ever answer "done" would be an instrument that cannot redden — the exact
    //   shape of a false green.
    //
    // ⚠ WHAT THIS IS NOT: a real input device. These are synthesised DOM events. A
    //   page that checks `event.isTrusted`, a cross-origin iframe, a native file
    //   picker, or an OS-level drag will not respond. For those, the host's
    //   `simulate_*` commands drive the real pointer — but they need the window to be
    //   focused and they cannot target a child webview. Stated here so the limit is
    //   read before it is hit.

    /** Resolves a selector or throws with the selector in the message. */
    function need(selector) {
        var el = document.querySelector(selector);
        if (!el) throw new Error('no element matches ' + JSON.stringify(selector));
        return el;
    }

    /**
     * The ACCESSIBLE NAME of an element — what the page itself already declares it
     * to be, for anyone who cannot see it.
     *
     * ⚔ WHY IT IS HERE, AND IT IS A MEASURED GAP. `describeElement` used to report
     * `id`, `name` and `text` only, and a control that has none of the three came
     * back INDISTINGUISHABLE — nothing but a build-hashed class such as
     * `svelte-1gt38sp`. MEASURED 2026-08-15 over three live surfaces (a Vite-served
     * cockpit, a local html file, an app shell): 36 interactive elements, 9 of them
     * mute that way, and **all 9** carried an accessible name the description threw
     * away. The two toolbar buttons that sent me looking said *« Mode focus (F11) »*
     * and *« Réglages (Ctrl+,) »* — a caller reading the map saw two identical
     * empty buttons and could name neither.
     *
     * 🔑 WHAT IT BUYS, precisely: a caller that must WRITE a selector gets one that
     * survives a rebuild. `button[aria-label="Réglages (Ctrl+,)"]` is authored
     * content; a hashed class is a build artefact and changes under it. A Svelte
     * `svelte-xxxxxxx` class is not even an element mark — it scopes the whole
     * COMPONENT, so it matches the section and every control inside it alike.
     *
     * ⚔ AND THE NAME ALONE IS NOT ENOUGH — measured the same day, by the first
     * attempt to USE it. Given only `« Adresse de la page à ouvrir »`, the caller
     * has to GUESS which of four attributes carries it; guessing `placeholder`
     * missed, because the name came from `aria-label` while the placeholder held
     * something else entirely. Reporting a name without its source is a handle that
     * cannot be turned. Hence `from`, which names the attribute.
     *
     * ⛔ AND HANDING BACK INGREDIENTS WAS ITSELF THE DEFECT — found 2026-08-16 by
     * falsification, one day after the above shipped. The caller was told to compose
     * `[<from>="<value>"]` by hand, and THREE separate things break that composition
     * while looking perfectly fine on the way out:
     *   ① the value is bounded to 80 characters (see `bounded`), so a long `title`
     *     yields `[title="<first 80 chars>"]`, which resolves to ZERO nodes —
     *     measured on a real element. A miss, with no error, from the one gesture
     *     the how-to teaches.
     *   ② `aria-labelledby` reports the TEXT of another element, never its id, so
     *     no attribute selector over THIS element can ever carry it.
     *   ③ a value holding `"` or `\` — ordinary in a French `title` — closes the
     *     quoted string early and makes `querySelector` THROW a SyntaxError.
     * None of the three is detectable by the caller, who sees a plausible name and a
     * plausible attribute. So the probe stops handing out ingredients: it knows the
     * full value, the source and the bound, and it composes the selector ITSELF, in
     * `accessibleNameSelector`. The caller reads `accessibleName` to KNOW what the
     * element is, and uses `accessibleNameSelector` to REACH it — legibility and
     * exactness in two fields rather than one field failing at both.
     *
     * ⚠ THIS IS PART OF THE W3C ORDER, NOT THE WHOLE ALGORITHM. accname resolves
     * `aria-labelledby` > `aria-label` > native labelling > content > `title`, and
     * only the attribute steps are honoured here.
     *
     * ⛔ THE COMPLETE LIST OF WHAT IS NOT IMPLEMENTED — kept complete on purpose,
     * because every gap missing from this list becomes a SILENT wrong answer rather
     * than a known limit. Audited against HTML-AAM on 2026-08-16; the last four were
     * absent from this list until then, and the first of them is the most common case
     * on a real page:
     *   · NAME FROM CONTENT (HTML-AAM §4.1.4, §4.1.13). `<button>Save</button>` and
     *     `<a href="…">Details</a>` take their name from their SUBTREE, before
     *     `title`. Here they report `title` if present, and `null` if not — so an
     *     ordinary text button comes back unnamed. Closing this changes the reported
     *     name on a great many real elements: it is a product decision, not a fix.
     *   · SHADOW DOM. Elements inside a shadow root are not merely mis-named, they
     *     are ABSENT from the map — which reads as "the page does not have one".
     *   · EMBEDDED CONTROL (accname step 2C) — a control nested inside a labelling
     *     element contributes its VALUE to the name; not implemented.
     *   · `<label for>` and wrapping-label lookup, id lists that mix in text nodes,
     *     and `aria-labelledby` chains.
     *
     * ⇒ Said here rather than discovered: a null answer does not prove the element
     * has no accessible name, only that these attributes are empty. And an element
     * missing from the map does not prove it is missing from the page.
     */
    /**
     * The bound that keeps a 200-element map readable. It is a real constraint —
     * a page of long `title` attributes would otherwise dwarf everything else in
     * the answer — which is why the fix is not to remove it but to REPORT it.
     * ⛔ THIS SENTENCE USED TO SAY that `truncated` is what turns `=` into `^=`
     * downstream. It is FALSE since the selector moved onto `raw`, and it was
     * caught by falsification reading the comment rather than the code: the
     * operator is decided by `prefix.shortened`, computed on the RAW value, and
     * `truncated` now speaks only about what the map DISPLAYS. A reader who
     * trusted this line believed the operator followed the display bound.
     */
    var NAME_BOUND = 80;

    /**
     * ⭐ THE SELECTOR IS BUILT FROM THE RAW ATTRIBUTE, NEVER FROM THE DISPLAYED NAME
     * — and getting that backwards was a SECOND instance of the very defect this
     * cluster was rewritten to fix. Found 2026-08-16 by independent falsification,
     * hours after the first fix shipped.
     *
     * The displayed name is normalised (`\s+` collapsed, trimmed) and bounded to 80,
     * because a map has to stay readable. `querySelector`, however, compares against
     * the attribute EXACTLY as the DOM holds it. Compose from the normalised value
     * and any element whose attribute carries a blank the normalisation eats —
     * a leading space, a double space, a newline, a tab, a NBSP, U+2028, U+FEFF —
     * gets a selector resolving to ZERO nodes, silently. ⚔ MEASURED: a real element
     * of ona (`AtelierTab.svelte`, a placeholder with double spaces around an em
     * dash) yielded exactly that, today, through the gesture the how-to teaches.
     *
     * So there are two values, for two jobs, and they must not be confused:
     *   `value` — normalised and bounded. To READ. Never to compose with.
     *   `raw`   — the attribute verbatim. To COMPOSE with. Never rendered in the map,
     *             which is why the 80-char bound costs the map nothing.
     */
    var SELECTOR_BOUND = 200;

    /**
     * Does this value carry anything a human could read as a name?
     *
     * ⚔ MEASURED: an `aria-label` holding a single NUL MASKED a perfectly good
     * `title`. A NUL is neither whitespace to JS nor trimmable, so `trim()` left it
     * standing, `bounded` accepted it as a name, and the W3C walk never reached the
     * next attribute — the probe reported « no selector can carry this name » for an
     * element that `[title="…"]` reached in one hop. A false NEGATIVE, and the only
     * one of its family that `accessibleNameSelectorMatches` cannot expose, since a
     * missing selector has no count.
     * ⇒ Emptiness is not « nothing left after trim », it is « nothing a selector
     * could ever carry ».
     */
    function hasNameSubstance(text) {
        for (var i = 0; i < text.length; i++) {
            var code = text.charCodeAt(i);
            if (code <= 0x1f || code === 0x7f) continue;        // control character
            if (isHighSurrogate(code)) {
                if (isLowSurrogate(text.charCodeAt(i + 1))) return true;   // real pair
                continue;                                       // lone half: no substance
            }
            if (isLowSurrogate(code)) continue;
            return true;
        }
        return false;
    }

    /**
     * ⛔ MAKES A VALUE SAFE TO SEND BACK — and this is not cosmetic.
     *
     * ⚔ MEASURED 2026-08-16, by the very harness built to judge the selector: a
     * page carrying ONE element whose name held a lone surrogate made the WHOLE map
     * unreadable — « unexpected end of hex escape at line 1 column 5495 ». Not that
     * element: the entire answer, for every other element on the page. Removing the
     * offending cases made the same map parse instantly.
     *
     * A lone surrogate is not valid text. It cannot survive the reply channel, and
     * a NUL is meaningless in a name. The map's job is to DESCRIBE the page, so it
     * substitutes U+FFFD — the standard « something was here and it was not text » —
     * exactly as any robust decoder does. The composing path is untouched: the
     * selector is built from `raw`, which never leaves the page.
     *
     * ⭐ The general shape is worth keeping: one poisoned element must never cost
     * the whole answer. An observer that loses the page because one node is odd is
     * not an observer.
     */
    function sanitizeForTransport(text) {
        var out = '';
        for (var i = 0; i < text.length; i++) {
            var code = text.charCodeAt(i);
            if (code === 0) { out += '\ufffd'; continue; }
            if (isHighSurrogate(code)) {
                if (isLowSurrogate(text.charCodeAt(i + 1))) {
                    out += text.charAt(i) + text.charAt(i + 1);
                    i++;
                    continue;
                }
                out += '\ufffd';
                continue;
            }
            if (isLowSurrogate(code)) { out += '\ufffd'; continue; }
            out += text.charAt(i);
        }
        return out;
    }

    /**
     * ⭐ ONE BOUNDING GESTURE, SHARED — because the map has THREE bounded text fields
     * and only one of them ever admitted it.
     *
     * ⚔ MEASURED 2026-08-16 by independent falsification: filling a control with 200
     * characters and re-reading the map yielded a `value` of length 80 with nothing
     * saying it had been cut (`longtext_reported: 80 / longtext_real: 200`). The
     * ordinary gesture — fill, re-read to check — therefore concludes « my input was
     * truncated » about an input the DOM stored WHOLE. That false negative is
     * invisible to its reader, which is the exact family of defect the accessible
     * name cluster above was rewritten to remove.
     *
     * The omission was in three places at once, and it is one repair:
     *   `text`           bounded to 80, no flag at all
     *   `value`          bounded to 80, no flag at all
     *   `accessibleName` `bounded()` DID compute the flag — and `describeElement`
     *                    never emitted it, so no reader of a map could see it.
     *
     * ⛔ `length` IS THE LENGTH OF THE TEXT THIS CALL ACTUALLY MEASURES — normalised
     * when `normalise` is true, raw when it is false — and never a mix of the two.
     * `length` exists so a reader can tell how much of the field is MISSING from
     * `value`, so the two must describe the same string.
     * ⚠ WHEN `normalise` IS TRUE (`text`, `accessibleName`) reporting the RAW length
     * instead would make a merely re-spaced string ("  a   b  " → "a b") read as
     * truncated when nothing was cut — a new false positive traded for the false
     * negative. Whitespace collapsing is a documented property of those fields, not a
     * per-element event.
     * ⚔ WHEN `normalise` IS FALSE (`value`) the raw length is the RIGHT answer, and
     * saying otherwise was a real defect: this comment used to state the normalised
     * rule without qualification, and the published reference repeated it under a
     * table that declared `value` un-normalised two lines above. That contradiction
     * did not stay on paper — it was copied verbatim into a verification mandate on
     * 2026-08-16 and sent someone hunting a code defect that did not exist. A value is
     * a working payload, not a label: relaying it normalised would read as lost input.
     *
     * ⚠ THE BOUND IS NOT WIDENED, deliberately. No measurement justifies another
     * number — inventing one is what got a length floor on selector prefixes killed
     * on 2026-08-16 — the map must stay readable under the 64 KB transport ceiling,
     * and a caller who needs the whole value has `inspect_eval`. What was missing
     * was never room. It was the truth about the cut.
     */
    function boundedField(raw, normalise) {
        var text = String(raw);
        if (normalise) text = text.replace(/\s+/g, ' ').trim();
        var shown = text.slice(0, NAME_BOUND);
        // ⭐ THE BOUND CAN LAND INSIDE A SURROGATE PAIR — step back rather than orphan
        // it. Cutting at unit 80 mid-pair leaves a lone high surrogate, which
        // `sanitizeForTransport` then replaces with U+FFFD: a character that is NOT ON
        // THE PAGE appears in the map, and a reader concludes "there is invalid text
        // here" about a perfectly valid emoji. It also breaks the contract this field
        // is sold on — `value` is a PREFIX of the measured text, and U+FFFD is not a
        // prefix of anything.
        // ⚠ OBSERVED 2026-08-16 by an independent attack, on `'x' + 41 emoji`
        // (83 UTF-16 units): the shown field ended in U+FFFD while length/truncated
        // stayed honest at 83/true. The lie was in the bounded field alone.
        // ⛔ THE FIX IS A PORT, NOT AN INVENTION: `prefixForSelector` already does
        // exactly this, three functions below. The SELECTOR path was protected the day
        // it was written; the DISPLAY path, written after, never received it — the
        // protection had been judged necessary once and was simply not carried over.
        // Stepping back shortens the shown field to 79 units, which is correct: it is
        // still a prefix, and `length`/`truncated` still say what was cut.
        if (isHighSurrogate(shown.charCodeAt(shown.length - 1))) {
            shown = shown.slice(0, shown.length - 1);
        }
        return {
            // Sanitised: a lone surrogate here costs the WHOLE map, not this row.
            value: sanitizeForTransport(shown),
            length: text.length,
            truncated: text.length > NAME_BOUND
        };
    }

    function bounded(raw, from) {
        var display = String(raw).replace(/\s+/g, ' ').trim();
        // ⛔ Substance is judged on the NORMALISED-BUT-UNSANITISED text, never on
        // `boundedField().value`: sanitising turns a lone surrogate into U+FFFD, which
        // DOES have substance. Judging the sanitised form would resurrect the very
        // false positive `hasNameSubstance` exists to prevent.
        if (!display || !hasNameSubstance(display)) return null;
        var field = boundedField(display, false);
        return {
            value: field.value,
            from: from,
            // Whether the DISPLAYED value was cut — never how many elements the map
            // omitted (`truncatedByLimit` / `skippedInvisible` answer that), and
            // never whether the SELECTOR was shortened (that is decided on `raw`).
            //
            // ⛔ THE RUNNING COUNT, kept honest because every round of this defect
            // came from confusing two of these. There are now FIVE derivations of
            // one attribute value, and they are NOT interchangeable:
            //   ① `raw`              the attribute verbatim — COMPOSES the selector
            //   ② whitespace-collapse + trim  → readability only
            //   ③ NAME_BOUND (80)    → what the map DISPLAYS (`truncated` says so)
            //   ④ SELECTOR_BOUND (200) + composability → what the selector CARRIES
            //   ⑤ transport sanitising → U+FFFD for what the channel cannot send
            // ⚠ ⑤ IS THE YOUNGEST AND THE LEAST OBVIOUS: since it landed,
            // `accessibleName` no longer says exactly what the page holds — it says
            // a transport-safe rendering of it. That is the right trade (one bad
            // node must not cost the whole map) but it is a NEW divergence between
            // the displayed name and the DOM, and it is where the next defect will
            // be paid. Flagged by the falsification hand rather than discovered.
            truncated: field.truncated,
            length: field.length,
            raw: String(raw)
        };
    }

    /**
     * Escapes a value for use INSIDE the quotes of an attribute selector.
     *
     * ⛔ NOT `CSS.escape`, which escapes IDENTIFIERS: applied to a quoted string it
     * escapes spaces and punctuation too, producing a selector that no longer
     * matches the very value it came from. A quoted value needs the backslash, the
     * quote that would close the string — and the CONTROL characters, which a CSS
     * string cannot carry literally: ⚔ MEASURED, a raw newline makes
     * `querySelector` THROW a SyntaxError, and escaping it as `\a ` resolves.
     */
    var CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

    function escapeAttributeValue(value) {
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            // Hex escape, closed by the space CSS requires to end the sequence.
            .replace(CONTROL_CHARACTERS, function (character) {
                return '\\' + character.charCodeAt(0).toString(16) + ' ';
            });
    }

    /**
     * How much of the raw value the selector can carry, and whether it had to stop.
     *
     * Two things force a stop, and both must yield a PREFIX rather than a wrong
     * equality:
     * ⛔ A NUL. ⚔ MEASURED: an attribute holding U+0000 matches NEITHER a selector
     * carrying the NUL nor one carrying U+FFFD — the CSS preprocessor rewrites it,
     * so equality is unreachable by construction. Cutting before it keeps the
     * element reachable (measured: the prefix resolves).
     * ⚠ A very long value, which would bloat the map. The cut must never split a
     * SURROGATE PAIR: ⚔ MEASURED, a lone high surrogate at the edge makes the `^=`
     * resolve to zero — the fix reproducing the failure it exists to prevent.
     */
    /** A UTF-16 code unit that is half of a pair — meaningless on its own. */
    function isHighSurrogate(code) { return code >= 0xd800 && code <= 0xdbff; }
    function isLowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff; }

    /**
     * The longest leading run of `raw` that a selector can carry VERBATIM.
     *
     * ⚔ THE FIRST VERSION GUARDED A POSITION INSTEAD OF A PROPERTY, and independent
     * falsification killed it: it cut before a NUL, then checked the LAST code unit
     * for a HIGH surrogate. So a lone LOW surrogate in front, and a lone HIGH
     * surrogate in the MIDDLE, sailed straight into the selector and resolved to
     * ZERO nodes — measured, both of them.
     *
     * 🔑 The question is not « did my cut create a lone surrogate » but « does this
     * value contain anything a selector cannot carry ». Walking once and stopping at
     * the first such character answers it wherever the character sits.
     */
    function composablePrefix(raw) {
        for (var i = 0; i < raw.length; i++) {
            var code = raw.charCodeAt(i);
            if (code === 0) return { text: raw.slice(0, i), shortened: true };
            if (isHighSurrogate(code)) {
                if (isLowSurrogate(raw.charCodeAt(i + 1))) {
                    i++;               // a well-formed pair: keep both units
                    continue;
                }
                return { text: raw.slice(0, i), shortened: true };
            }
            if (isLowSurrogate(code)) return { text: raw.slice(0, i), shortened: true };
        }
        return { text: raw, shortened: false };
    }

    function prefixForSelector(raw) {
        var composable = composablePrefix(raw);
        var text = composable.text;
        var shortened = composable.shortened;
        if (text.length > SELECTOR_BOUND) {
            text = text.slice(0, SELECTOR_BOUND);
            shortened = true;
            // The bound itself can land inside a pair; step back rather than orphan it.
            if (isHighSurrogate(text.charCodeAt(text.length - 1))) {
                text = text.slice(0, text.length - 1);
            }
        }
        return { text: text, shortened: shortened };
    }

    /**
     * The selector that actually REACHES the element, or `null` when none can.
     *
     * ⛔ `null` in two cases, both meaning « no attribute selector can carry this »:
     * `aria-labelledby`, whose name lives in ANOTHER element; and a value left empty
     * once shortened — `[attr^=""]` matches EVERY element carrying the attribute,
     * which is worse than answering nothing.
     *
     * ⚠ IT IS NOT PROMISED TO BE UNIQUE, and the number of elements it hits is
     * reported next to it (`accessibleNameSelectorMatches`) rather than left for the
     * caller to discover by pulling. ⚔ MEASURED: three elements sharing their first
     * 80 characters produced BYTE-IDENTICAL rows — same name, same selector — with
     * nothing in the row saying so; and a `^=` also captures elements that compose
     * an equality of their own. Ambiguity is not a property of `^=`: a plain `=` on
     * a shared `aria-label` hits a parent AND its child just as happily.
     *
     * The element is passed so the selector can be qualified by TAG — `button[…]`
     * rather than `[…]` — which narrows for free. ⚠ Only for HTML elements: SVG tag
     * names are case-SENSITIVE in selectors, so a lower-cased `linearGradient` would
     * match nothing. When in doubt the tag is dropped, never guessed.
     */
    var HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

    /**
     * ⚔ A SHORTENED PREFIX CAN BE VERY WIDE, AND THAT IS DELIBERATELY NOT REFUSED.
     * Falsification measured a value whose second character was a NUL composing
     * `[title^="a"]` — 25 matches, and `act click` on it hit an unrelated control,
     * since `need()` takes the FIRST match.
     * ⛔ The fix is NOT a minimum length. A threshold of 8 was tried and reverted:
     * it destroyed perfectly good selectors (`[title^="avant"]` reaching exactly one
     * element) to catch a degenerate case, and it invented a magic number nothing
     * measured. And it would have been a rustine: `[aria-label="Fermer onglet"]`
     * matches two elements at FULL length, so width was never a property of short
     * prefixes.
     * ⇒ Width is REPORTED instead — `accessibleNameSelectorMatches` says 25, and a
     * caller reads it before acting. Making ambiguity legible beats guessing a
     * cutoff, and it covers the cases a cutoff cannot see.
     */
    function accessibleNameSelector(named, el) {
        if (!named || named.from === 'aria-labelledby') return null;
        var prefix = prefixForSelector(named.raw);
        if (!prefix.text) return null;
        var tag = el && el.tagName && el.namespaceURI === HTML_NAMESPACE
            ? el.tagName.toLowerCase()
            : '';
        return tag + '[' + named.from + (prefix.shortened ? '^="' : '="') +
            escapeAttributeValue(prefix.text) + '"]';
    }

    /**
     * How many elements the composed selector actually hits, measured on the spot.
     *
     * ⭐ THIS IS WHAT TURNS A SILENT FAILURE INTO A VISIBLE ONE. Every defect this
     * cluster has carried — twice — ended the same way: a selector that resolved to
     * ZERO while looking perfectly well-formed, and a caller with no way to tell.
     * Reporting the count closes the whole class rather than the instances: `0` is
     * now readable in the map itself, and so is `7`.
     * ⚠ `null` means the count could not be taken (no selector, or a selector the
     * engine refused) — never « one ». An observer must not break the page it
     * observes, so a throw here degrades to `null` instead of propagating.
     *
     * ⚔ ITS PRICE, MEASURED rather than assumed — one `querySelectorAll` per mapped
     * element. On a deliberately dense page (602 interactive controls), 602 counts
     * cost 11–15 ms where the whole map costs 8–15 ms: it roughly doubles the map.
     * At the default `limit` of 200 that is ~5 ms. Cheap enough that reporting the
     * truth beats saving it.
     */
    function selectorMatchCount(selector) {
        if (!selector) return null;
        try {
            return document.querySelectorAll(selector).length;
        } catch (e) {
            return null;
        }
    }

    function accessibleName(el) {
        if (!el || !el.getAttribute) return null;
        var by = el.getAttribute('aria-labelledby');
        if (by) {
            var parts = [];
            var ids = by.split(/\s+/);
            for (var i = 0; i < ids.length; i++) {
                var target = ids[i] ? document.getElementById(ids[i]) : null;
                if (target) parts.push(target.innerText || target.textContent || '');
            }
            // No raw form worth keeping: this name lives in ANOTHER element, so no
            // selector over this one can carry it. `bounded` still normalises.
            var joined = parts.join(' ');
            var named = bounded(joined, 'aria-labelledby');
            if (named) return named;
        }
        // ⭐ HTML-AAM ORDER — `title` BEFORE `placeholder`, and the two were inverted
        // here until 2026-08-16. HTML-AAM §4.1.1 (input text/password/search/tel/url
        // and textarea) falls back to the title attribute FIRST, and only then to
        // placeholder: https://www.w3.org/TR/html-aam-1.0/
        // ⚠ CHECKED AGAINST THE SPEC, NOT AGAINST A REPORT. An independent attack
        // raised it; the order was then confirmed from the published mappings before
        // touching anything, because this changes behaviour for every consumer of the
        // bridge. The preference is contested upstream (w3c/html-aam#168 — no ARIA WG
        // consensus recorded), but the published spec is unambiguous and it is the
        // spec we claim to follow.
        // ⛔ WHAT THIS ORDER STILL DOES NOT DO, stated so no reader mistakes it for
        // the full algorithm: no native `<label for>` / wrapping-label lookup, and no
        // "name from content" step — so `<button title="X">Y</button>` reports X here
        // where HTML-AAM §4.1.4 requires Y, and `<a href>Text</a>` reports null where
        // §4.1.13 requires the text. Those are declared gaps, not oversights; closing
        // the content step changes the reported name on a great many real elements and
        // is a product decision, not a bug fix. Read `accessibleNameFrom` rather than
        // assuming the source.
        var order = ['aria-label', 'alt', 'title', 'placeholder'];
        for (var j = 0; j < order.length; j++) {
            var raw = el.getAttribute(order[j]);
            if (!raw) continue;
            // ⛔ The RAW attribute goes in, never a pre-cleaned copy: `bounded` keeps
            // both forms, and the selector is composed from the raw one.
            var candidate = bounded(raw, order[j]);
            if (candidate) return candidate;
        }
        return null;
    }

    /** A short, comparable description — enough for a caller to see WHAT was hit. */
    function describeElement(el) {
        if (!el) return null;
        var named = accessibleName(el);
        var selector = accessibleNameSelector(named, el);
        // Normalised, because the rendered text of a control already collapses its
        // blanks — unlike `value`, which is a working payload and stays verbatim.
        var textField = boundedField(el.innerText || el.textContent || '', true);
        return {
            tag: el.tagName ? el.tagName.toLowerCase() : null,
            id: el.id || null,
            name: el.getAttribute ? el.getAttribute('name') : null,
            type: el.getAttribute ? el.getAttribute('type') : null,
            classes: el.className && el.className.baseVal === undefined ? String(el.className) : null,
            text: textField.value,
            // ⛔ How long the normalised text really is, and whether `text` above is a
            // PREFIX of it. Without this pair a reader cannot distinguish « this
            // control says exactly that » from « this control says 400 characters and
            // you are looking at the first 80 ». See `boundedField`.
            textLength: textField.length,
            textTruncated: textField.truncated,
            // The last handle left when `id`, `name` and `text` are all empty — see
            // `accessibleName` for the measurement that put it here. Flattened into
            // two fields rather than a nested object, so it reads like every other
            // entry of this description and survives a shallow JSON dump.
            accessibleName: named ? named.value : null,
            // ⛔ COMPUTED SINCE THE FIRST REPAIR, EMITTED ONLY NOW. `bounded()` has
            // carried `truncated` all along and this description dropped it on the
            // floor, so every map ever taken showed a possibly-cut name as if it were
            // whole. A flag that never reaches its reader is not a flag.
            accessibleNameLength: named ? named.length : null,
            accessibleNameTruncated: named ? named.truncated : null,
            // Which attribute carries it — read to UNDERSTAND, and to read a null
            // selector below (`aria-labelledby` is the case that cannot compose).
            accessibleNameFrom: named ? named.from : null,
            // The selector that REACHES it, composed here rather than by a caller
            // who cannot see the bound, the source kind, or the characters that
            // need escaping. `null` when no attribute selector can carry the name.
            accessibleNameSelector: selector,
            // How many elements that selector hits — `1` is what you want, `0` is a
            // defect you can now SEE, and more than one says « narrow it ».
            accessibleNameSelectorMatches: selectorMatchCount(selector)
        };
    }

    function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        var style = window.getComputedStyle ? getComputedStyle(el) : null;
        if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
        return true;
    }

    /**
     * Polls until `selector` reaches `state`, then resolves with the element's
     * description. Rejects on timeout, naming what it waited for.
     *
     * Polling rather than `MutationObserver` is deliberate: `visible` depends on
     * layout and computed style, which no mutation record reports. One predictable
     * mechanism covering all three states beats two that disagree at the edges.
     */
    function waitFor(selector, timeoutMs, state) {
        state = state || 'visible';
        var limit = Date.now() + (timeoutMs || 5000);
        return new Promise(function (resolve, reject) {
            (function poll() {
                var el = document.querySelector(selector);
                var reached =
                    state === 'detached' ? !el :
                    state === 'attached' ? !!el :
                    !!el && isVisible(el);
                if (reached) return resolve({ selector: selector, state: state, element: describeElement(el) });
                if (Date.now() > limit) {
                    return reject(new Error(
                        'waited ' + (timeoutMs || 5000) + 'ms for ' + JSON.stringify(selector) +
                        ' to be ' + state + '; it is ' + (el ? (isVisible(el) ? 'attached and visible' : 'attached but not visible') : 'absent')
                    ));
                }
                setTimeout(poll, 50);
            })();
        });
    }

    /**
     * Clicks an element with the FULL pointer sequence.
     *
     * ⚠ `element.click()` alone fires only `click`. Component libraries routinely
     * open on `mousedown` or `pointerdown` (Vuetify menus and selects do), so a bare
     * `.click()` appears to work and changes nothing. The sequence below is what a
     * real pointer emits, with coordinates taken from the element's own box so that
     * handlers reading `clientX/clientY` see something coherent.
     */
    function click(selector, options) {
        options = options || {};
        var el = need(selector);
        if (options.scroll !== false && el.scrollIntoView) {
            el.scrollIntoView({ block: 'center', inline: 'center' });
        }
        var r = el.getBoundingClientRect();
        var x = r.left + r.width / 2;
        var y = r.top + r.height / 2;
        var common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };

        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
            var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Ctor(type, common));
        });

        return {
            clicked: describeElement(el),
            at: { x: Math.round(x), y: Math.round(y) },
            // What the caller uses to tell "the gesture landed" from "the page reacted".
            activeAfter: describeElement(document.activeElement),
            url: String(location.href)
        };
    }

    /**
     * Sets a field's value the way a user would, then READS IT BACK.
     *
     * ⚠ Two traps, both met in real applications:
     *   · assigning `el.value` directly is invisible to React, which tracks the
     *     property through its own descriptor — hence the native setter;
     *   · without an `input` event no reactive framework updates its model, and
     *     without `change` no validation runs. Both are dispatched.
     * The read-back is what makes this falsifiable: a masked or rejected input
     * reports the value the page actually kept, not the one we asked for.
     */
    function fill(selector, value) {
        var el = need(selector);
        var text = value === null || value === undefined ? '' : String(value);

        if (el.isContentEditable) {
            el.focus();
            el.textContent = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return { filled: describeElement(el), requested: text, actual: el.textContent };
        }

        var proto = (window.HTMLTextAreaElement && el instanceof HTMLTextAreaElement)
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');

        el.focus();
        if (descriptor && descriptor.set) descriptor.set.call(el, text);
        else el.value = text;

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        return {
            filled: describeElement(el),
            requested: text,
            actual: el.value,
            // ⭐ The caller must check this. A masked field, a maxlength or a
            // controlled component that rejects the value all leave `accepted:false`.
            accepted: el.value === text
        };
    }

    /** Presses a key on the focused element (or on `selector` when given). */
    function press(key, selector) {
        var el = selector ? need(selector) : (document.activeElement || document.body);
        if (el.focus) el.focus();
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
            el.dispatchEvent(new KeyboardEvent(type, { key: key, bubbles: true, cancelable: true, composed: true }));
        });
        return { pressed: key, on: describeElement(el), url: String(location.href) };
    }

    /** Scrolls the window, or an element when `selector` is given. */
    function scroll(options) {
        options = options || {};
        var target = options.selector ? need(options.selector) : window;
        var by = { top: options.top || 0, left: options.left || 0, behavior: 'instant' };
        if (options.selector) {
            target.scrollBy(by);
            return { scrolled: describeElement(target), top: target.scrollTop, left: target.scrollLeft };
        }
        window.scrollBy(by);
        return { scrolled: 'window', top: window.scrollY, left: window.scrollX };
    }

    /**
     * A compact, readable map of what the page offers to interact with.
     *
     * The foreign-page counterpart of `get_page_map`, which needs `guest-js` and
     * therefore times out on exactly the pages worth mapping. Interactive elements
     * only: a full DOM dump is `inspect_dom`, and it is usually too large to reason
     * about.
     */
    /**
     * Whether a control holds a secret that must never leave the page.
     *
     * ⛔ A MAP IS A PASSIVE SWEEP, AND THAT IS THE WHOLE PROBLEM. Nobody asks for a
     * particular field: a caller asks "what is on this page?" and receives every value
     * on it. On an authenticated third-party page that meant the password came back in
     * clear text, into an agent's context and from there into transcripts and logs —
     * copied by a reader who never asked for it and cannot unsee it.
     * ⚠ MEASURED 2026-08-16: a canary page returned `type: "password"` next to
     * `value: "SUPERSECRET-CANARY-9931"`, with no exception anywhere in `map()`.
     *
     * ⭐ `inspect_fill` deliberately keeps returning the value it read back: there the
     * caller SUPPLIED the secret one call earlier, so echoing it discloses nothing, and
     * `accepted` would be unverifiable without it. The asymmetry is the point — a sweep
     * discloses, an echo does not.
     *
     * The `autocomplete` cases matter because a one-time code, a card number or a
     * password-manager field is routinely `type="text"`: typing alone would miss them.
     * Over-redacting a field costs a caller one `inspect_eval`; under-redacting one
     * leaks a secret forever. The asymmetry decides the doubt.
     *
     * ⭐ THE TOKENS ARE THE HTML SPEC'S OWN, NOT A GUESS. `autocomplete` has a closed,
     * normative vocabulary, so this list can be justified rather than invented — which
     * is the only reason it is allowed to grow. `cc-exp` is a prefix on purpose: it
     * covers `cc-exp-month` and `cc-exp-year` without naming them.
     * ⚠ The card tokens were added on 2026-08-16 after an independent attack observed
     * that the first version stopped at passwords. The page that motivated all of this
     * is a booking dashboard showing settled payments — card fields are not a
     * hypothetical there.
     *
     * ⛔ WHAT THIS DELIBERATELY DOES NOT CATCH, so nobody reads it as exhaustive:
     * `<input type="text" name="password">` and friends. Matching on `name`/`id`
     * substrings is a guess, not a contract — `name="password-hint"` and
     * `name="password-strength-meter"` are ordinary readable fields, and a redaction
     * that fires on a guess teaches callers to distrust the flag. A page that carries a
     * secret in a plain text field with no `autocomplete` is asking every password
     * manager in the world to miss it too. Left open, and stated.
     */
    function isSecretField(el) {
        if (!el || !el.getAttribute) return false;
        if (String(el.type || '').toLowerCase() === 'password') return true;
        var hint = String(el.getAttribute('autocomplete') || '').toLowerCase();
        var SECRET_TOKENS = ['password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'];
        for (var s = 0; s < SECRET_TOKENS.length; s++) {
            if (hint.indexOf(SECRET_TOKENS[s]) !== -1) return true;
        }
        return false;
    }

    function map(options) {
        options = options || {};
        var limit = options.limit || 200;
        var selector = options.selector ||
            'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[contenteditable=true]';
        var out = [];
        var nodes = document.querySelectorAll(selector);
        var skippedInvisible = 0;
        var i = 0;
        for (; i < nodes.length && out.length < limit; i++) {
            var el = nodes[i];
            if (options.visibleOnly !== false && !isVisible(el)) {
                skippedInvisible++;
                continue;
            }
            var d = describeElement(el);
            // ⛔ NOT normalised — this is the working payload of a control, and the
            // gesture that reads it back is « I just filled this, did it take? ».
            // Collapsing its blanks would make a correct answer look wrong.
            // ⛔ A REDACTED FIELD MUST NOT LOOK LIKE AN EMPTY ONE. `value: null` alone
            // is what a button returns; a reader would take the password field for
            // having no value and go looking for it elsewhere. `valueRedacted` is what
            // says "there IS a value here, and it is deliberately not shown to you".
            // Its LENGTH is withheld too — a password's length is itself a secret.
            var secret = isSecretField(el);
            var valueField =
                el.value === undefined || secret ? null : boundedField(el.value, false);
            d.value = valueField ? valueField.value : null;
            d.valueLength = valueField ? valueField.length : null;
            d.valueTruncated = valueField ? valueField.truncated : null;
            d.valueRedacted = secret;
            d.href = el.getAttribute ? el.getAttribute('href') : null;
            d.disabled = !!el.disabled;
            out.push(d);
        }
        return {
            url: String(location.href),
            title: document.title,
            // Which probe TEXT produced this map — so a harness can refuse to
            // judge a binary that is not the one it was launched against.
            probeFingerprint: PROBE_FINGERPRINT,
            total: nodes.length,
            returned: out.length,
            /**
             * ⭐ TWO CAUSES OF OMISSION, TWO FIELDS — because one field for both was
             * actively misleading. `truncated: out.length < nodes.length` was true
             * whenever ANY element was left out, so a page with a single hidden
             * button reported `truncated: true` at `limit: 500`. ⚔ MEASURED: a
             * caller reading that raises the limit, gets nothing more, and has no
             * way to learn why — the two cases had exactly the same shape.
             *   `truncatedByLimit`  — the limit stopped the walk. Raising it helps.
             *   `skippedInvisible`  — hidden elements were filtered out. Raising the
             *                         limit changes nothing; `visibleOnly: false` does.
             */
            truncatedByLimit: out.length >= limit && i < nodes.length,
            skippedInvisible: skippedInvisible,
            elements: out
        };
    }

    window.__TMCP__ = {
        // Bumped to 2 when `answer` learned to await. A host can read this to know
        // whether asynchronous expressions are supported, instead of assuming.
        // ⚠ It identifies a CAPABILITY, never a text — see `fingerprint`.
        version: 2,
        fingerprint: PROBE_FINGERPRINT,
        answer: answer,
        clear: clear,
        console: function () { return consoleLog; },
        network: function () { return networkLog; },
        timings: timings,
        /** Everything at once — one round trip instead of three. */
        snapshot: function () {
            return {
                url: String(location.href),
                title: document.title,
                console: consoleLog,
                network: networkLog,
                timings: timings()
            };
        },
        act: {
            click: click,
            fill: fill,
            press: press,
            scroll: scroll,
            waitFor: waitFor,
            map: map
        }
    };
})();
