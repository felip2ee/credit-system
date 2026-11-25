// A short secret (CVV, OTP code, PIN, year, last digits) can show up by chance inside random UUIDs,
// hashes, phone numbers or microsecond timestamps of the same blob, which makes `not.toContain` flaky.
// Up to 6 chars it only counts as a leak when it stands alone, not glued to other id characters.
// Longer values are unique enough: plain substring.
const SHORT_SECRET_MAX = 6;

export function leaks(text: string, value: string): boolean {
	if (value.length > SHORT_SECRET_MAX) return text.includes(value);
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w.+:-])${escaped}(?![\\w.+:-])`).test(text);
}
