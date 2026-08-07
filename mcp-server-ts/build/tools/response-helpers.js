/**
 * Common response helper functions for MCP tool implementations
 */
import path from "path";
/**
 * Creates a standardized error response
 *
 * @param message Error message to display
 * @returns Properly formatted error response object
 */
export function createErrorResponse(message) {
    return {
        isError: true,
        content: [{ type: "text", text: message }],
    };
}
/**
 * Creates a standardized success response with text content
 *
 * @param text Success message or result to display
 * @returns Properly formatted success response object
 */
export function createSuccessResponse(text) {
    return {
        isError: false,
        content: [{ type: "text", text }],
    };
}
/**
 * Creates a standardized success response with image content
 *
 * @param base64Data Base64-encoded image data
 * @param mimeType MIME type of the image (default: 'image/jpeg')
 * @returns Properly formatted success response with image
 */
export function createImageResponse(base64Data, mimeType = 'image/jpeg') {
    return {
        isError: false,
        content: [{
                type: "image",
                data: base64Data,
                mimeType
            }],
    };
}
/**
 * Creates a success response with image content and optional annotations
 *
 * @param base64Data Base64-encoded image data
 * @param mimeType MIME type of the image (default: 'image/jpeg')
 * @param annotations Optional audience/priority annotations
 * @returns Properly formatted success response with annotated image
 */
export function createAnnotatedImageResponse(base64Data, mimeType = "image/jpeg", annotations) {
    const content = {
        type: "image",
        data: base64Data,
        mimeType,
    };
    if (annotations) {
        content.annotations = annotations;
    }
    return {
        isError: false,
        content: [content],
    };
}
/**
 * Creates an embedded resource response pointing to a file on disk.
 * Uses file:// URI for cross-platform correctness.
 *
 * @param filePath Absolute path to the file
 * @param mimeType MIME type of the resource (default: 'image/jpeg')
 * @returns Properly formatted response with embedded resource
 */
export function createEmbeddedResourceResponse(filePath, mimeType = "image/jpeg") {
    // Resolve relative paths to absolute before forming URI
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);
    // Convert path to file:// URI (cross-platform)
    const fileUri = absolutePath.startsWith("/")
        ? `file://${absolutePath}`
        : `file:///${absolutePath.replace(/\\/g, "/")}`;
    return {
        isError: false,
        content: [
            {
                type: "resource",
                resource: {
                    uri: fileUri,
                    mimeType,
                    text: `Screenshot saved to: ${absolutePath}`,
                },
            },
        ],
    };
}
/**
 * Extract file_path from a result object if present
 *
 * @param result Result object from command
 * @returns File path string or null
 */
export function extractFilePath(result) {
    if (result && typeof result === "object") {
        const obj = result;
        if (obj.filePath && typeof obj.filePath === "string") {
            return obj.filePath;
        }
        if (obj.file_path && typeof obj.file_path === "string") {
            return obj.file_path;
        }
        // Check nested data
        if (obj.data && typeof obj.data === "object") {
            if (obj.data.filePath && typeof obj.data.filePath === "string") {
                return obj.data.filePath;
            }
            if (obj.data.file_path && typeof obj.data.file_path === "string") {
                return obj.data.file_path;
            }
        }
    }
    return null;
}
/**
 * Helper to safely extract base64 data from various response formats
 *
 * @param result Result object from command
 * @returns Extracted base64 data or null if not found
 */
export function extractBase64Data(result) {
    if (typeof result === 'string') {
        // Direct base64 string
        return result.startsWith('data:image')
            ? result.split(',')[1] // Remove the data URL prefix if present
            : result;
    }
    else if (result && typeof result === 'object') {
        // Check for data field in response object
        const obj = result;
        if (obj.data) {
            if (typeof obj.data === 'string') {
                return obj.data.startsWith('data:image')
                    ? obj.data.split(',')[1]
                    : obj.data;
            }
            else if (obj.data.data && typeof obj.data.data === 'string') {
                // Handle nested data structure
                return obj.data.data.startsWith('data:image')
                    ? obj.data.data.split(',')[1]
                    : obj.data.data;
            }
        }
    }
    return null;
}
/**
 * Format result from command as text, handling different types
 *
 * @param result Result from command execution
 * @returns Formatted text representation
 */
export function formatResultAsText(result) {
    if (typeof result === 'string') {
        return result;
    }
    else {
        return JSON.stringify(result, null, 2);
    }
}
/**
 * Helper to log parameters for debugging purposes
 *
 * @param commandName Name of the command being executed
 * @param params Parameters being sent to the command
 */
export function logCommandParams(commandName, params) {
    // Handle special case for code to prevent huge logs
    if (params.code && typeof params.code === 'string') {
        params = {
            ...params,
            code: params.code.substring(0, 100) + (params.code.length > 100 ? '...' : '')
        };
    }
    console.error(`Executing ${commandName} with params: ${JSON.stringify(params)}`);
}
