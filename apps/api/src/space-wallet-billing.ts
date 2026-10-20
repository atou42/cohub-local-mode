import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import { createSpaceWalletBilling } from "@cohub/core/space-wallet";
import { createLogger } from "@cohub/infra/logging";

const logger = createLogger({ serviceName: "cohub-api" });
export const spaceWalletBilling = createSpaceWalletBilling({
  billing: billingOperations,
  walletBilling: spaceWalletBillingOperations,
  warn: (message, context) => logger.warn(message, context),
});
