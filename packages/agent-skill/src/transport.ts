export const EXCHANGE_FULFILLMENT_ENVELOPE_KIND = "agent-kryptos.exchange-fulfillment.v1";

export interface FulfillmentTransportEnvelope {
  kind: typeof EXCHANGE_FULFILLMENT_ENVELOPE_KIND;
  exchangeId: string;
  requesterId: string | null;
  fulfillerId: string;
  secretName: string;
  purpose: string;
  fulfillmentToken: string;
}

export interface CreateFulfillmentTransportEnvelopeParams {
  exchangeId: string;
  requesterId?: string | null;
  fulfillerId: string;
  secretName: string;
  purpose: string;
  fulfillmentToken: string;
}

export interface FulfillmentTransport {
  deliverFulfillmentToken(envelope: FulfillmentTransportEnvelope): Promise<void>;
}

export function createFulfillmentTransportEnvelope(
  params: CreateFulfillmentTransportEnvelopeParams
): FulfillmentTransportEnvelope {
  return {
    kind: EXCHANGE_FULFILLMENT_ENVELOPE_KIND,
    exchangeId: params.exchangeId,
    requesterId: params.requesterId ?? null,
    fulfillerId: params.fulfillerId,
    secretName: params.secretName,
    purpose: params.purpose,
    fulfillmentToken: params.fulfillmentToken
  };
}
