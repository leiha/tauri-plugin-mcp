//! Universal inspection — works on ANY page, including one the app does not own.
//!
//! # Why this module exists next to the others
//!
//! Every other tool here answers through `emit_and_wait`: the host emits a Tauri
//! event and waits for a correlated reply from `guest-js`. A page only carries
//! `guest-js` if its own bundle imports it, so a remote page never replies —
//! measured 2026-08-07 on an oshun lightbox tab: *"Timeout waiting for
//! got-dom-content response"*. That is exactly the page an agent needs to look at.
//!
//! This module keeps the same outbound half (`webview.eval`, which already runs on
//! every page through `on_page_load`) and replaces the inbound half with something
//! no page can refuse: **cookies**. `Webview::cookies()` is read natively on the
//! Rust side — no IPC, no event, no listener, no capability. The page writes its
//! answer into cookies; the host reads them directly.
//!
//! ## What it costs, said here rather than discovered later
//!
//! - A cookie holds ~4 KB, so answers are chunked and reassembled. A large DOM is
//!   many cookies and several polls; it is slower than the event path.
//! - A page with no cookie jar (`file://`, some sandboxes) cannot reply.
//! - The event path stays the right one for pages the app owns: it is faster and
//!   already proven. This is the FALLBACK that makes the foreign page reachable.

use crate::desktop::get_webview_for_eval;
use crate::socket_server::SocketResponse;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use uuid::Uuid;

/// Cookie name prefix — mirrors `PREFIX` in `probe.js`. Changing one without the
/// other yields a silent timeout, so they are named together here on purpose.
const COOKIE_PREFIX: &str = "__tmcp_";

/// How long a page is given to answer before the attempt is called failed.
const DEFAULT_TIMEOUT_MS: u64 = 8_000;

/// Interval between two cookie reads while waiting.
const POLL_MS: u64 = 60;

/// Extra time the HOST waits on top of an action's own deadline.
///
/// ⚠ Without it, `inspect_wait` with `timeout_ms: 10000` would expire host-side at
/// the 8s default while the page was still legitimately polling — and report "no
/// answer from the page", which blames the probe for a deadline the caller chose.
/// The action owns the deadline; the host merely outlives it.
const HOST_GRACE_MS: u64 = 2_000;

#[derive(Debug, Deserialize)]
pub struct InspectPayload {
    #[serde(default)]
    pub window_label: Option<String>,
    /// A JavaScript expression. Its VALUE is returned, so `document.title` works
    /// and `return document.title` does not — same contract as `execute_js`.
    ///
    /// ⭐ Since probe v2 the value may be a PROMISE: it is awaited before the answer
    /// is written back. `fetch(...).then(r => r.status)` returns the status, not `{}`.
    #[serde(default)]
    pub expression: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// CSS selector, for the action commands.
    #[serde(default)]
    pub selector: Option<String>,
    /// The value to type (`inspect_fill`) or the key to press (`inspect_press`).
    #[serde(default)]
    pub value: Option<Value>,
    /// Passed VERBATIM to the JS side as the action's options object.
    ///
    /// Deliberately untyped: the option set is defined once, in `probe.js`, and
    /// mirroring it into a Rust struct would create a second source of truth that
    /// drifts silently — the host would reject an option the page understands, or
    /// accept one it ignores. The page validates; this is a conduit.
    #[serde(default)]
    pub options: Option<Value>,
}

