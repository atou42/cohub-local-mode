export type SpaceWalletSummary = {
  spaceId: string;
  balanceUsd: number;
  usable: boolean;
};

export type SpaceWalletActivity = {
  id: string;
  kind: "grant" | "usage" | "refund" | "expire" | "revoke" | "adjust";
  amountUsd: number;
  actorUserId: string | null;
  sourceId: string | null;
  createdAt: string;
};

export type SpaceWalletActivityPage = {
  items: SpaceWalletActivity[];
  hasMore: boolean;
};
