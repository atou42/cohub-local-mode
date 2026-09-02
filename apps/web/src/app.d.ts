// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	interface Window {
		cohubDisableVConsole?: () => void;
		cohubEnableVConsole?: () => Promise<void>;
		cohubPersonalNode?: {
			register(input: {
				accessToken: string;
				refreshToken: string;
				accessTokenExpiresAt: number;
				scope: string;
			}): Promise<{
				deviceId: string;
				status: string;
			}>;
			status(): Promise<{
				state: string;
				deviceId: string | null;
				message: string | null;
			}>;
			onStatus(listener: (status: unknown) => void): () => void;
		};
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState {
			workspacePreview?: string | null;
		}
		// interface Platform {}
	}
}

declare module "$env/static/public" {
	export const PUBLIC_API_ORIGIN: string | undefined;
	export const PUBLIC_COHUB_ENV: string | undefined;
	export const PUBLIC_GATEWAY_ORIGIN: string | undefined;
	export const PUBLIC_PREVIEW_ORIGIN: string | undefined;
}

export {};
