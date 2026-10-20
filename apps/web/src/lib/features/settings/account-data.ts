import { AccountResource } from "$lib/features/settings/account-resource.svelte";
import { sdk } from "$lib/sdk";

export const BALANCE_ACTIVITY_PAGE_SIZE = 10;

export const billingCredits = new AccountResource("billing-credits", () =>
	sdk.billing.getCredits(),
);

export const billingActivity = new AccountResource("billing-activity", () =>
	sdk.billing
		.getBalanceActivities({ page: 1, limit: BALANCE_ACTIVITY_PAGE_SIZE })
		.then(({ activities }) => activities),
);

export const referrals = new AccountResource("referrals", () =>
	sdk.referrals.getMine(),
);

export const channels = new AccountResource("channels", () =>
	sdk.channels.list(),
);

export const rules = new AccountResource("home-rules", () =>
	sdk.user.getRules(),
);
