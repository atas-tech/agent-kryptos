import { GatewaySpsClient, type CreateSecretRequestResult, type GatewaySpsClientOptions } from "./sps-client.js";

export interface InterceptorResponse {
  status: "secret_request_pending";
  request_id: string;
}

export interface RequestSecretToolInput {
  description: string;
  public_key: string;
  channel_id: string;
}

export interface ChatAdapter {
  sendMessage(channelId: string, message: string): Promise<void>;
}

export interface RequestSecretInterceptorOptions {
  spsClient: GatewaySpsClient;
  chatAdapter: ChatAdapter;
  messageFormatter?: (request: CreateSecretRequestResult, input: RequestSecretToolInput) => string;
}

export interface RequestSecretInterceptorFactoryOptions extends GatewaySpsClientOptions {
  chatAdapter: ChatAdapter;
  messageFormatter?: (request: CreateSecretRequestResult, input: RequestSecretToolInput) => string;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function defaultMessageFormatter(request: CreateSecretRequestResult, input: RequestSecretToolInput): string {
  return [
    "Secure secret requested.",
    `Purpose: ${input.description}`,
    `Confirmation code: ${request.confirmationCode}`,
    `Open link: ${request.secretUrl}`
  ].join("\n");
}

export class RequestSecretInterceptor {
  private readonly spsClient: GatewaySpsClient;

  private readonly chatAdapter: ChatAdapter;

  private readonly messageFormatter: (request: CreateSecretRequestResult, input: RequestSecretToolInput) => string;

  constructor(options: RequestSecretInterceptorOptions) {
    this.spsClient = options.spsClient;
    this.chatAdapter = options.chatAdapter;
    this.messageFormatter = options.messageFormatter ?? defaultMessageFormatter;
  }

  async handleRequestSecret(input: RequestSecretToolInput): Promise<InterceptorResponse> {
    const request = await this.spsClient.createSecretRequest({
      description: input.description,
      publicKey: input.public_key
    });

    const message = this.messageFormatter(request, input);
    await this.chatAdapter.sendMessage(input.channel_id, message);

    // Only non-sensitive fields are returned to LLM.
    return {
      status: "secret_request_pending",
      request_id: request.requestId
    };
  }

  async interceptToolCall(toolName: string, input: unknown): Promise<InterceptorResponse | null> {
    if (toolName !== "request_secret") {
      return null;
    }

    return this.handleRequestSecret(parseRequestSecretInput(input));
  }
}

function parseRequestSecretInput(input: unknown): RequestSecretToolInput {
  if (!input || typeof input !== "object") {
    throw new Error("request_secret input must be an object");
  }

  const typed = input as Partial<RequestSecretToolInput>;
  if (typeof typed.description !== "string" || typeof typed.public_key !== "string" || typeof typed.channel_id !== "string") {
    throw new Error("request_secret requires description, public_key, and channel_id");
  }

  const description = typed.description.trim();
  const publicKey = typed.public_key.trim();
  const channelId = typed.channel_id.trim();

  if (!description || description.length > 512) {
    throw new Error("request_secret.description must be 1-512 characters");
  }

  if (!channelId || channelId.length > 256) {
    throw new Error("request_secret.channel_id must be 1-256 characters");
  }

  if (publicKey.length < 4 || publicKey.length > 2048 || !BASE64_PATTERN.test(publicKey)) {
    throw new Error("request_secret.public_key must be base64 and 4-2048 characters");
  }

  return {
    description,
    public_key: publicKey,
    channel_id: channelId
  };
}

export function createRequestSecretInterceptor(options: RequestSecretInterceptorFactoryOptions): RequestSecretInterceptor {
  return new RequestSecretInterceptor({
    spsClient: new GatewaySpsClient(options),
    chatAdapter: options.chatAdapter,
    messageFormatter: options.messageFormatter
  });
}
