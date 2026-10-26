import type { PushSupport } from "@/lib/pwa/push-support";

export type PushToggleView = "unavailable" | "unsupported" | "install_first" | "too_old" | "blocked" | "on" | "off";

export function pushToggleView(input: {
	publicKeyPresent: boolean;
	support: PushSupport;
	permission: NotificationPermission;
	browserSubscribed: boolean;
	serverSubscribed: boolean;
}): PushToggleView {
	if (!input.publicKeyPresent) return "unavailable";
	if (input.support === "unsupported") return "unsupported";
	if (input.support === "ios_install_required") return "install_first";
	if (input.support === "ios_too_old") return "too_old";
	if (input.permission === "denied") return "blocked";
	return input.browserSubscribed && input.serverSubscribed ? "on" : "off";
}
