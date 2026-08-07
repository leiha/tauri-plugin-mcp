use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};
use log::{info, warn};

pub use models::*;

#[cfg(desktop)]
mod desktop;

mod error;
mod models;
pub mod shared;
mod socket_server;
mod tools;
// Platform-specific module
mod platform;
// Native input injection (replaces enigo)
#[cfg(desktop)]
mod native_input;

pub use error::{Error, Result};
pub use shared::{
    ScreenshotParams, ScreenshotResult, WindowManagerParams, WindowManagerResult,
};

#[cfg(desktop)]
use desktop::TauriMcp;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the tauri-mcp APIs.
#[cfg(desktop)]
pub trait TauriMcpExt<R: Runtime> {
    fn tauri_mcp(&self) -> &TauriMcp<R>;
}

#[cfg(desktop)]
impl<R: Runtime, T: Manager<R>> crate::TauriMcpExt<R> for T {
    fn tauri_mcp(&self) -> &TauriMcp<R> {
        self.state::<TauriMcp<R>>().inner()
    }
}

/// Socket connection type
#[derive(Clone, Debug)]
pub enum SocketType {
    /// Use IPC (Unix domain socket or Windows named pipe)
    Ipc {
        /// Path to the socket file. If None, a default path will be used.
        path: Option<std::path::PathBuf>,
    },
    /// Use TCP socket
    Tcp {
        /// Host to bind to (e.g., "127.0.0.1" or "0.0.0.0")
        host: String,
        /// Port to bind to
        port: u16,
    },
}

impl Default for SocketType {
    fn default() -> Self {
        SocketType::Ipc { path: None }
    }
}

/// Plugin configuration options.
#[derive(Default)]
pub struct PluginConfig {
    /// Application name (used for default socket naming)
    pub application_name: String,
    /// Socket configuration
    pub socket_type: SocketType,
    /// Whether to start the socket server automatically. Default is true.
    pub start_socket_server: bool,
    /// Default webview label to use when a window label doesn't match a WebviewWindow.
    /// In multi-webview architectures, the window "main" may contain a child webview
    /// with a different label (e.g., "preview"). Set this to that webview's label so
    /// the plugin knows where to send events and evaluate JS.
    pub default_webview_label: Option<String>,
    /// Optional auth token for socket server authentication.
    /// When set, clients must include this token in requests.
    pub auth_token: Option<String>,
}

impl PluginConfig {
    /// Create a new plugin configuration with default values.
    pub fn new(application_name: String) -> Self {
        Self {
            application_name,
            socket_type: SocketType::default(),
            start_socket_server: true,
            default_webview_label: None,
            auth_token: None,
        }
    }

    /// Set the socket path for IPC mode.
    pub fn socket_path(mut self, path: std::path::PathBuf) -> Self {
        self.socket_type = SocketType::Ipc { path: Some(path) };
        self
    }

    /// Configure TCP socket mode.
    pub fn tcp(mut self, host: String, port: u16) -> Self {
        self.socket_type = SocketType::Tcp { host, port };
        self
    }

    /// Set whether to start the socket server automatically.
    pub fn start_socket_server(mut self, start: bool) -> Self {
        self.start_socket_server = start;
        self
    }

    /// Set the default webview label for multi-webview architectures.
    /// When a window label (e.g., "main") doesn't directly correspond to a WebviewWindow,
    /// this label is used to find the correct webview for JS evaluation and event emission.
    pub fn default_webview_label(mut self, label: String) -> Self {
        self.default_webview_label = Some(label);
        self
    }

    /// Set an auth token for socket server authentication.
    pub fn auth_token(mut self, token: String) -> Self {
        self.auth_token = Some(token);
        self
    }

