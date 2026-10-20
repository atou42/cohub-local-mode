export class OutboundDeliveryUnknownError extends Error {
  override name = "OutboundDeliveryUnknownError";
}

export type GatewayOutboundResult = {
  success: boolean;
  error?: string;
  externalMessageId?: string;
  deferred?: boolean;
  retryable?: boolean;
};

export type GatewayOutboundContext = {
  signal: AbortSignal;
  checkpoint: <T, P = undefined>(itemId: string, send: (prepared: P) => Promise<T>, prepare?: () => Promise<P>) => Promise<T>;
};

export interface GatewayProvider {
  destroy(): void;
  handleOutbound(cmd: {
    commandId: string;
    provider: string;
    channelId: string;
    externalChatId: string;
    deliveryPlan?: unknown;
    content?: unknown[];
    meta?: Record<string, unknown> | null;
    replyToExternalMessageId?: string;
    sessionMessageId?: string;
  }, context?: GatewayOutboundContext): Promise<GatewayOutboundResult>;
}
