import { x402Client, type PaymentRequired } from "@x402/fetch";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import type { X402BudgetProvider, X402PaymentProvider, X402PaymentRequired } from "./sps-client.js";

const BASE_SEPOLIA_NETWORK = "eip155:84532";

function readOptionalPositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePrivateKey(value: string): `0x${string}` {
  const trimmed = value.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function validateQuotedPaymentRequirement(paymentRequired: X402PaymentRequired, allowedNetwork: string): void {
  if (paymentRequired.x402Version !== 2) {
    throw new Error("SPS returned an invalid x402 quote.");
  }

  const accepted = paymentRequired.accepts[0];
  if (accepted.scheme !== "exact") {
    throw new Error(`Unsupported x402 scheme '${accepted.scheme}'.`);
  }
  if (accepted.network !== allowedNetwork) {
    throw new Error(`Unsupported x402 network '${accepted.network}'.`);
  }
  if (paymentRequired.metadata.quote_expires_at <= Math.floor(Date.now() / 1000)) {
    throw new Error("The x402 payment quote has expired.");
  }
}

export interface NodeX402PaymentProviderOptions {
  privateKey: string;
  allowedNetwork?: string;
  rpcUrl?: string;
}

export class NodeX402PaymentProvider implements X402PaymentProvider {
  private readonly allowedNetwork: string;
  private readonly client: x402Client;

  constructor(options: NodeX402PaymentProviderOptions) {
    this.allowedNetwork = options.allowedNetwork ?? BASE_SEPOLIA_NETWORK;
    if (this.allowedNetwork !== BASE_SEPOLIA_NETWORK) {
      throw new Error(`Unsupported x402 payer network '${this.allowedNetwork}'.`);
    }

    const account = privateKeyToAccount(normalizePrivateKey(options.privateKey));
    const publicClient = options.rpcUrl
      ? createPublicClient({
          chain: baseSepolia,
          transport: http(options.rpcUrl)
        })
      : undefined;
    const signer = toClientEvmSigner(account, publicClient);

    this.client = x402Client.fromConfig({
      schemes: [{
        network: this.allowedNetwork,
        client: new ExactEvmScheme(signer, options.rpcUrl ? { rpcUrl: options.rpcUrl } : undefined)
      }]
    });
  }

  async createPayment(input: {
    paymentIdentifier: string;
    paymentRequired: X402PaymentRequired;
  }): Promise<string> {
    validateQuotedPaymentRequirement(input.paymentRequired, this.allowedNetwork);

    const paymentPayload = await this.client.createPaymentPayload(input.paymentRequired as unknown as PaymentRequired);
    const paymentId = input.paymentIdentifier;
    const existingExtensions = paymentPayload.extensions ?? {};

    return encodePaymentSignatureHeader({
      ...paymentPayload,
      extensions: {
        ...existingExtensions,
        blindpass: {
          paymentId
        }
      }
    });
  }
}

export class FixedX402BudgetProvider implements X402BudgetProvider {
  constructor(private readonly remainingBudgetCents: number) {}

  async getRemainingBudgetCents(): Promise<number> {
    return this.remainingBudgetCents;
  }
}

export function createX402RuntimeProvidersFromEnv(): {
  x402PaymentProvider?: X402PaymentProvider;
  x402BudgetProvider?: X402BudgetProvider;
} {
  const privateKey = process.env.BLINDPASS_X402_PRIVATE_KEY?.trim()
    || process.env.SPS_X402_PAYER_PRIVATE_KEY?.trim();
  const network = process.env.BLINDPASS_X402_NETWORK_ID?.trim()
    || process.env.SPS_X402_PAYER_NETWORK_ID?.trim()
    || BASE_SEPOLIA_NETWORK;
  const rpcUrl = process.env.BLINDPASS_X402_RPC_URL?.trim()
    || process.env.SPS_X402_PAYER_RPC_URL?.trim()
    || undefined;
  const budgetCents = readOptionalPositiveInt(
    process.env.BLINDPASS_X402_BUDGET_CENTS?.trim()
    || process.env.SPS_X402_PAYER_MAX_BUDGET_CENTS?.trim()
  );

  return {
    x402PaymentProvider: privateKey
      ? new NodeX402PaymentProvider({
          privateKey,
          allowedNetwork: network,
          rpcUrl
        })
      : undefined,
    x402BudgetProvider: budgetCents !== null
      ? new FixedX402BudgetProvider(budgetCents)
      : undefined
  };
}