    /// Convenience: configure TCP on localhost (127.0.0.1) with the given port.
    pub fn tcp_localhost(mut self, port: u16) -> Self {
        self.socket_type = SocketType::Tcp {
            host: "127.0.0.1".to_string(),
            port,
        };
        self
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    init_with_config(PluginConfig::default())
}

/// Initializes the plugin with the given configuration.
pub fn init_with_config<R: Runtime>(config: PluginConfig) -> TauriPlugin<R> {
    // Log socket configuration
    match &config.socket_type {
        SocketType::Ipc { path } => {
            if let Some(path) = path {
                info!(
                    "[TAURI_MCP] Socket server will use custom IPC path: {}",
                    path.display()
                );
            } else if !config.application_name.is_empty() {
                let derived_path = std::env::temp_dir()
                    .join(format!("tauri-mcp-{}.sock", config.application_name));
                info!(
                    "[TAURI_MCP] Socket server will use app-derived IPC path: {}",
                    derived_path.display()
                );
            } else {
                let default_path = std::env::temp_dir().join("tauri-mcp.sock");
                info!(
                    "[TAURI_MCP] Socket server will use default IPC path: {}",
                    default_path.display()
                );
            }
        }
        SocketType::Tcp { host, port } => {
            info!(
                "[TAURI_MCP] Socket server will use TCP: {}:{}",
                host, port
            );
        }
    }

    if config.auth_token.is_none() {
        warn!("[TAURI_MCP] WARNING: No auth token configured. Socket server is unauthenticated.");
    }

    if config.start_socket_server {
        info!("[TAURI_MCP] Socket server will start automatically");
    } else {
        info!("[TAURI_MCP] Socket server auto-start is disabled");
    }

    Builder::new("tauri-mcp")
        // ⭐ THE PROBE MUST RUN BEFORE THE PAGE'S OWN SCRIPT, and `on_page_load` is not
        // early enough — measured 2026-08-07: injected there, the console buffer came
        // back EMPTY and the network log missed both of the page's `fetch` calls. The
        // timings showed why: the page fetched at 87ms and 97ms, the hooks landed at
        // ~850ms. A console buffer installed after boot misses exactly the errors worth
        // having.
        //
        // `js_init_script` runs "after the global object has been created, but before the
        // HTML document has been parsed and before any other script included by the HTML
        // document is run" — which is the only ordering that makes the capture complete.
        //
        // Main frame only, deliberately: sub-frames would each install their own probe
        // and, on same-origin frames, race for the same reply cookies. `eval` targets the
        // main frame anyway, so a sub-frame probe would collect what nothing can read.
        .js_init_script(include_str!("probe.js"))
        .invoke_handler(tauri::generate_handler![
        // Server Commands
        ])
        .on_webview_ready(|webview| {
            relax_mixed_content(&webview);
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                // Applied HERE as well as in `on_webview_ready`, and the redundancy is
                // measured: a CHILD webview created by the application (a tab, a preview
                // pane) does not go through the ready hook, so the setting never reached
                // the only webviews that need it. This hook does fire for them — the probe
                // catch-up injection below proves it. Idempotent: setting a GObject
                // property twice costs nothing.
                relax_mixed_content(&webview);
                let _ = webview.eval(include_str!("listener_patch.js"));
                // Catch-up injection for a webview that existed BEFORE the plugin was
                // installed, and therefore never received the init script. It is late —
                // the hooks will have missed whatever already ran — but a late probe
                // still answers `inspect_dom` and `inspect_eval`, where no probe answers
                // nothing at all. The script is idempotent (`if (window.__TMCP__) return`),
                // so this never double-installs over the init-script path.
                let _ = webview.eval(include_str!("probe.js"));
            }
        })
        .setup(move |app, api| {
            info!("[TAURI_MCP] Setting up plugin");
            #[cfg(mobile)]
            return Err("Mobile is not supported".into());
            #[cfg(desktop)]
            let tauri_mcp = desktop::init(app, api, &config)?;
            app.manage(tauri_mcp);
            info!("[TAURI_MCP] Plugin setup complete");
            Ok(())
        })
        .build()
}

/// Lets a page load http sub-resources when it was itself served over https.
///
/// # Why this exists — measured, not assumed
///
/// A development dashboard served over https by a reverse proxy, whose Vue bundle is
/// served over plain http by a Vite dev server, renders in Chromium and does NOT render
/// in WebKitGTK: the engine refuses the module as active mixed content. Proved
/// 2026-08-07 by shooting the same URL with both engines seconds apart — Chromium showed
/// the login form, the WebKitGTK webview showed the PHP shell with an unmounted app —
/// and confirmed from inside the page: `fetch` of the module URL returned
/// `TypeError: Load failed`, with no CSP anywhere on the page.
///
/// ⛔ Nothing reported it. The refusal emits no `console.error`, and a `<script>` that
/// fails to load fires an `error` event only in the CAPTURE phase on `window` — which is
/// why `probe.js` now listens there too. An inspection tool that cannot open a
/// development dashboard misses its own target.
///
/// # Why it is a feature, off by default
///
/// This lowers a real security boundary. Only a development host should ask for it, and
/// it should be asked for explicitly rather than inherited: a plugin that silently
/// weakened mixed-content protection everywhere would be a worse defect than the one it
/// fixes. Enable with:
///
/// ```toml
/// tauri-plugin-mcp = { ..., features = ["insecure-content"] }
/// ```
///
/// Without the feature this is a no-op — deliberately, so that the call site reads the
/// same on every platform and every build.
#[allow(unused_variables)]
fn relax_mixed_content<R: Runtime>(webview: &tauri::Webview<R>) {
    #[cfg(all(target_os = "linux", feature = "insecure-content", debug_assertions))]
    {
        let _ = webview.with_webview(|platform| {
            use webkit2gtk::WebViewExt;
            use webkit2gtk::glib::object::ObjectExt;

            let inner = platform.inner();
            let Some(settings) = WebViewExt::settings(&inner) else { return };

            // ⚠ Set through the GENERIC GObject API, not a typed setter: the
            // `webkit2gtk` bindings expose `connect_insecure_content_detected` but no
            // `set_allow_*_insecure_content`, while WebKitGTK itself carries both
            // properties. Going through `set_property` reaches them without waiting on
            // the bindings — at the cost of losing compile-time checking, which is why
            // each name is looked up first: `set_property` PANICS on an unknown
            // property, and a panic inside a webview callback takes the app down.
            for name in ["allow-running-of-insecure-content", "allow-display-of-insecure-content"] {
                if settings.find_property(name).is_some() {
                    settings.set_property(name, true);
                    info!("[TAURI_MCP] {name} enabled (insecure-content, debug build)");
                } else {
                    warn!("[TAURI_MCP] {name} is absent from this WebKitGTK — not applied");
                }
            }
        });
    }
}
