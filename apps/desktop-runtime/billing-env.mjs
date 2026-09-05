export function withoutHostedBilling(environment) {
	const local = { ...environment };
	delete local.TALESOFAI_BILLING_BASE_URL;
	delete local.TALESOFAI_BILLING_BUSINESS_KEY;
	delete local.TALESOFAI_BILLING_ADMIN_API_KEY;
	return local;
}
