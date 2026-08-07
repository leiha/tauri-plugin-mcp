use serde::{Deserialize, Serialize};

/// Shared interface traits and types for the MCP server and Tauri plugin
/// This ensures both sides maintain compatible function signatures
/// Common parameters for screenshot functionality
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotParams {
    /// The label of the window to capture
    pub window_label: Option<String>,

    /// JPEG quality (1-100)
    pub quality: Option<i32>,

    /// Maximum image width in pixels
    pub max_width: Option<i32>,

    /// Maximum file size in MB
    pub max_size_mb: Option<f32>,

    /// Application name to look for in window matching
    pub application_name: Option<String>,

    /// Directory to save screenshot file to (for save-to-disk mode)
    pub output_dir: Option<String>,

    /// If true, save to disk instead of returning inline base64
    pub save_to_disk: Option<bool>,

    /// If true, generate a small thumbnail for inline use
    pub thumbnail: Option<bool>,
}

/// Result of taking a screenshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotResult {
    /// Whether the operation was successful
    pub success: bool,

    /// Error message if operation failed
    pub error: Option<String>,

    /// Image data (if successful) in base64 format with MIME prefix
    pub data: Option<String>,

    /// MIME type of the image
    pub mime_type: Option<String>,

    /// File path if screenshot was saved to disk
    pub file_path: Option<String>,
}

// Window manager operation parameters
#[derive(Debug, Serialize, Deserialize)]
pub struct WindowManagerParams {
    pub window_label: Option<String>,
    pub operation: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

// Window manager operation result
#[derive(Debug, Serialize, Deserialize)]
pub struct WindowManagerResult {
    pub success: bool,
    pub error: Option<String>,
}

// Text input parameters
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInputParams {
    pub text: String,
    pub delay_ms: Option<u64>,
    pub initial_delay_ms: Option<u64>,
    #[serde(default)]
    pub window_label: Option<String>,
}

// Text input result
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInputResult {
    pub success: bool,
    pub chars_typed: u32,
    pub duration_ms: u64,
    pub error: Option<String>,
}

// Mouse movement parameters
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseMovementParams {
    pub x: i32,
    pub y: i32,
    pub relative: Option<bool>,
    pub click: Option<bool>,
    pub button: Option<String>, // "left", "right", or "middle"
    #[serde(default)]
    pub window_label: Option<String>,
    #[serde(default)]
    pub mouse_down: Option<bool>,
    #[serde(default)]
    pub mouse_up: Option<bool>,
}

// Mouse movement result
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseMovementResult {
    pub success: bool,
    pub duration_ms: u64,
    pub position: Option<(i32, i32)>,
    pub error: Option<String>,
}

/// Command string constants for socket commands
pub mod commands {
    pub const PING: &str = "ping";
    pub const TAKE_SCREENSHOT: &str = "take_screenshot";
    pub const GET_DOM: &str = "get_dom";
    pub const MANAGE_LOCAL_STORAGE: &str = "manage_local_storage";
    pub const EXECUTE_JS: &str = "execute_js";
    pub const MANAGE_WINDOW: &str = "manage_window";
    pub const SIMULATE_TEXT_INPUT: &str = "simulate_text_input";
    pub const SIMULATE_MOUSE_MOVEMENT: &str = "simulate_mouse_movement";
    pub const GET_ELEMENT_POSITION: &str = "get_element_position";
    pub const SEND_TEXT_TO_ELEMENT: &str = "send_text_to_element";
    pub const GET_PAGE_MAP: &str = "get_page_map";
    pub const GET_PAGE_STATE: &str = "get_page_state";
    pub const NAVIGATE_BACK: &str = "navigate_back";
    pub const SCROLL_PAGE: &str = "scroll_page";
    pub const FILL_FORM: &str = "fill_form";
    pub const WAIT_FOR: &str = "wait_for";
    pub const GET_APP_INFO: &str = "get_app_info";
    pub const LIST_WINDOWS: &str = "list_windows";
    pub const NAVIGATE_WEBVIEW: &str = "navigate_webview";
    pub const MANAGE_EVENTS: &str = "manage_events";
    pub const MANAGE_COOKIES: &str = "manage_cookies";
    pub const MANAGE_DEVTOOLS: &str = "manage_devtools";
    pub const MANAGE_ZOOM: &str = "manage_zoom";
    pub const MANAGE_WEBVIEW_STATE: &str = "manage_webview_state";
    pub const TYPE_INTO_FOCUSED: &str = "type_into_focused";
    pub const RESTART_APP: &str = "restart_app";