/// Evaluates an expression in the page and brings the value back through cookies.
///
/// This is the primitive; `get_console`, `get_network` and `get_page_snapshot` are
/// three named expressions on top of it.
pub async fn eval_via_cookies<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    expression: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let webview = get_webview_for_eval(app, window_label)
        .ok_or_else(|| format!("Webview not found: {window_label}"))?;

    let id = Uuid::new_v4().simple().to_string();

    // The expression is embedded as a JS string literal. `serde_json` is used for
    // the escaping rather than hand-rolled quoting: an expression containing a
    // quote, a newline or a backslash would otherwise produce a syntax error
    // INSIDE the page, which surfaces as a timeout and reads like a dead probe.
    let literal = serde_json::to_string(expression)
        .map_err(|e| format!("cannot encode the expression: {e}"))?;

    // ⚠ The guard is not cosmetic. If `probe.js` did not run — a page loaded
    // before the plugin was installed, or a document that never fired page-load —
    // an unguarded call throws and the host waits out the whole timeout for a
    // reason nothing states. Here the page answers immediately that it has no probe.
    let request = format!(
        "(function(){{ if(!window.__TMCP__){{ \
           document.cookie='{prefix}{id}_0=' + btoa('{{\"ok\":false,\"error\":\"probe-absent\"}}')\
             .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'') + ';path=/;SameSite=Lax'; \
           document.cookie='{prefix}{id}_n=1;path=/;SameSite=Lax'; return; }} \
         window.__TMCP__.answer('{id}', {literal}); }})()",
        prefix = COOKIE_PREFIX,
        id = id,
        literal = literal
    );

    webview
        .eval(&request)
        .map_err(|e| format!("cannot reach the page: {e}"))?;

    let count_cookie = format!("{COOKIE_PREFIX}{id}_n");
    let deadline = std::time::Instant::now() + timeout;

    loop {
        if let Ok(cookies) = webview.cookies() {
            // The count is written LAST by the page, so seeing it means every
            // chunk is already there. Reading chunks before it would return a
            // truncated answer that parses — the worst possible failure here.
            let total = cookies
                .iter()
                .find(|c| c.name() == count_cookie)
                .and_then(|c| c.value().parse::<usize>().ok());

            if let Some(total) = total {
                let mut encoded = String::new();
                for index in 0..total {
                    let name = format!("{COOKIE_PREFIX}{id}_{index}");
                    match cookies.iter().find(|c| c.name() == name) {
                        Some(chunk) => encoded.push_str(chunk.value()),
                        None => {
                            cleanup(&webview, &id, total);
                            return Err(format!(
                                "answer is incomplete: chunk {index}/{total} is missing"
                            ));
                        }
                    }
                }

                cleanup(&webview, &id, total);

                let bytes = URL_SAFE_NO_PAD
                    .decode(encoded.as_bytes())
                    .map_err(|e| format!("undecodable answer: {e}"))?;
                let text = String::from_utf8(bytes)
                    .map_err(|e| format!("answer is not valid UTF-8: {e}"))?;
                let parsed: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("unreadable answer: {e}"))?;

                if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
                    return Ok(parsed.get("value").cloned().unwrap_or(Value::Null));
                }
                let reason = parsed
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unspecified");
                return Err(format!("the page refused the expression: {reason}"));
            }
        }

        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "no answer from the page after {}ms. Either `probe.js` never ran on it \
                 (loaded before the plugin, or a document that fires no page-load), or \
                 the page has no cookie jar (file://, sandbox).",
                timeout.as_millis()
            ));
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
}

/// Removes the reply cookies. Best-effort on purpose: a failure to clean must not
/// turn a successful read into an error the caller has to handle.
fn cleanup<R: Runtime>(webview: &tauri::Webview<R>, id: &str, total: usize) {
    let _ = webview.eval(&format!(
        "window.__TMCP__ && window.__TMCP__.clear('{id}', {total})"
    ));
}

fn label_of(payload: &InspectPayload) -> String {
    payload
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string())
}

fn timeout_of(payload: &InspectPayload) -> Duration {
    Duration::from_millis(payload.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))
}

fn answered(value: Value) -> SocketResponse {
    SocketResponse { success: true, data: Some(value), error: None, id: None }
}

fn refused(error: String) -> SocketResponse {
    SocketResponse { success: false, data: None, error: Some(error), id: None }
}

async fn run<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
    expression: &str,
) -> crate::Result<SocketResponse> {
    let parsed: InspectPayload = serde_json::from_value(payload)
        .map_err(|e| crate::error::Error::Anyhow(format!("invalid payload: {e}")))?;

    let expression = parsed.expression.clone().unwrap_or_else(|| expression.to_string());

    Ok(
        match eval_via_cookies(app, &label_of(&parsed), &expression, timeout_of(&parsed)).await {
            Ok(value) => answered(value),
            Err(error) => refused(error),
        },
    )
}

