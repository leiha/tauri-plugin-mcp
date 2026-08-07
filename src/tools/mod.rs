use serde_json::Value;
use tauri::{AppHandle, Runtime};
use log::{info, debug};

use crate::shared::commands;
use crate::socket_server::SocketResponse;

// Export command modules
pub mod app_info;
pub mod cookies;
#[cfg(feature = "devtools")]
pub mod devtools;
pub mod events;
pub mod execute_js;
pub mod inspect;
pub mod list_windows;
pub mod local_storage;
pub mod mouse_movement;
pub mod navigate_webview;
pub mod ping;
pub mod take_screenshot;
pub mod text_input;
pub mod webview;
pub mod webview_state;
pub mod window_manager;
pub mod zoom;
pub mod restart_app;

// Re-export command handler functions
pub use app_info::handle_get_app_info;
pub use cookies::handle_manage_cookies;
#[cfg(feature = "devtools")]
pub use devtools::handle_manage_devtools;
pub use events::handle_manage_events;
pub use execute_js::handle_execute_js;
pub use list_windows::handle_list_windows;
pub use local_storage::handle_get_local_storage;
pub use mouse_movement::handle_simulate_mouse_movement;
pub use navigate_webview::handle_navigate_webview;
pub use ping::handle_ping;
pub use take_screenshot::handle_take_screenshot;
pub use text_input::handle_simulate_text_input;
pub use webview::{
    handle_get_dom, handle_get_element_position, handle_get_page_map, handle_send_text_to_element,
    handle_get_page_state, handle_navigate_back, handle_scroll_page, handle_fill_form, handle_wait_for,
    handle_type_into_focused,
};
pub use webview_state::handle_manage_webview_state;
pub use window_manager::handle_manage_window;
pub use zoom::handle_manage_zoom;
pub use restart_app::handle_restart_app;
pub use inspect::{
    handle_get_console, handle_get_network, handle_get_page_snapshot, handle_get_timings,
    handle_inspect_click, handle_inspect_dom, handle_inspect_eval, handle_inspect_fill,
    handle_inspect_map, handle_inspect_press, handle_inspect_scroll, handle_inspect_wait,
};
pub use capture::handle_capture_webview;

pub mod capture;

/// Serves the command catalogue.
///
/// A caller that can ASK what exists never has to guess a name, and never has to
/// discover by timing out that a command cannot reach the page it is looking at.
/// Both happened on 2026-08-07 — see [`commands::CATALOG`].
pub async fn handle_list_commands<R: Runtime>(
    _app: &AppHandle<R>,
    _payload: Value,
) -> crate::Result<SocketResponse> {
    Ok(SocketResponse {
        success: true,
        data: Some(serde_json::json!({
            "commands": commands::CATALOG,
            // Stated so a caller can tell an old build from a new one WITHOUT
            // probing for a command name and reading `Unknown command` as "absent".
            "pluginVersion": env!("CARGO_PKG_VERSION"),
            "probeVersion": 2,
            "note": "reachesForeignPages=false means the command needs `guest-js` in the page's \
                     own bundle; on a page the app does not own it TIMES OUT.",
        })),
        error: None,
        id: None,
    })
}

