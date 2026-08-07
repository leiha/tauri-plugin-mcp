//! Capturing the rendered content of a webview — including a CHILD webview.
//!
//! # Why this exists next to `take_screenshot`
//!
//! `take_screenshot` captures an **operating-system window**: it resolves a label to
//! a window handle and asks the platform for that window's pixels. Measured
//! 2026-08-07 on oshun, whose tabs are child webviews inside one window:
//!
//! - `take_screenshot { window_label: "lightbox-4" }` → `Window not found`, because a
//!   child webview simply is not a window;
//! - `take_screenshot { window_label: "main" }` → an image whose page area is BLACK.
//!
//! ⛔ Neither failure is loud. The first names a real object and says it is absent;
//! the second returns a valid PNG that looks like a successful capture. An agent
//! asked to look at a screen had **no way to see one**, which is the whole point of
//! the tool.
//!
//! # The approach, and why this one
//!
//! WebKitGTK can render a webview's contents to a Cairo surface itself
//! (`webkit_web_view_get_snapshot`). That is the right level:
//!
//! - it does not depend on the compositor, so it works while the tab is behind
//!   another one, partially scrolled off, or on a hidden window — the cases where a
//!   screen grab returns black or the wrong tab;
//! - it captures what the ENGINE painted, which is what "what does this page look
//!   like" actually means;
//! - it can capture the FULL document, not just the visible viewport.
//!
//! ⚠ It is therefore Linux/WebKitGTK only. On other platforms this command refuses
//! explicitly rather than silently falling back to a window grab that would answer
//! the wrong question. A refusal that names the reason is worth more than an image
//! of the wrong thing.

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_webview_for_eval;
use crate::socket_server::SocketResponse;

/// How long the engine is given to produce the surface.
const DEFAULT_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Deserialize)]
pub struct CapturePayload {
    #[serde(default)]
    pub window_label: Option<String>,
    /// Where to write the PNG.
    ///
    /// ⭐ Strongly preferred by callers that are language models: a path costs a few
    /// bytes of context and can then be read as an image, where an inline data URI
    /// costs hundreds of kilobytes of base64 for the same picture. When absent, the
    /// PNG comes back as a data URI so the command still works over a bare socket.
    #[serde(default)]
    pub save_path: Option<String>,
    /// `visible` (the viewport, default) or `full` (the whole document).
    #[serde(default)]
    pub region: Option<String>,
    /// Whether to paint the page's own background. Default `true`; `false` yields
    /// transparency where the page draws nothing.
    #[serde(default)]
    pub background: Option<bool>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

fn refused(error: String) -> SocketResponse {
    SocketResponse { success: false, data: None, error: Some(error), id: None }
}

pub async fn handle_capture_webview<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> crate::Result<SocketResponse> {
    let parsed: CapturePayload = serde_json::from_value(payload)
        .map_err(|e| crate::error::Error::Anyhow(format!("invalid payload for capture_webview: {e}")))?;

    let label = parsed.window_label.clone().unwrap_or_else(|| "main".to_string());

    if get_webview_for_eval(app, &label).is_none() {
        return Ok(refused(format!(
            "Webview not found: {label}. `list_windows` returns every webview label, \
             child ones included."
        )));
    }

    capture(app, &label, &parsed).await
}

#[cfg(target_os = "linux")]
async fn capture<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    parsed: &CapturePayload,
) -> crate::Result<SocketResponse> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let webview = match get_webview_for_eval(app, label) {
        Some(webview) => webview,
        None => return Ok(refused(format!("Webview not found: {label}"))),
    };

    let full = parsed.region.as_deref() == Some("full");
    let with_background = parsed.background.unwrap_or(true);
    let timeout = Duration::from_millis(parsed.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    // The engine answers on the GTK main loop, not on this task. A channel carries the
    // PNG bytes back; the wait below is bounded so a snapshot that never lands reports
    // a timeout instead of hanging the socket.
    //
    // ⛔ THIS CORRECTNESS DEPENDS ON *NOT* RUNNING ON THE MAIN THREAD, and nothing here
    // says so — hence this note. Socket commands are dispatched inside a `tokio::spawn`
    // on tauri's multi-threaded runtime, so `with_webview` POSTS to the event loop and
    // returns. Were this ever called FROM the main thread, `with_webview` would run
    // inline, and the poll loop below would never yield to the GTK loop — so the GIO
    // callback could not be served and every call would time out after the full budget.
    // Confirmed by review 2026-08-07; unreachable today, silent if the wiring changes.
    let (sender, receiver) = mpsc::channel::<Result<Vec<u8>, String>>();

    let posted = webview.with_webview(move |platform| {
        use webkit2gtk::gio::Cancellable;
        use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

        let region = if full { SnapshotRegion::FullDocument } else { SnapshotRegion::Visible };
        let options = if with_background {
            SnapshotOptions::NONE
        } else {
            SnapshotOptions::TRANSPARENT_BACKGROUND
        };

        platform.inner().snapshot(
            region,
            options,
            None::<&Cancellable>,
            move |result| {
                let outcome = result
                    .map_err(|e| format!("the engine refused the snapshot: {e}"))
                    .and_then(|surface| encode_png(&surface));
                // The receiver is gone when the caller already timed out. Dropping
                // the result is correct there — it has nowhere to go.
                let _ = sender.send(outcome);
            },
        );
    });

    if let Err(e) = posted {
        return Ok(refused(format!("cannot reach the native webview: {e}")));
    }

    // Polling rather than a blocking `recv_timeout`: this runs on an async executor,
    // and blocking its worker would stall every other command on the socket.
    let deadline = Instant::now() + timeout;
    let png = loop {
        match receiver.try_recv() {
            Ok(Ok(bytes)) => break bytes,
            Ok(Err(reason)) => return Ok(refused(reason)),
            Err(mpsc::TryRecvError::Disconnected) => {
                return Ok(refused(
                    "the snapshot callback was dropped without answering".to_string(),
                ))
            }
            Err(mpsc::TryRecvError::Empty) => {
                if Instant::now() >= deadline {
                    return Ok(refused(format!(
                        "no snapshot after {}ms. A webview that has never been shown \
                         may have nothing to paint yet.",
                        timeout.as_millis()
                    )));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    };

    let bytes = png.len();

    match &parsed.save_path {
        Some(path) => {
            if let Err(e) = std::fs::write(path, &png) {
                return Ok(refused(format!("cannot write {path}: {e}")));
            }
            Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({
                    "savedTo": path,
                    "bytes": bytes,
                    "region": if full { "full" } else { "visible" },
                })),
                error: None,
                id: None,
            })
        }
        None => Ok(SocketResponse {
            success: true,
            data: Some(serde_json::json!({
                "dataUri": format!("data:image/png;base64,{}", STANDARD.encode(&png)),
                "bytes": bytes,
                "region": if full { "full" } else { "visible" },
            })),
            error: None,
            id: None,
        }),
    }
}