/// Evaluate any expression on any page, and get the value back.
pub async fn handle_inspect_eval<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    let parsed: InspectPayload = serde_json::from_value(payload.clone())
        .map_err(|e| crate::error::Error::Anyhow(format!("invalid payload: {e}")))?;
    if parsed.expression.is_none() {
        return Ok(refused("`expression` is required for inspect_eval".to_string()));
    }
    run(app, payload, "null").await
}

/// Console messages captured since the page started loading — including the ones
/// emitted before this call, which is the whole reason the hook is installed at
/// `PageLoadEvent::Started`.
pub async fn handle_get_console<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    run(app, payload, "window.__TMCP__.console()").await
}

/// Network calls seen by the `fetch` / `XMLHttpRequest` hooks, with method, URL,
/// status and duration.
pub async fn handle_get_network<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    run(app, payload, "window.__TMCP__.network()").await
}

/// Resource timings — every request the page made, including those no hook sees
/// (images, stylesheets, beacons). No status code: the two views answer different
/// questions and both are exposed rather than merged.
pub async fn handle_get_timings<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    run(app, payload, "window.__TMCP__.timings()").await
}

/// URL, title, console, network and timings in one round trip.
pub async fn handle_get_page_snapshot<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    run(app, payload, "window.__TMCP__.snapshot()").await
}

/// The rendered DOM of any page — the foreign-page counterpart of `get_dom`.
pub async fn handle_inspect_dom<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    run(app, payload, "document.documentElement.outerHTML").await
}

// ── acting on the page ───────────────────────────────────────────────────────
//
// These carry NO mechanism of their own. Each one builds a call into the action
// library of `probe.js` and rides `eval_via_cookies` — the same channel, the same
// timeout, the same error vocabulary. That is the point: one way in, one way back,
// so a fix to the channel reaches every command at once.
//
// They exist as named commands rather than raw `inspect_eval` strings because the
// gesture has to be done in a way frameworks observe, and because each one returns
// what PROVES its effect. Both live in `probe.js`, next to the DOM they act on.

/// Renders a JSON value as a JavaScript literal.
///
/// `serde_json` does the escaping rather than hand-rolled quoting: a selector
/// holding a quote or a backslash would otherwise be a syntax error INSIDE the
/// page, which surfaces as a timeout and reads like a dead probe.
fn as_js(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("cannot encode an argument: {e}"))
}

/// Extracts a required selector, or explains what is missing.
fn selector_of(parsed: &InspectPayload, command: &str) -> Result<String, String> {
    parsed
        .selector
        .clone()
        .ok_or_else(|| format!("`selector` is required for {command}"))
}

/// Shared plumbing: parse, build the expression, run it with the right deadline.
///
/// `deadline_ms` is the action's own budget when it has one (`inspect_wait`); the
/// host adds [`HOST_GRACE_MS`] on top so the page's deadline is always the one that
/// fires first and produces the meaningful message.
async fn act<R: Runtime, F>(
    app: &AppHandle<R>,
    payload: Value,
    command: &str,
    build: F,
) -> crate::Result<SocketResponse>
where
    F: FnOnce(&InspectPayload) -> Result<(String, Option<u64>), String>,
{
    let parsed: InspectPayload = serde_json::from_value(payload)
        .map_err(|e| crate::error::Error::Anyhow(format!("invalid payload for {command}: {e}")))?;

    let (expression, deadline_ms) = match build(&parsed) {
        Ok(built) => built,
        Err(reason) => return Ok(refused(reason)),
    };

    let timeout = match deadline_ms {
        Some(ms) => Duration::from_millis(ms + HOST_GRACE_MS),
        None => timeout_of(&parsed),
    };

    Ok(
        match eval_via_cookies(app, &label_of(&parsed), &expression, timeout).await {
            Ok(value) => answered(value),
            Err(error) => refused(error),
        },
    )
}