/// Handle command routing for socket requests
pub async fn handle_command<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    payload: Value,
) -> crate::Result<SocketResponse> {
    info!("[TAURI_MCP] Received command: {}", command);
    debug!(
        "[TAURI_MCP] Command {} payload: {}",
        command,
        serde_json::to_string_pretty(&payload)
            .unwrap_or_else(|_| "[failed to serialize]".to_string())
    );

    let result = match command {
        commands::PING => handle_ping(app, payload),
        commands::TAKE_SCREENSHOT => handle_take_screenshot(app, payload).await,
        commands::GET_DOM => handle_get_dom(app, payload).await,
        commands::MANAGE_LOCAL_STORAGE => handle_get_local_storage(app, payload).await,
        commands::EXECUTE_JS => handle_execute_js(app, payload).await,
        commands::MANAGE_WINDOW => handle_manage_window(app, payload).await,
        commands::SIMULATE_TEXT_INPUT => handle_simulate_text_input(app, payload).await,
        commands::SIMULATE_MOUSE_MOVEMENT => handle_simulate_mouse_movement(app, payload).await,
        commands::GET_ELEMENT_POSITION => handle_get_element_position(app, payload).await,
        commands::SEND_TEXT_TO_ELEMENT => handle_send_text_to_element(app, payload).await,
        commands::GET_PAGE_MAP => handle_get_page_map(app, payload).await,
        commands::GET_PAGE_STATE => handle_get_page_state(app, payload).await,
        commands::NAVIGATE_BACK => handle_navigate_back(app, payload).await,
        commands::SCROLL_PAGE => handle_scroll_page(app, payload).await,
        commands::FILL_FORM => handle_fill_form(app, payload).await,
        commands::WAIT_FOR => handle_wait_for(app, payload).await,
        commands::GET_APP_INFO => handle_get_app_info(app, payload).await,
        commands::LIST_WINDOWS => handle_list_windows(app, payload).await,
        commands::NAVIGATE_WEBVIEW => handle_navigate_webview(app, payload).await,
        commands::MANAGE_EVENTS => handle_manage_events(app, payload).await,
        commands::MANAGE_COOKIES => handle_manage_cookies(app, payload).await,
        #[cfg(feature = "devtools")]
        commands::MANAGE_DEVTOOLS => handle_manage_devtools(app, payload).await,
        #[cfg(not(feature = "devtools"))]
        commands::MANAGE_DEVTOOLS => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some("manage_devtools requires the 'devtools' feature: tauri-plugin-mcp = { features = [\"devtools\"] }".to_string()),
            id: None,
        }),
        commands::MANAGE_ZOOM => handle_manage_zoom(app, payload).await,
        commands::MANAGE_WEBVIEW_STATE => handle_manage_webview_state(app, payload).await,
        commands::TYPE_INTO_FOCUSED => handle_type_into_focused(app, payload).await,
        commands::RESTART_APP => handle_restart_app(app, payload).await,
        commands::INSPECT_EVAL => handle_inspect_eval(app, payload).await,
        commands::INSPECT_DOM => handle_inspect_dom(app, payload).await,
        commands::GET_CONSOLE => handle_get_console(app, payload).await,
        commands::GET_NETWORK => handle_get_network(app, payload).await,
        commands::GET_TIMINGS => handle_get_timings(app, payload).await,
        commands::GET_PAGE_SNAPSHOT => handle_get_page_snapshot(app, payload).await,
        commands::INSPECT_CLICK => handle_inspect_click(app, payload).await,
        commands::INSPECT_FILL => handle_inspect_fill(app, payload).await,
        commands::INSPECT_PRESS => handle_inspect_press(app, payload).await,
        commands::INSPECT_SCROLL => handle_inspect_scroll(app, payload).await,
        commands::INSPECT_WAIT => handle_inspect_wait(app, payload).await,
        commands::INSPECT_MAP => handle_inspect_map(app, payload).await,
        commands::CAPTURE_WEBVIEW => handle_capture_webview(app, payload).await,
        commands::LIST_COMMANDS => handle_list_commands(app, payload).await,
        _ => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Unknown command: {}", command)),
            id: None,
        }),
    };

    // Log the response before returning it
    if let Ok(ref response) = result {
        let success_str = if response.success {
            "SUCCESS"
        } else {
            "FAILURE"
        };
        info!(
            "[TAURI_MCP] Command {} completed with status: {}",
            command, success_str
        );

        if let Some(ref data) = response.data {
            let data_str =
                serde_json::to_string(data).unwrap_or_else(|_| "[failed to serialize]".to_string());
            if data_str.len() > 1000 {
                debug!(
                    "[TAURI_MCP] Response data preview (first 1000 chars): {}",
                    &data_str[..1000.min(data_str.len())]
                );
                debug!(
                    "[TAURI_MCP] ... (response data truncated, total length: {} bytes)",
                    data_str.len()
                );
            } else {
                debug!("[TAURI_MCP] Response data: {}", data_str);
            }
        }

        if let Some(ref err) = response.error {
            info!("[TAURI_MCP] Error: {}", err);
        }
    } else if let Err(ref e) = result {
        info!(
            "[TAURI_MCP] Command {} failed with error: {}",
            command, e
        );
    }

    result
}