    // Universal inspection and control — these reach a page the app does NOT own, by
    // replying through cookies instead of a Tauri event. See `tools/inspect.rs`.
    pub const INSPECT_EVAL: &str = "inspect_eval";
    pub const INSPECT_DOM: &str = "inspect_dom";
    pub const GET_CONSOLE: &str = "get_console";
    pub const GET_NETWORK: &str = "get_network";
    pub const GET_TIMINGS: &str = "get_timings";
    pub const GET_PAGE_SNAPSHOT: &str = "get_page_snapshot";
    pub const INSPECT_CLICK: &str = "inspect_click";
    pub const INSPECT_FILL: &str = "inspect_fill";
    pub const INSPECT_PRESS: &str = "inspect_press";
    pub const INSPECT_SCROLL: &str = "inspect_scroll";
    pub const INSPECT_WAIT: &str = "inspect_wait";
    pub const INSPECT_MAP: &str = "inspect_map";
    pub const CAPTURE_WEBVIEW: &str = "capture_webview";

    /// Answers "what can I do here?" — see [`CATALOG`].
    pub const LIST_COMMANDS: &str = "list_commands";

    /// What a command is, and — the question that actually matters — whether it works
    /// on a page the application does not own.
    #[derive(Debug, Clone, serde::Serialize)]
    pub struct CommandInfo {
        pub name: &'static str,
        /// `true` when the command answers through the cookie channel of `probe.js`,
        /// which any page carries. `false` when it needs the `guest-js` listener,
        /// which only a page bundling it has — on a foreign page those TIME OUT.
        pub reaches_foreign_pages: bool,
        pub summary: &'static str,
    }

