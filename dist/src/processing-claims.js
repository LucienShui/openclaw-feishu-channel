//#region src/processing-claims.ts
const EVENT_DEDUP_TTL_MS = 300 * 1e3;
const EVENT_MEMORY_MAX_SIZE = 2e3;
const processingClaims = /* @__PURE__ */ new Map();
function resolveEventDedupeKey(namespace, messageId) {
	const trimmed = messageId?.trim();
	return trimmed ? `${namespace}:${trimmed}` : null;
}
function pruneProcessingClaims(now) {
	const cutoff = now - EVENT_DEDUP_TTL_MS;
	for (const [key, seenAt] of processingClaims) if (seenAt < cutoff) processingClaims.delete(key);
	while (processingClaims.size > EVENT_MEMORY_MAX_SIZE) {
		const oldestKey = processingClaims.keys().next().value;
		if (!oldestKey) return;
		processingClaims.delete(oldestKey);
	}
}
function tryBeginFeishuMessageProcessing(messageId, namespace = "global") {
	const key = resolveEventDedupeKey(namespace, messageId);
	if (!key) return true;
	const now = Date.now();
	pruneProcessingClaims(now);
	if (processingClaims.has(key)) {
		processingClaims.delete(key);
		processingClaims.set(key, now);
		pruneProcessingClaims(now);
		return false;
	}
	processingClaims.set(key, now);
	pruneProcessingClaims(now);
	return true;
}
function releaseFeishuMessageProcessing(messageId, namespace = "global") {
	const key = resolveEventDedupeKey(namespace, messageId);
	if (key) processingClaims.delete(key);
}
const testingHooks = { resetFeishuMessageProcessingClaimsForTests() {
	processingClaims.clear();
} };
//#endregion
export { releaseFeishuMessageProcessing, testingHooks, tryBeginFeishuMessageProcessing };
