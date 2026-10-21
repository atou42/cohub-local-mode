import type { BillingCatalogProduct, BillingCheckoutResult, SpaceWalletActivityPage, SpaceWalletSummary } from "../types.js";
import type { HttpTransport } from "../transport.js";

export class SpaceWalletApi {
  constructor(private readonly transport: HttpTransport, private readonly spaceId: string) {}

  get() {
    return this.transport.request<SpaceWalletSummary>(`/api/spaces/${this.spaceId}/wallet`);
  }

  catalog() {
    return this.transport.request<{ supported: boolean; paymentAvailable: boolean; products: BillingCatalogProduct[] }>(`/api/spaces/${this.spaceId}/wallet/catalog`);
  }

  activities(page = 1) {
    return this.transport.request<SpaceWalletActivityPage>(`/api/spaces/${this.spaceId}/wallet/activities?page=${page}`);
  }

  createOrder(input: { id: string; productKey: string }) {
    return this.transport.request<{ checkout: BillingCheckoutResult; orderId: string }>(`/api/spaces/${this.spaceId}/wallet/orders`, {
      method: "POST", body: JSON.stringify(input),
    });
  }

  confirmOrder(orderId: string) {
    return this.transport.request<{ settled: boolean; pending: boolean }>(`/api/spaces/${this.spaceId}/wallet/orders/${encodeURIComponent(orderId)}`);
  }
}