    /// The catalogue served by `list_commands`.
    ///
    /// # Why this exists
    ///
    /// Measured 2026-08-07: a session had to read this dispatch table in Rust to find
    /// out what it could ask for, then discovered by TIMING OUT, one command at a
    /// time, that most of them cannot reach a lightbox tab. Both are answerable
    /// facts — so they are answered, and `reaches_foreign_pages` is the column that
    /// would have saved that hour.
    ///
    /// ⚠ DRIFT IS POSSIBLE AND IT IS SILENT. The dispatch in `tools/mod.rs` is a
    /// `match`, which Rust cannot enumerate, so nothing mechanically proves this list
    /// is complete. It is kept honest two ways: the names here are the CONSTANTS
    /// above, never re-typed strings, so a rename cannot desynchronise them; and
    /// adding a command means touching this file anyway, since the constant lives
    /// here. ⇒ **Adding a `pub const` without a `CommandInfo` is the one mistake to
    /// watch for.** A caller that doubts the list can still probe: an unknown command
    /// answers `Unknown command: <name>`, which is a reliable negative.
    pub const CATALOG: &[CommandInfo] = &[
        CommandInfo { name: PING, reaches_foreign_pages: true, summary: "liveness check" },
        CommandInfo { name: LIST_COMMANDS, reaches_foreign_pages: true, summary: "this catalogue" },
        CommandInfo { name: GET_APP_INFO, reaches_foreign_pages: true, summary: "application name, version, platform" },
        CommandInfo { name: LIST_WINDOWS, reaches_foreign_pages: true, summary: "windows AND webviews, with their labels and URLs" },
        CommandInfo { name: TAKE_SCREENSHOT, reaches_foreign_pages: false, summary: "captures an OS window; cannot target a child webview — use capture_webview" },
        CommandInfo { name: CAPTURE_WEBVIEW, reaches_foreign_pages: true, summary: "captures the rendered content of any webview, including a child one" },
        CommandInfo { name: MANAGE_WINDOW, reaches_foreign_pages: false, summary: "minimise, maximise, focus, resize a window" },
        CommandInfo { name: MANAGE_COOKIES, reaches_foreign_pages: true, summary: "read and write cookies of a webview" },
        CommandInfo { name: MANAGE_ZOOM, reaches_foreign_pages: true, summary: "read or set the zoom factor" },
        CommandInfo { name: MANAGE_DEVTOOLS, reaches_foreign_pages: true, summary: "open or close devtools (requires the `devtools` feature)" },
        CommandInfo { name: NAVIGATE_WEBVIEW, reaches_foreign_pages: true, summary: "send a webview to a URL" },
        CommandInfo { name: RESTART_APP, reaches_foreign_pages: true, summary: "restart the host application" },

        // Cookie channel — the universal half.
        CommandInfo { name: INSPECT_EVAL, reaches_foreign_pages: true, summary: "evaluate any JS expression; a promise is awaited (probe v2)" },
        CommandInfo { name: INSPECT_DOM, reaches_foreign_pages: true, summary: "the rendered DOM" },
        CommandInfo { name: INSPECT_MAP, reaches_foreign_pages: true, summary: "a compact map of the interactive elements" },
        CommandInfo { name: GET_CONSOLE, reaches_foreign_pages: true, summary: "console messages since load, plus uncaught errors and failed resources" },
        CommandInfo { name: GET_NETWORK, reaches_foreign_pages: true, summary: "fetch/XHR calls with method, URL, status, duration" },
        CommandInfo { name: GET_TIMINGS, reaches_foreign_pages: true, summary: "every resource request, without status codes" },
        CommandInfo { name: GET_PAGE_SNAPSHOT, reaches_foreign_pages: true, summary: "URL, title, console, network and timings in one round trip" },
        CommandInfo { name: INSPECT_CLICK, reaches_foreign_pages: true, summary: "click with the full pointer sequence; reports what was hit" },
        CommandInfo { name: INSPECT_FILL, reaches_foreign_pages: true, summary: "type into a field and read the value back (`accepted` tells you if it stuck)" },
        CommandInfo { name: INSPECT_PRESS, reaches_foreign_pages: true, summary: "press a key on the focused element" },
        CommandInfo { name: INSPECT_SCROLL, reaches_foreign_pages: true, summary: "scroll the window or an element" },
        CommandInfo { name: INSPECT_WAIT, reaches_foreign_pages: true, summary: "wait for a selector to be attached, visible or gone" },

        // Event channel — needs `guest-js` in the page's own bundle.
        CommandInfo { name: EXECUTE_JS, reaches_foreign_pages: false, summary: "evaluate JS; ⚠ does NOT await promises — returns `{}`. Prefer inspect_eval" },
        CommandInfo { name: GET_DOM, reaches_foreign_pages: false, summary: "the DOM — foreign pages time out; use inspect_dom" },
        CommandInfo { name: GET_PAGE_MAP, reaches_foreign_pages: false, summary: "interactive elements — foreign pages time out; use inspect_map" },
        CommandInfo { name: GET_PAGE_STATE, reaches_foreign_pages: false, summary: "URL, title, readiness" },
        CommandInfo { name: GET_ELEMENT_POSITION, reaches_foreign_pages: false, summary: "an element's box" },
        CommandInfo { name: SEND_TEXT_TO_ELEMENT, reaches_foreign_pages: false, summary: "type into an element" },
        CommandInfo { name: FILL_FORM, reaches_foreign_pages: false, summary: "fill several fields at once" },
        CommandInfo { name: SCROLL_PAGE, reaches_foreign_pages: false, summary: "scroll — foreign pages time out; use inspect_scroll" },
        CommandInfo { name: WAIT_FOR, reaches_foreign_pages: false, summary: "wait for a condition — foreign pages time out; use inspect_wait" },
        CommandInfo { name: NAVIGATE_BACK, reaches_foreign_pages: false, summary: "history back" },
        CommandInfo { name: MANAGE_LOCAL_STORAGE, reaches_foreign_pages: false, summary: "read and write localStorage" },
        CommandInfo { name: MANAGE_EVENTS, reaches_foreign_pages: false, summary: "emit and listen to Tauri events" },
        CommandInfo { name: MANAGE_WEBVIEW_STATE, reaches_foreign_pages: false, summary: "inspect webview state" },

        // Real input devices — they drive the OS pointer and keyboard.
        CommandInfo { name: SIMULATE_TEXT_INPUT, reaches_foreign_pages: false, summary: "real keyboard input; needs the window focused" },
        CommandInfo { name: SIMULATE_MOUSE_MOVEMENT, reaches_foreign_pages: false, summary: "real pointer movement; needs the window focused" },
        CommandInfo { name: TYPE_INTO_FOCUSED, reaches_foreign_pages: false, summary: "type into whatever holds focus" },
    ];
}
