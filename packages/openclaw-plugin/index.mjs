/**
 * OpenClaw Plugin: agent-secrets
 *
 * Registers a `request_secret` tool that enables the agent to securely
 * request secrets from the user via an encrypted browser link.
 *
 * The user receives a Telegram/WhatsApp/etc. message with a link and
 * confirmation code. They click the link, verify the code, enter their
 * secret, and it's HPKE-encrypted client-side before submission.
 * The agent retrieves and decrypts it — the secret never touches
 * the server in plaintext.
 */

import { requestSecretFlow, cleanup } from "./sps-bridge.mjs";

export default function register(api) {
    api.registerTool({
        name: "request_secret",
        description: [
            "Securely request a secret (API key, password, token, SSH key, etc.) from the user.",
            "This sends the user a secure link where they can enter the secret.",
            "The secret is encrypted client-side and never visible to the server.",
            "IMPORTANT: NEVER ask the user to paste secrets directly in chat. Always use this tool.",
        ].join(" "),
        parameters: {
            type: "object",
            properties: {
                description: {
                    type: "string",
                    description: "Human-readable description of what the secret is for, e.g. 'GitHub deploy token for CI/CD pipeline'",
                },
            },
            required: ["description"],
        },

        async execute(_id, params, context) {
            const description = params.description?.trim();
            if (!description) {
                return {
                    content: [{ type: "text", text: "Error: description is required for request_secret." }],
                };
            }

            try {
                const spsBaseUrl = process.env.SPS_BASE_URL ?? "http://localhost:3100";

                const secret = await requestSecretFlow({
                    description,
                    spsBaseUrl,
                    onSecretLink: async (secretUrl, confirmationCode) => {
                        // Send the link to the user via the current chat channel.
                        // context.sendText is the OpenClaw outbound — it routes to
                        // whichever channel (Telegram, WhatsApp, etc.) the conversation
                        // is happening on.
                        const message = [
                            "🔐 **Secure secret requested**",
                            "",
                            `**Purpose:** ${description}`,
                            `**Confirmation code:** \`${confirmationCode}\``,
                            "",
                            `👉 [Open secure link](${secretUrl})`,
                            "",
                            "_Verify the confirmation code matches before entering your secret._",
                            "_The link expires in 3 minutes._",
                        ].join("\n");

                        if (context?.sendText) {
                            await context.sendText(message);
                        } else if (api.sendText) {
                            await api.sendText(message);
                        } else {
                            // Fallback: log it (useful for testing without a real channel)
                            console.log(`[agent-secrets] Secret link for user:\n${message}`);
                        }
                    },
                });

                return {
                    content: [{
                        type: "text",
                        text: `Secret received successfully. The value is: ${secret}`,
                    }],
                };
            } catch (err) {
                const message = err?.message ?? String(err);

                if (message.includes("did not provide the secret in time")) {
                    return {
                        content: [{
                            type: "text",
                            text: "The user did not provide the secret within the time limit. Ask the user if they still want to proceed, and if so, call request_secret again.",
                        }],
                    };
                }

                return {
                    content: [{
                        type: "text",
                        text: `Failed to retrieve secret: ${message}`,
                    }],
                };
            }
        },
    });

    // Cleanup temp files on gateway shutdown
    if (api.registerHook) {
        api.registerHook(
            "shutdown",
            async () => {
                await cleanup();
            },
            {
                name: "agent-secrets.cleanup",
                description: "Cleanup temporary gateway identity files",
            },
        );
    }
}
