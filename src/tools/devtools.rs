use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_webview_for_eval;
use crate::socket_server::SocketResponse;

#[derive(Debug, Deserialize)]
struct DevtoolsPayload {
    window_label: Option<String>,
    action: String,
}

/// Handler for manage_devtools — open/close/check devtools
pub async fn handle_manage_devtools<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: DevtoolsPayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for manage_devtools: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    // ⚠ **THE THIRD RESOLVER TO CARRY THIS DEFECT, and the last one left.** This handler
    // used `get_webview_window` alone, so a label naming a CHILD webview — a lightbox tab,
    // which is exactly the page a developer wants to inspect — answered `Window not found`.
    // `get_webview_for_eval` and `get_emit_target` were both corrected on 2026-08-07 under
    // a doc-comment that says «correcting one of two identical resolvers is how a fixed bug
    // survives». There were three, not two.
    // 🔑 It survived because the `devtools` feature was OFF in all nine consumer apps: the
    // handler returned «requires the 'devtools' feature» before ever reaching this line, so
    // no one could meet the defect. *A capability nobody can switch on is a capability whose
    // bugs never get found.* Measured and fixed 2026-08-19.
    // ⛔ Do NOT narrow this back to `get_webview_window`: `open_devtools`, `close_devtools`
    // and `is_devtools_open` are all defined on `Webview` itself (tauri 2, webview/mod.rs),
    // so nothing about the window type requires it.
    let ww = get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "open" => {
            ww.open_devtools();
            Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({"action": "open", "devtools": true})),
                error: None,
                id: None,
            })
        }
        "close" => {
            ww.close_devtools();
            Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({"action": "close", "devtools": false})),
                error: None,
                id: None,
            })
        }
        "is_open" => {
            let is_open = ww.is_devtools_open();
            Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({"isOpen": is_open})),
                error: None,
                id: None,
            })
        }
        _ => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "Unknown action '{}'. Valid actions: open, close, is_open",
                parsed.action
            )),
            id: None,
        }),
    }
}