#[cfg(test)]
mod tests {
    use crate::shared::commands;

    /// Command names must be unique — a duplicate would shadow a handler in the
    /// dispatch `match`, silently.
    ///
    /// ⚠ **This test used to enumerate the commands BY HAND, and it rotted.** It listed
    /// 26 names and asserted `seen.len() == 26`; by 2026-08-07 the catalogue held 40, so
    /// it verified nothing about 35% of the surface while its own message asserted a
    /// count that was false. It stayed green throughout — and `cargo check` without
    /// `--tests` never even compiled it.
    ///
    /// ⭐ It now derives from [`commands::CATALOG`], the single source. A command added
    /// without a catalogue entry is caught by `test_catalog_covers_every_constant`
    /// below; one added to both is covered here automatically. **A test that needs
    /// hand-updating to keep meaning something will eventually stop meaning something.**
    #[test]
    fn test_catalog_names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for info in commands::CATALOG {
            assert!(
                seen.insert(info.name),
                "Duplicate command name in CATALOG: {}",
                info.name
            );
            assert!(!info.name.is_empty(), "A CATALOG entry has an empty name");
            assert!(
                !info.summary.is_empty(),
                "Command {} has no summary — it is served by `list_commands` and read by agents",
                info.name
            );
        }
        assert!(
            seen.len() >= 26,
            "CATALOG shrank below its 2026-08-07 floor ({} entries) — a command was dropped",
            seen.len()
        );
    }

    /// Every command CONSTANT must have a catalogue entry.
    ///
    /// Rust cannot enumerate a module's constants, so this is the closest mechanical
    /// check available: each constant is named once here, and a constant added without
    /// a `CommandInfo` reddens. It is the gap the CATALOG doc-comment warns about —
    /// "adding a `pub const` without a `CommandInfo` is the one mistake to watch for" —
    /// now watched by something other than vigilance.
    #[test]
    fn test_catalog_covers_every_constant() {
        let names: std::collections::HashSet<&str> =
            commands::CATALOG.iter().map(|c| c.name).collect();

        for constant in [
            commands::PING,
            commands::TAKE_SCREENSHOT,
            commands::GET_DOM,
            commands::MANAGE_LOCAL_STORAGE,
            commands::EXECUTE_JS,
            commands::MANAGE_WINDOW,
            commands::SIMULATE_TEXT_INPUT,
            commands::SIMULATE_MOUSE_MOVEMENT,
            commands::GET_ELEMENT_POSITION,
            commands::SEND_TEXT_TO_ELEMENT,
            commands::GET_PAGE_MAP,
            commands::GET_PAGE_STATE,
            commands::NAVIGATE_BACK,
            commands::SCROLL_PAGE,
            commands::FILL_FORM,
            commands::WAIT_FOR,
            commands::GET_APP_INFO,
            commands::LIST_WINDOWS,
            commands::NAVIGATE_WEBVIEW,
            commands::MANAGE_EVENTS,
            commands::MANAGE_COOKIES,
            commands::MANAGE_DEVTOOLS,
            commands::MANAGE_ZOOM,
            commands::MANAGE_WEBVIEW_STATE,
            commands::TYPE_INTO_FOCUSED,
            commands::RESTART_APP,
            commands::INSPECT_EVAL,
            commands::INSPECT_DOM,
            commands::GET_CONSOLE,
            commands::GET_NETWORK,
            commands::GET_TIMINGS,
            commands::GET_PAGE_SNAPSHOT,
            commands::INSPECT_CLICK,
            commands::INSPECT_FILL,
            commands::INSPECT_PRESS,
            commands::INSPECT_SCROLL,
            commands::INSPECT_WAIT,
            commands::INSPECT_MAP,
            commands::CAPTURE_WEBVIEW,
            commands::LIST_COMMANDS,
        ] {
            assert!(
                names.contains(constant),
                "Command constant `{constant}` has no CATALOG entry — `list_commands` \
                 would not announce it, and a caller cannot discover it."
            );
        }
    }
}
