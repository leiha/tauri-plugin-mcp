use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::socket_server::SocketResponse;

/// Enumerates windows AND webviews, with their metadata.
///
/// # Why `webviews` is a separate list, and why it is not optional
///
/// `webview_windows()` only sees windows that ARE a webview. An application built
/// the other way — one window hosting several child webviews, which is how a
/// tabbed shell is built — has none, so this command answered `{"windows": []}`
/// on an app with four tabs open. Measured 2026-08-07 on oshun.
///
/// ⛔ That empty list is worse than an error: the caller reads "nothing is open"
/// and stops looking. And the labels it fails to return are exactly what every
/// other command needs as `window_label` — so the whole surface was unreachable
/// for want of a name.
///
/// The two lists are kept apart rather than merged because they answer different
/// questions: `windows` is about the OS (geometry, monitor, focus), `webviews` is
/// about pages (label, URL). Merging them would force empty geometry onto every
/// tab and read like missing data instead of an inapplicable one.
pub async fn handle_list_windows<R: Runtime>(
    app: &AppHandle<R>,
    _payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let mut windows = Vec::new();

    // Every webview, child ones included. This is the list a caller needs to pick a
    // `window_label` for `inspect_*`, `capture_webview` and the rest.
    let webviews: Vec<Value> = app
        .webviews()
        .into_iter()
        .map(|(label, webview)| {
            serde_json::json!({
                "label": label,
                "url": webview.url().map(|u| u.to_string()).unwrap_or_default(),
                // The window that hosts it — a tab and its shell share this.
                "window": webview.window().label().to_string(),
            })
        })
        .collect();

    for (label, ww) in app.webview_windows() {
        let url = ww.url().map(|u| u.to_string()).unwrap_or_default();
        let title = ww.title().unwrap_or_default();
        let is_visible = ww.is_visible().unwrap_or(false);
        let is_focused = ww.is_focused().unwrap_or(false);
        let is_maximized = ww.is_maximized().unwrap_or(false);
        let is_fullscreen = ww.is_fullscreen().unwrap_or(false);
        let scale_factor = ww.scale_factor().unwrap_or(1.0);
        let outer_size = ww.outer_size().ok();
        let inner_size = ww.inner_size().ok();
        let outer_position = ww.outer_position().ok();

        // Try to determine which monitor this window is on
        let current_monitor = ww.current_monitor().ok().flatten().map(|m| {
            serde_json::json!({
                "name": m.name().map(|n| n.to_string()),
            })
        });

        windows.push(serde_json::json!({
            "label": label,
            "title": title,
            "url": url,
            "visible": is_visible,
            "focused": is_focused,
            "maximized": is_maximized,
            "fullscreen": is_fullscreen,
            "scaleFactor": scale_factor,
            "outerSize": outer_size.map(|s| serde_json::json!({"width": s.width, "height": s.height})),
            "innerSize": inner_size.map(|s| serde_json::json!({"width": s.width, "height": s.height})),
            "position": outer_position.map(|p| serde_json::json!({"x": p.x, "y": p.y})),
            "monitor": current_monitor,
        }));
    }

    Ok(SocketResponse {
        success: true,
        data: Some(serde_json::json!({ "windows": windows, "webviews": webviews })),
        error: None,
        id: None,
    })
}
