/**
 * OpenClaw Plugin entrypoint.
 *
 * The tool implementation lives in blindpass-core so it can be shared by
 * additional runtimes (MCP server and resolver) without duplicating logic.
 */

export {
    default,
    buildExchangeDeliveryMessage,
    createOpenClawAgentTransport,
    disposeStoredSecret,
    getStoredSecret,
    resolveOpenClawAgentTarget,
} from "./blindpass-core.mjs";