/// Encodes a Cairo surface as PNG bytes.
///
/// ⚠ An earlier version converted to `ImageSurface` first and justified it by "a
/// surface of another kind would otherwise panic inside a GTK callback". **That was
/// wrong on both counts**, and review caught it: `write_to_png` is defined on `Surface`
/// itself (`cairo-rs/src/surface_png.rs:117`), and an unsupported surface yields
/// `Error::SurfaceTypeMismatch` — a `Result`, never a panic. The conversion added a
/// failure mode instead of removing one, and the comment taught a danger that does not
/// exist. Going straight through `Surface` means the question "is this an image
/// surface?" is never asked.
///
/// Kept as a named function rather than inlined: it runs inside the GIO callback, on
/// the GTK main thread, so its cost is the UI's cost — see the note at the call site.
#[cfg(target_os = "linux")]
fn encode_png(surface: &cairo::Surface) -> Result<Vec<u8>, String> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    surface
        .write_to_png(&mut buffer)
        .map_err(|e| format!("PNG encoding failed: {e}"))?;
    Ok(buffer.into_inner())
}

#[cfg(not(target_os = "linux"))]
async fn capture<R: Runtime>(
    _app: &AppHandle<R>,
    _label: &str,
    _parsed: &CapturePayload,
) -> crate::Result<SocketResponse> {
    // Deliberately a refusal, not a fallback to `take_screenshot`. A window grab
    // answers a different question — it shows whatever the compositor has on screen,
    // which for a background tab is the wrong page or a black rectangle. Returning
    // the wrong image would be worse than returning none.
    Ok(refused(
        "capture_webview is implemented for Linux/WebKitGTK only. On this platform, \
         `take_screenshot` captures an OS window — note that it cannot target a child \
         webview."
            .to_string(),
    ))
}
