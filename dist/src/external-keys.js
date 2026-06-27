//#region src/external-keys.ts
const CONTROL_CHARS_RE = /\p{Cc}/u;
const MAX_EXTERNAL_KEY_LENGTH = 512;
function normalizeFeishuExternalKey(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_EXTERNAL_KEY_LENGTH) return;
	if (CONTROL_CHARS_RE.test(normalized)) return;
	if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) return;
	return normalized;
}
//#endregion
export { normalizeFeishuExternalKey };
