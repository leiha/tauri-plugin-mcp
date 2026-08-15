import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

/**
 * Universal page inspection — the tools that reach a page the application does NOT own.
 *
 * Every other tool in this server answers through a Tauri event that `guest-js` replies
 * to. A remote page never loads `guest-js`, so `get_dom`, `execute_js` and the rest time
 * out on exactly the pages worth looking at — measured on an oshun lightbox tab:
 * "Timeout waiting for got-dom-content response".
 *
 * These reply through COOKIES instead, which the host reads natively. No IPC, no event,
 * no capability, and it survives https (unlike a local HTTP callback, blocked as mixed
 * content). Slower than the event path, so prefer the existing tools on pages the app
 * owns; reach for these when the page is foreign.
 */

const WINDOW = z.string().default("main").describe(
  "Webview label. 'main' is the application window; a tab or child webview has its own label " +
  "(e.g. 'lightbox-0' in oshun). Use list_windows or the host app's own listing to find it."
);

const TIMEOUT = z.number().int().positive().optional().describe(
  "Milliseconds to wait for the page to answer. Default 8000. A page that never ran the probe " +
  "answers 'probe-absent' immediately rather than waiting this out."
);

async function forward(
  command: string,
  params: Record<string, unknown>,
  emptyHint: string,
) {
  try {
    logCommandParams(command, params);
    // 🔴 `sendCommand` RESOLVES THE UNWRAPPED PAYLOAD, NEVER THE ENVELOPE — and
    // reading it as an envelope is the defect repaired here on 2026-08-08.
    //
    // `client.ts` inspects `{success, data, error}` itself: it REJECTS on
    // `success: false` and resolves with `response.data` alone. So the value
    // arriving here is already the answer — `2` for `inspect_eval('1+1')`, a DOM
    // string for `inspect_dom`, an object for `inspect_click`.
    //
    // ⚔ This function used to test `result?.success` and read `result.data`.
    // Neither exists on an unwrapped payload, so the guard was ALWAYS true and
    // every call returned `<command> failed without a reason` — a message that
    // names no cause because there was none. ⛔ **The whole `inspect_*` family, plus
    // `get_console`, `get_network`, `get_page_snapshot`, `get_timings`, **plus
    // `list_commands` and `capture_webview`** — FOURTEEN tools — had therefore NEVER
    // worked over MCP**, since the commit that introduced them (`bda15a4`, the very
    // commit that created this file: `git log -S` returns it alone).
    // ⚔ THIS SAID "twelve" FOR AN HOUR, AND THE TWO IT MISSED ARE THE IRONIC ONES:
    // `list_commands` is the remedy this project's own documentation prescribes
    // ("ask the catalogue rather than guess"), and `capture_webview` is the only
    // capture that reaches a CHILD webview. **Both remedies were themselves dead.**
    // Recounted on `git show HEAD~1` — 14 distinct commands routed through
    // `forward()`. ⚠ The commit message `13f8986` still says "twelve" and can no
    // longer be amended; this cartouche is where the right number lives.
    //
    // The plugin itself was fine: the same commands answer
    // correctly on the same socket through `oshun lightbox` (measured 2026-08-08,
    // raw socket reply `{"success":true,"data":2,…}`).
    //
    // ⭐ THE WITNESS THAT MAKES THIS OPPOSABLE rather than a guess: `execute_js.ts`,
    // in this same folder, calls the same `sendCommand` and passes its result
    // STRAIGHT to `formatResultAsText`. Two neighbouring files, two readings of one
    // contract — and the one that was wrong is the one nothing exercised.
    // ⚠ A failure still arrives as a REJECTION, caught below with its real message.
    const payload = await socketClient.sendCommand(command, params);
    const isEmpty = Array.isArray(payload) && payload.length === 0;
    return createSuccessResponse(
      isEmpty ? emptyHint : formatResultAsText(payload)
    );
  } catch (error) {
    return createErrorResponse(
      `${command}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function registerInspectPageTools(server: McpServer) {
  server.tool(
    "get_console",
    "Console messages of a page — including those emitted BEFORE this call. The hook is installed " +
    "at page-load start, so boot errors are captured. Works on any page, including one the app does " +
    "not own. Returns [{at, level, text}] where level is log|info|warn|error|debug|uncaught|" +
    "unhandled-rejection. Use this when a component renders blank or an interaction does nothing.",
    { window_label: WINDOW, timeout_ms: TIMEOUT },
    { title: "Read a page's console", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ window_label, timeout_ms }) =>
      forward("get_console", { window_label, timeout_ms },
        "The page logged nothing. That is a real answer, not a failure: the buffer exists and is empty."),
  );

  server.tool(
    "get_network",
    "Network calls a page made through fetch or XMLHttpRequest, with method, URL, status and duration. " +
    "Returns [{at, via, method, url, status, ms, failed}]. Use this to check which endpoint was actually " +
    "called, or why a request failed. For resources no hook sees (images, stylesheets), use get_timings.",
    { window_label: WINDOW, timeout_ms: TIMEOUT },
    { title: "Read a page's network calls", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ window_label, timeout_ms }) =>
      forward("get_network", { window_label, timeout_ms },
        "No fetch or XHR call was captured. The page may use only static resources — try get_timings."),
  );

  server.tool(
    "get_timings",
    "Every resource the page requested, from the browser's own Resource Timing API — images, stylesheets, " +
    "scripts, beacons included. Sees more than get_network but carries NO status code: the two answer " +
    "different questions and both are exposed rather than merged.",
    { window_label: WINDOW, timeout_ms: TIMEOUT },
    { title: "Read a page's resource timings", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ window_label, timeout_ms }) =>
      forward("get_timings", { window_label, timeout_ms }, "No resource timing recorded."),
  );

  server.tool(
    "get_page_snapshot",
    "URL, title, console, network and resource timings of a page in ONE round trip. Prefer this over " +
    "three separate calls when diagnosing: the cookie reply channel is chunked, so one call is markedly " +
    "faster than three.",
    { window_label: WINDOW, timeout_ms: TIMEOUT },
    { title: "Snapshot a page's runtime state", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ window_label, timeout_ms }) =>
      forward("get_page_snapshot", { window_label, timeout_ms }, "Empty snapshot."),
  );

  server.tool(
    "inspect_dom",
    "The rendered DOM of any page, including one the app does not own — the foreign-page counterpart of " +
    "get_dom. Returns the current outerHTML, after scripts have run, not the served source. Large pages " +
    "arrive in cookie chunks, so this is slower than get_dom; use get_dom on pages the app owns.",
    { window_label: WINDOW, timeout_ms: TIMEOUT },
    { title: "Read the rendered DOM of any page", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ window_label, timeout_ms }) =>
      forward("inspect_dom", { window_label, timeout_ms }, "Empty DOM."),
  );

  server.tool(
    "inspect_eval",
    "Evaluates a JavaScript EXPRESSION on any page — including one the app does not own — and returns its " +
    "value. Unlike execute_js, which needs the page to carry the guest bindings, this replies through " +
    "cookies and works everywhere. Pass an expression, not statements: `document.title` works, " +
    "`return document.title` does not. Wrap multi-step logic in an IIFE. " +
    "A PROMISE IS AWAITED: `fetch(u).then(r => r.status)` returns the status, not an empty object — " +
    "which is what execute_js does and why it must not be used for anything asynchronous. " +
    "One exception: dynamic `import()` is forbidden here (indirect eval); inject a <script type=module> instead.",
    {
      expression: z.string().describe(
        "A JavaScript expression whose VALUE is returned, e.g. " +
        "`document.querySelectorAll('.row').length` or `(() => { const e = document.querySelector('#x'); " +
        "return e ? e.textContent : null; })()`."
      ),
      window_label: WINDOW,
      timeout_ms: TIMEOUT,
    },
    { title: "Evaluate an expression on any page", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ expression, window_label, timeout_ms }) => {
      if (!expression || expression.trim() === "") {
        return createErrorResponse("expression is required and cannot be empty");
      }
      return forward("inspect_eval", { expression, window_label, timeout_ms }, "null");
    },
  );

  server.tool(
    "list_commands",
    "What this bridge can do, straight from the running binary. Returns every command with " +
    "`reaches_foreign_pages` — false means the command needs the guest bindings in the page's own " +
    "bundle and will TIME OUT on a page the app does not own. ⭐ Call this FIRST when you are unsure: " +
    "it replaces guessing a name, and it replaces discovering by timing out, one command at a time, " +
    "that a command cannot reach the page you are looking at. Also returns pluginVersion and " +
    "probeVersion, so an old binary is told apart from a missing feature.",
    {},
    { title: "List the bridge's commands", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => forward("list_commands", {}, "No catalogue — this binary predates list_commands."),
  );

  server.tool(
    "capture_webview",
    "An IMAGE of what a page actually looks like — including a child webview (a tab), which " +
    "take_screenshot cannot target: it captures an OS WINDOW, answers 'Window not found' for a tab " +
    "label, and returns a black page area for the parent window. This one goes through the rendering " +
    "engine, so it works even when the tab is behind another, scrolled off, or on a hidden window. " +
    "⭐ Always pass save_path and then read the file: a path costs a few bytes of context, an inline " +
    "data URI costs hundreds of kilobytes of base64 for the same picture. Linux/WebKitGTK only; " +
    "elsewhere it refuses explicitly rather than returning the wrong image.",
    {
      window_label: WINDOW,
      save_path: z.string().optional().describe(
        "Absolute path to write the PNG to. Strongly recommended. Without it the image comes back as a data URI."
      ),
      region: z.enum(["visible", "full"]).optional().describe(
        "'visible' (default) captures the viewport; 'full' captures the whole document — often taller, " +
        "and the only way to see what is below the fold."
      ),
      background: z.boolean().optional().describe("false yields a transparent background. Default true."),
      timeout_ms: TIMEOUT,
    },
    { title: "Capture a webview's rendered content", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (params) => forward("capture_webview", params, "No image produced."),
  );

  server.tool(
    "inspect_map",
    "A compact map of what a page offers to interact with — links, buttons, inputs, selects, and " +
    "anything carrying an interactive role — with id, type, current value and disabled state. Use this " +
    "BEFORE clicking or filling, to find the right selector; inspect_dom on a real application is " +
    "usually too large to reason about. States total/returned/truncatedByLimit/skippedInvisible, so a " +
    "capped map is never read as a complete one and the caller knows which cause dropped what. Each " +
    "element carries accessibleNameSelector (ready to use, never recompose it) and the number of " +
    "elements it matches. Works on any page.",
    {
      window_label: WINDOW,
      options: z.object({
        selector: z.string().optional().describe("Override the default set of interactive selectors."),
        limit: z.number().int().positive().optional().describe("Maximum elements returned. Default 200."),
        visibleOnly: z.boolean().optional().describe("Default true — hidden elements are skipped."),
      }).optional(),
      timeout_ms: TIMEOUT,
    },
    { title: "Map a page's interactive elements", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (params) => forward("inspect_map", params, "No interactive element found."),
  );

  server.tool(
    "inspect_click",
    "Clicks an element on any page, with the FULL pointer sequence (pointerdown, mousedown, pointerup, " +
    "mouseup, click). That matters: component libraries routinely open on mousedown — Vuetify menus and " +
    "selects do — so a bare .click() appears to work and changes nothing. Returns what was actually hit, " +
    "the coordinates, what holds focus afterwards and the URL, so you can tell 'the gesture landed' from " +
    "'the page reacted'. ⚠ Synthesised events: a page checking event.isTrusted, a cross-origin iframe or " +
    "a native file picker will not respond.",
    {
      selector: z.string().describe("CSS selector. Use inspect_map to find it."),
      window_label: WINDOW,
      options: z.object({
        scroll: z.boolean().optional().describe("Default true — scrolls the element into view first."),
      }).optional(),
      timeout_ms: TIMEOUT,
    },
    { title: "Click an element on any page", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (params) => forward("inspect_click", params, "Nothing clicked."),
  );

  server.tool(
    "inspect_fill",
    "Types a value into a field on any page, the way a user would: the native value setter (assigning " +
    ".value directly is invisible to React) followed by input and change events (without them no " +
    "reactive framework updates its model and no validation runs). ⭐ THEN IT READS THE VALUE BACK and " +
    "returns `accepted`. CHECK IT: the command can succeed while the field keeps a different value — an " +
    "input mask, a maxlength, a controlled component that rejects it. 'The command worked' and 'the " +
    "field holds the value' are two different facts.",
    {
      selector: z.string().describe("CSS selector of the input, textarea or contenteditable."),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]).describe("The value to type. Pass an empty string to clear."),
      window_label: WINDOW,
      timeout_ms: TIMEOUT,
    },
    { title: "Fill a field on any page", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (params) => forward("inspect_fill", params, "Nothing filled."),
  );

  server.tool(
    "inspect_press",
    "Presses a key on the focused element of any page, or on `selector` when given. Use it for Enter to " +
    "submit, Escape to dismiss, or arrow keys in a listbox. Key names follow KeyboardEvent.key: 'Enter', " +
    "'Escape', 'ArrowDown', 'Tab', 'a'.",
    {
      value: z.string().describe("The key name, as in KeyboardEvent.key — e.g. 'Enter'."),
      selector: z.string().optional().describe("Element to press on. Defaults to whatever holds focus."),
      window_label: WINDOW,
      timeout_ms: TIMEOUT,
    },
    { title: "Press a key on any page", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (params) => forward("inspect_press", params, "Nothing pressed."),
  );

  server.tool(
    "inspect_scroll",
    "Scrolls the window of any page, or an element when `selector` is given. Returns the resulting " +
    "position, so a scroll that hit the end is visible as such rather than reported as done.",
    {
      window_label: WINDOW,
      selector: z.string().optional().describe("Element to scroll. Defaults to the window."),
      options: z.object({
        top: z.number().optional().describe("Pixels to scroll vertically. Negative scrolls up."),
        left: z.number().optional().describe("Pixels to scroll horizontally."),
      }).optional(),
      timeout_ms: TIMEOUT,
    },
    { title: "Scroll any page", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (params) => forward("inspect_scroll", params, "Nothing scrolled."),
  );

  server.tool(
    "inspect_wait",
    "Waits until a selector is visible, attached, or gone on any page. Use it after a click that " +
    "triggers loading, instead of sleeping for an arbitrary duration. On timeout it FAILS and says what " +
    "the element actually was — absent, or attached but not visible — which is usually the diagnosis " +
    "itself. Here timeout_ms is the WAIT's budget, not just the transport's.",
    {
      selector: z.string().describe("CSS selector to wait for."),
      window_label: WINDOW,
      options: z.object({
        state: z.enum(["visible", "attached", "detached"]).optional().describe(
          "'visible' (default) also requires a non-zero box and no display:none/visibility:hidden. " +
          "'detached' waits for it to disappear — useful for a spinner."
        ),
      }).optional(),
      timeout_ms: z.number().int().positive().optional().describe("How long to wait, in ms. Default 5000."),
    },
    { title: "Wait for an element on any page", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (params) => forward("inspect_wait", params, "Condition not reached."),
  );
}
