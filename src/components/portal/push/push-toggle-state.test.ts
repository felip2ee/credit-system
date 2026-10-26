import { describe, expect, it } from "vitest";

import { pushToggleView } from "./push-toggle-state";

const ready = {
	publicKeyPresent: true,
	support: "ready" as const,
	permission: "default" as NotificationPermission,
	browserSubscribed: false,
	serverSubscribed: false,
};

describe("pushToggleView", () => {
	it("sem chave: unavailable, mesmo com tudo pronto", () => {
		expect(pushToggleView({ ...ready, publicKeyPresent: false, browserSubscribed: true, serverSubscribed: true })).toBe("unavailable");
	});
	it("mapeia o suporte", () => {
		expect(pushToggleView({ ...ready, support: "ios_install_required" })).toBe("install_first");
		expect(pushToggleView({ ...ready, support: "ios_too_old" })).toBe("too_old");
		expect(pushToggleView({ ...ready, support: "unsupported" })).toBe("unsupported");
	});
	it("permissão negada: blocked", () => {
		expect(pushToggleView({ ...ready, permission: "denied" })).toBe("blocked");
	});
	it("navegador e servidor inscritos: on", () => {
		expect(pushToggleView({ ...ready, permission: "granted", browserSubscribed: true, serverSubscribed: true })).toBe("on");
	});
	it("servidor nega (outro perfil): off", () => {
		expect(pushToggleView({ ...ready, permission: "granted", browserSubscribed: true })).toBe("off");
	});
	it("nada inscrito: off", () => {
		expect(pushToggleView(ready)).toBe("off");
	});
});
