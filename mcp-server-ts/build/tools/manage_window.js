import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";
// Snake_case → camelCase mapping for manage_window operations
const OPERATION_MAP = {
    focus: "focus",
    minimize: "minimize",
    maximize: "maximize",
    unmaximize: "unmaximize",
    close: "close",
    show: "show",
    hide: "hide",
    set_position: "setPosition",
    set_size: "setSize",
    center: "center",
    toggle_fullscreen: "toggleFullscreen",
};
export function registerManageWindowTool(server) {
    server.tool("manage_window", "Manages windows, zoom, devtools, and webview state. Window actions: list, focus, minimize, maximize, unmaximize, close, show, hide, set_position, set_size, center, toggle_fullscreen. Zoom: set_zoom, get_zoom. DevTools: open_devtools, close_devtools, is_devtools_open. Webview state: clear_browsing_data, set_background_color, get_bounds, set_auto_resize.", {
        action: z.enum([
            // Window operations
            "list", "focus", "minimize", "maximize", "unmaximize", "close",
            "show", "hide", "set_position", "set_size", "center", "toggle_fullscreen",
            // Zoom
            "set_zoom", "get_zoom",
            // DevTools
            "open_devtools", "close_devtools", "is_devtools_open",
            // Webview state
            "clear_browsing_data", "set_background_color", "get_bounds", "set_auto_resize",
        ]).describe("The window management action to perform."),
        window_label: z.string().default("main").describe("Target window. Defaults to 'main'."),
        // set_position
        x: z.number().int().optional().describe("(set_position) X coordinate in screen pixels."),
        y: z.number().int().optional().describe("(set_position) Y coordinate in screen pixels."),
        // set_size
        width: z.number().int().positive().optional().describe("(set_size) Width in pixels."),
        height: z.number().int().positive().optional().describe("(set_size) Height in pixels."),
        // set_zoom
        scale: z.number().min(0.1).max(5.0).optional().describe("(set_zoom) Zoom scale factor. 1.0 = 100%."),
        // set_background_color
        r: z.number().int().min(0).max(255).optional().describe("(set_background_color) Red component (0-255)."),
        g: z.number().int().min(0).max(255).optional().describe("(set_background_color) Green component (0-255)."),
        b: z.number().int().min(0).max(255).optional().describe("(set_background_color) Blue component (0-255)."),
        a: z.number().int().min(0).max(255).optional().describe("(set_background_color) Alpha component (0-255). 255=opaque."),
        // set_auto_resize
        enabled: z.boolean().optional().describe("(set_auto_resize) Whether to enable auto-resize."),
    }, {
        title: "Manage Windows and Webview Configuration",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
    }, async (params) => {
        try {
            const { action, window_label } = params;
            // Route: list_windows
            if (action === "list") {
                logCommandParams('list_windows', {});
                const result = await socketClient.sendCommand('list_windows', {});
                if (!result || typeof result !== 'object') {
                    return createErrorResponse('Failed to get a valid response');
                }
                if ('success' in result && !result.success) {
                    return createErrorResponse(result.error || 'list_windows failed');
                }
                const data = result.data ?? result;
                return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
            }
            // Route: manage_zoom
            if (action === "set_zoom" || action === "get_zoom") {
                const zoomAction = action === "set_zoom" ? "set" : "get";
                const payload = { action: zoomAction, window_label };
                if (params.scale !== undefined)
                    payload.scale = params.scale;
                logCommandParams('manage_zoom', payload);
                const result = await socketClient.sendCommand('manage_zoom', payload);
                if (!result || typeof result !== 'object') {
                    return createErrorResponse('Failed to get a valid response');
                }
                if ('success' in result && !result.success) {
                    return createErrorResponse(result.error || 'manage_zoom failed');
                }
                const data = result.data ?? result;
                return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
            }
            // Route: manage_devtools
            if (action === "open_devtools" || action === "close_devtools" || action === "is_devtools_open") {
                const devtoolsAction = action === "open_devtools" ? "open"
                    : action === "close_devtools" ? "close"
                        : "is_open";
                const payload = { action: devtoolsAction, window_label };
                logCommandParams('manage_devtools', payload);
                const result = await socketClient.sendCommand('manage_devtools', payload);
                if (!result || typeof result !== 'object') {
                    return createErrorResponse('Failed to get a valid response');
                }
                if ('success' in result && !result.success) {
                    return createErrorResponse(result.error || 'manage_devtools failed');
                }
                const data = result.data ?? result;
                return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
            }
            // Route: manage_webview_state
            if (action === "clear_browsing_data" || action === "set_background_color" ||
                action === "get_bounds" || action === "set_auto_resize") {
                const payload = { action, window_label };
                if (params.r !== undefined)
                    payload.r = params.r;
                if (params.g !== undefined)
                    payload.g = params.g;
                if (params.b !== undefined)
                    payload.b = params.b;
                if (params.a !== undefined)
                    payload.a = params.a;
                if (params.enabled !== undefined)
                    payload.enabled = params.enabled;
                logCommandParams('manage_webview_state', payload);
                const result = await socketClient.sendCommand('manage_webview_state', payload);
                if (!result || typeof result !== 'object') {
                    return createErrorResponse('Failed to get a valid response');
                }
                if ('success' in result && !result.success) {
                    return createErrorResponse(result.error || 'manage_webview_state failed');
                }
                const data = result.data ?? result;
                return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
            }
            // Route: manage_window (standard window operations)
            const operation = OPERATION_MAP[action];
            if (!operation) {
                return createErrorResponse(`Unknown action: ${action}`);
            }
            const payload = { operation, window_label };
            if (params.x !== undefined)
                payload.x = params.x;
            if (params.y !== undefined)
                payload.y = params.y;
            if (params.width !== undefined)
                payload.width = params.width;
            if (params.height !== undefined)
                payload.height = params.height;
            logCommandParams('manage_window', payload);
            await socketClient.sendCommand('manage_window', payload);
            return createSuccessResponse(`Window action '${action}' completed successfully`);
        }
        catch (error) {
            console.error('manage_window error:', error);
            return createErrorResponse(`Failed to manage window: ${error.message}`);
        }
    });
}
