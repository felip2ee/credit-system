import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { RegisterFormValues } from "@/lib/validators/register";

import { canLeaveStep, hasTypedData, REGISTER_STEPS, SERVER_MESSAGES, serverErrorTarget, stepOfField } from "./register-wizard-steps";

const VALID_CPF = "529.982.247-25";

const base: RegisterFormValues = {
	slug: "acme",
	type: "PF",
	name: "",
	document: "",
	email: "",
	phone: "",
	password: "",
	confirm: "",
	acceptedTerms: false,
	termsVersion: 1,
	privacyVersion: 1,
};

describe("register wizard steps", () => {
	it("has the three steps in order", () => {
		expect(REGISTER_STEPS.map((s) => s.id)).toEqual(["who", "contact", "access"]);
	});

	it("blocks 'who' until name and a valid document are filled, ignoring other steps' fields", () => {
		expect(canLeaveStep("who", base)).toBe(false);
		expect(canLeaveStep("who", { ...base, name: "Maria Souza", document: "111.111.111-11" })).toBe(false);
		expect(canLeaveStep("who", { ...base, name: "Maria Souza", document: VALID_CPF })).toBe(true);
	});

	it("blocks 'contact' on a bad e-mail or short phone", () => {
		const who = { ...base, name: "Maria Souza", document: VALID_CPF };
		expect(canLeaveStep("contact", { ...who, email: "x", phone: "11999999999" })).toBe(false);
		expect(canLeaveStep("contact", { ...who, email: "m@x.com", phone: "123" })).toBe(false);
		expect(canLeaveStep("contact", { ...who, email: "m@x.com", phone: "11999999999" })).toBe(true);
	});

	it("blocks 'access' on short password, mismatch or missing terms", () => {
		const ok = { ...base, name: "Maria Souza", document: VALID_CPF, email: "m@x.com", phone: "11999999999" };
		const pwd = "senha-bem-longa-123";
		expect(canLeaveStep("access", { ...ok, password: "curta", confirm: "curta", acceptedTerms: true })).toBe(false);
		expect(canLeaveStep("access", { ...ok, password: pwd, confirm: "outra-senha-123", acceptedTerms: true })).toBe(false);
		expect(canLeaveStep("access", { ...ok, password: pwd, confirm: pwd, acceptedTerms: false })).toBe(false);
		expect(canLeaveStep("access", { ...ok, password: pwd, confirm: pwd, acceptedTerms: true })).toBe(true);
	});

	it("maps a field to its step", () => {
		expect(stepOfField("document")).toBe("who");
		expect(stepOfField("phone")).toBe("contact");
		expect(stepOfField("acceptedTerms")).toBe("access");
		expect(stepOfField("slug")).toBeNull();
	});

	it("asks to confirm exit only when something was typed", () => {
		expect(hasTypedData(base)).toBe(false);
		expect(hasTypedData({ ...base, type: "PJ" })).toBe(false);
		expect(hasTypedData({ ...base, email: " " })).toBe(false);
		expect(hasTypedData({ ...base, email: "a@b.c" })).toBe(true);
		expect(hasTypedData({ ...base, acceptedTerms: true })).toBe(true);
	});
});

describe("serverErrorTarget", () => {
	it("routes e-mail and document conflicts to the step and field that own them", () => {
		expect(serverErrorTarget(SERVER_MESSAGES.emailInUse)).toEqual({ step: "contact", field: "email" });
		expect(serverErrorTarget(SERVER_MESSAGES.documentInUse)).toEqual({ step: "who", field: "document" });
	});

	it("leaves other answers as a banner", () => {
		expect(serverErrorTarget("Muitas tentativas de cadastro. Tente de novo em uma hora.")).toBeNull();
		expect(serverErrorTarget("")).toBeNull();
	});

	// "use server" files cannot export constants: the texts are copied, so this guards against drift.
	it("uses the exact texts that registerClientAction returns", () => {
		const action = readFileSync("src/actions/register.ts", "utf8");
		expect(action).toContain(SERVER_MESSAGES.emailInUse);
		expect(action).toContain(SERVER_MESSAGES.documentInUse);
	});
});
