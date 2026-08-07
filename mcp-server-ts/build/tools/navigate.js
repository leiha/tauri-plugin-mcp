import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";
export function registerNavigateTool(server) {
    server.tool("navigate", "Controls webview navigation. 'goto' navigates to a URL. 'back'/'forward' move through browser history (use delta for multi-step jumps). 'reload' reloads the current page. Use query_page(mode='state') afterward to confirm navigation completed.", {
        action: z.enum(["goto", "back", "forward", "reload"]).describe("Navigation action to perform."),
        url: z.string().optional().describe("(goto) URL to navigate to. Required for 'goto'."),
        delta: z.number().int().optional().describe("(back/forward) Number of history steps to jump. Negative=back, positive=forward."),
        window_label: z.string().default("main").describe("Target window. Defaults to 'main'."),
    }, {
        title: "Navigate Webview",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    }, async ({ action, url, delta, window_label }) => {
        try {
            switch (action) {
                case "goto": {
                    if (!url) {
                        return createErrorResponse("'url' is required for 'goto' action");
                    }
                    const payload = { action: "navigate", window_label, url };
                    logCommandParams('navigate_webview', payload);
                    const result = await socketClient.sendCommand('navigate_webview', payload);
                    if (!result || typeof result !== 'object') {
                        return createErrorResponse('Failed to get a valid response');
                    }
                    if ('success' in result && !result.success) {
                        return createErrorResponse(result.error || 'navigation failed');
                    }
                    const data = result.data ?? result;
                    return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
                }
                case "back":
                case "forward": {
                    // Use navigate_back for delta-based or simple back/forward
                    if (delta !== undefined) {
                        const payload = { window_label, direction: action, delta };
                        logCommandParams('navigate_back', payload);
                        const result = await socketClient.sendCommand('navigate_back', payload);
                        if (!result || typeof result !== 'object') {
                            return createErrorResponse('Failed to get a valid response');
                        }
                        if ('success' in result && !result.success) {
                            return createErrorResponse(result.error || 'navigation failed');
                        }
                        const data = result.data ?? result;
                        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
                    }
                    // Simple back/forward via navigate_webview
                    const payload = { action, window_label };
                    logCommandParams('navigate_webview', payload);
                    const result = await socketClient.sendCommand('navigate_webview', payload);
                    if (!result || typeof result !== 'object') {
                        return createErrorResponse('Failed to get a valid response');
                    }
                    if ('success' in result && !result.success) {
                        return createErrorResponse(result.error || 'navigation failed');
                    }
                    const data = result.data ?? result;
                    return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
                }
                case "reload": {
                    const payload = { action: "reload", window_label };
                    logCommandParams('navigate_webview', payload);
                    const result = await socketClient.sendCommand('navigate_webview', payload);
                    if (!result || typeof result !== 'object') {
                        return createErrorResponse('Failed to get a valid response');
                    }
                    if ('success' in result && !result.success) {
                        return createErrorResponse(result.error || 'reload failed');
                    }
                    const data = result.data ?? result;
                    return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
                }
                default:
                    return createErrorResponse(`Unknown action: ${action}`);
            }
        }
        catch (error) {
            console.error('navigate error:', error);
            return createErrorResponse(`Failed to navigate: ${error.message}`);
        }
    });
}
