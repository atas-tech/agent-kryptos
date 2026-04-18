import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import registerBlindPassTools from "./index.mjs";

const SERVER_NAME = "blindpass";
const SERVER_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

function ensureObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolSchema(tool) {
    if (ensureObject(tool?.parameters)) {
        return tool.parameters;
    }
    return {
        type: "object",
        properties: {},
    };
}

export function createMcpServer(options = {}) {
    const tools = new Map();
    const hooks = [];

    const api = {
        registerTool(tool) {
            if (!tool?.name || typeof tool.execute !== "function") {
                throw new Error("Invalid tool registration.");
            }
            tools.set(tool.name, tool);
        },
        registerHook(event, handler, meta) {
            hooks.push({ event, handler, meta });
        },
    };

    const runtime = {
        managedStoreRuntimeMode: "mcp",
        ...(options.runtime ?? {}),
    };
    registerBlindPassTools(api, runtime);

    return {
        tools,
        hooks,
        serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        protocolVersion: MCP_PROTOCOL_VERSION,
    };
}

function jsonRpcSuccess(id, result) {
    return {
        jsonrpc: "2.0",
        id,
        result,
    };
}

function jsonRpcError(id, code, message) {
    return {
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
            code,
            message,
        },
    };
}

function listToolsResult(server) {
    const toolList = [];
    for (const tool of server.tools.values()) {
        toolList.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: normalizeToolSchema(tool),
        });
    }
    return { tools: toolList };
}

async function callTool(server, params) {
    if (!ensureObject(params)) {
        throw new Error("tools/call requires an object params payload.");
    }

    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) {
        throw new Error("tools/call requires a tool name.");
    }
    const tool = server.tools.get(name);
    if (!tool) {
        return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }

    const args = ensureObject(params.arguments) ? params.arguments : {};
    const context = ensureObject(params.context) ? params.context : {};
    const toolResult = await tool.execute(
        `${name}-${Date.now()}`,
        args,
        context,
    );

    if (ensureObject(toolResult)) {
        return toolResult;
    }
    return {
        content: [{ type: "text", text: String(toolResult ?? "") }],
    };
}

export async function handleMcpRpcRequest(server, message) {
    if (!ensureObject(message)) {
        return jsonRpcError(null, JSONRPC_INVALID_REQUEST, "Request must be a JSON object.");
    }

    if (message.jsonrpc !== "2.0") {
        return jsonRpcError(message.id ?? null, JSONRPC_INVALID_REQUEST, "jsonrpc must be '2.0'.");
    }

    const isNotification = message.id == null;
    const method = typeof message.method === "string" ? message.method : "";
    if (!method) {
        return isNotification ? null : jsonRpcError(message.id, JSONRPC_INVALID_REQUEST, "Missing method.");
    }

    try {
        if (method === "initialize") {
            const result = {
                protocolVersion: server.protocolVersion,
                capabilities: {
                    tools: {},
                },
                serverInfo: server.serverInfo,
            };
            return isNotification ? null : jsonRpcSuccess(message.id, result);
        }

        if (method === "notifications/initialized") {
            return null;
        }

        if (method === "tools/list") {
            return isNotification ? null : jsonRpcSuccess(message.id, listToolsResult(server));
        }

        if (method === "tools/call") {
            const result = await callTool(server, message.params);
            return isNotification ? null : jsonRpcSuccess(message.id, result);
        }

        return isNotification ? null : jsonRpcError(message.id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    } catch (err) {
        const messageText = err?.message ?? String(err);
        if (messageText.includes("requires")) {
            return isNotification ? null : jsonRpcError(message.id, JSONRPC_INVALID_PARAMS, messageText);
        }
        return isNotification ? null : jsonRpcError(message.id, JSONRPC_INTERNAL_ERROR, "Internal server error.");
    }
}

function encodeRpcMessage(payload) {
    const body = JSON.stringify(payload);
    const length = Buffer.byteLength(body, "utf8");
    return `Content-Length: ${length}\r\n\r\n${body}`;
}

export async function runMcpServerStdio(server, streams = {}) {
    const input = streams.input ?? process.stdin;
    const output = streams.output ?? process.stdout;
    const error = streams.error ?? process.stderr;

    let buffer = Buffer.alloc(0);

    const processBuffer = async () => {
        while (true) {
            const headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                return;
            }

            const headerText = buffer.slice(0, headerEnd).toString("utf8");
            const lengthMatch = headerText.match(/content-length:\s*(\d+)/i);
            if (!lengthMatch) {
                throw new Error("Missing Content-Length header.");
            }

            const contentLength = Number.parseInt(lengthMatch[1], 10);
            const messageStart = headerEnd + 4;
            if (buffer.length < messageStart + contentLength) {
                return;
            }

            const bodyBuffer = buffer.slice(messageStart, messageStart + contentLength);
            buffer = buffer.slice(messageStart + contentLength);

            let request;
            try {
                request = JSON.parse(bodyBuffer.toString("utf8"));
            } catch {
                const response = jsonRpcError(null, JSONRPC_PARSE_ERROR, "Invalid JSON.");
                output.write(encodeRpcMessage(response));
                continue;
            }

            const response = await handleMcpRpcRequest(server, request);
            if (response) {
                output.write(encodeRpcMessage(response));
            }
        }
    };

    return new Promise((resolve, reject) => {
        input.on("data", async (chunk) => {
            try {
                buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
                await processBuffer();
            } catch (err) {
                error.write(`[blindpass] mcp-server error: ${err?.message ?? String(err)}\n`);
                reject(err);
            }
        });
        input.on("end", () => resolve());
        input.on("error", (err) => reject(err));
    });
}

export async function main() {
    const server = createMcpServer();
    await runMcpServerStdio(server);
}

function normalizedEntryHref(entryPath) {
    if (!entryPath) return "";
    try {
        return pathToFileURL(realpathSync(entryPath)).href;
    } catch {
        return pathToFileURL(entryPath).href;
    }
}

const currentEntryHref = normalizedEntryHref(process.argv[1]);
const moduleEntryHref = normalizedEntryHref(fileURLToPath(import.meta.url));
if (moduleEntryHref === currentEntryHref) {
    await main();
}