/// Clicks an element with the full pointer sequence, and reports what it hit.
pub async fn handle_inspect_click<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    act(app, payload, "inspect_click", |parsed| {
        let selector = as_js(&Value::String(selector_of(parsed, "inspect_click")?))?;
        let options = as_js(parsed.options.as_ref().unwrap_or(&Value::Null))?;
        Ok((
            format!("window.__TMCP__.act.click({selector}, {options})"),
            None,
        ))
    })
    .await
}

/// Types into a field the way a user would, and reads the value back.
///
/// ⭐ The answer carries `accepted` — check it. A masked field, a `maxlength` or a
/// controlled component that rejects the input all leave it `false` while the
/// command itself succeeded. "The command worked" and "the field holds the value"
/// are two different facts.
pub async fn handle_inspect_fill<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    act(app, payload, "inspect_fill", |parsed| {
        let selector = as_js(&Value::String(selector_of(parsed, "inspect_fill")?))?;
        let value = as_js(
            parsed
                .value
                .as_ref()
                .ok_or_else(|| "`value` is required for inspect_fill".to_string())?,
        )?;
        Ok((
            format!("window.__TMCP__.act.fill({selector}, {value})"),
            None,
        ))
    })
    .await
}

/// Presses a key on the focused element, or on `selector` when given.
pub async fn handle_inspect_press<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    act(app, payload, "inspect_press", |parsed| {
        let key = as_js(
            parsed
                .value
                .as_ref()
                .ok_or_else(|| "`value` is required for inspect_press (the key name)".to_string())?,
        )?;
        let selector = match &parsed.selector {
            Some(s) => as_js(&Value::String(s.clone()))?,
            None => "undefined".to_string(),
        };
        Ok((
            format!("window.__TMCP__.act.press({key}, {selector})"),
            None,
        ))
    })
    .await
}

/// Scrolls the window, or an element when `selector` is given.
pub async fn handle_inspect_scroll<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    act(app, payload, "inspect_scroll", |parsed| {
        // The selector is folded into the options object so the JS side has a single
        // argument shape, and so `options` stays the only place the option set lives.
        let mut options = parsed.options.clone().unwrap_or(Value::Object(Default::default()));
        if let (Some(map), Some(selector)) = (options.as_object_mut(), parsed.selector.as_ref()) {
            map.insert("selector".to_string(), Value::String(selector.clone()));
        }
        Ok((
            format!("window.__TMCP__.act.scroll({})", as_js(&options)?),
            None,
        ))
    })
    .await
}

/// Waits until a selector is attached, visible, or gone.
///
/// The state is read from `options.state` (`visible` by default) and the budget from
/// `timeout_ms`, which here means the ACTION's deadline — see [`HOST_GRACE_MS`].
pub async fn handle_inspect_wait<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    act(app, payload, "inspect_wait", |parsed| {
        let selector = as_js(&Value::String(selector_of(parsed, "inspect_wait")?))?;
        let budget = parsed.timeout_ms.unwrap_or(5_000);
        let state = parsed
            .options
            .as_ref()
            .and_then(|o| o.get("state"))
            .cloned()
            .unwrap_or(Value::String("visible".to_string()));
        Ok((
            format!(
                "window.__TMCP__.act.waitFor({selector}, {budget}, {})",
                as_js(&state)?
            ),
            Some(budget),
        ))
    })
    .await
}

/// A compact map of what the page offers to interact with.
///
/// The foreign-page counterpart of `get_page_map`, which needs `guest-js` and so
/// times out on exactly the pages worth mapping. The answer states `total`,
/// `returned` and `truncated`, so a capped map is never read as a complete one.
pub async fn handle_inspect_map<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    act(app, payload, "inspect_map", |parsed| {
        let options = as_js(parsed.options.as_ref().unwrap_or(&Value::Null))?;
        Ok((format!("window.__TMCP__.act.map({options})"), None))
    })
    .await
}
