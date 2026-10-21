export function resolveWalletMessageEligibility(env: NodeJS.ProcessEnv = process.env): boolean {
  const businessKey = env.TALESOFAI_BILLING_SPACE_WALLET_BUSINESS_KEY?.trim();
  return Boolean(businessKey && businessKey !== env.TALESOFAI_BILLING_BUSINESS_KEY?.trim());
}
