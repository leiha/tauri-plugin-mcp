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

    /** A short, comparable description — enough for a caller to see WHAT was hit. */
    function describeElement(el) {
        if (!el) return null;
        return {
            tag: el.tagName ? el.tagName.toLowerCase() : null,
            id: el.id || null,
            name: el.getAttribute ? el.getAttribute('name') : null,
            type: el.getAttribute ? el.getAttribute('type') : null,
            classes: el.className && el.className.baseVal === undefined ? String(el.className) : null,
            text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
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
    function map(options) {
        options = options || {};
        var limit = options.limit || 200;
        var selector = options.selector ||
            'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[contenteditable=true]';
        var out = [];
        var nodes = document.querySelectorAll(selector);
        for (var i = 0; i < nodes.length && out.length < limit; i++) {
            var el = nodes[i];
            if (options.visibleOnly !== false && !isVisible(el)) continue;
            var d = describeElement(el);
            d.value = el.value === undefined ? null : String(el.value).slice(0, 80);
            d.href = el.getAttribute ? el.getAttribute('href') : null;
            d.disabled = !!el.disabled;
            out.push(d);
        }
        return {
            url: String(location.href),
            title: document.title,
            // Reported so a truncated map is never read as a complete one.
            total: nodes.length,
            returned: out.length,
            truncated: out.length < nodes.length,
            elements: out
        };
    }

    window.__TMCP__ = {
        // Bumped to 2 when `answer` learned to await. A host can read this to know
        // whether asynchronous expressions are supported, instead of assuming.
        version: 2,
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
