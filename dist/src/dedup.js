import { getFeishuRuntime } from "./runtime.js";
import { releaseFeishuMessageProcessing, tryBeginFeishuMessageProcessing } from "./processing-claims.js";
import { createHash } from "node:crypto";
//#region src/dedup.ts
const DEDUP_TTL_MS = 1440 * 60 * 1e3;
const MEMORY_MAX_SIZE = 1e3;
const STORE_MAX_ENTRIES = 1e4;
const memory = /* @__PURE__ */ new Map();
const cachedDedupStores = /* @__PURE__ */ new Map();
function normalizeMessageId(messageId) {
	const trimmed = messageId?.trim();
	return trimmed ? trimmed : null;
}
function normalizeNamespace(namespace) {
	return namespace?.trim() || "global";
}
function pluginStateNamespace(namespace) {
	return `dedup.${namespace.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
function openDedupStore(namespace) {
	const stateNamespace = pluginStateNamespace(namespace);
	const cached = cachedDedupStores.get(stateNamespace);
	if (cached) return cached;
	const store = getFeishuRuntime().state.openSyncKeyedStore({
		namespace: stateNamespace,
		maxEntries: STORE_MAX_ENTRIES,
		defaultTtlMs: DEDUP_TTL_MS
	});
	cachedDedupStores.set(stateNamespace, store);
	return store;
}
function dedupeStoreKey(namespace, messageId) {
	return createHash("sha256").update(`${namespace}\0${messageId}`, "utf8").digest("hex").slice(0, 32);
}
function memoryKey(namespace, messageId) {
	return `${namespace}\0${messageId}`;
}
function isRecent(seenAt, now = Date.now()) {
	return typeof seenAt === "number" && Number.isFinite(seenAt) && now - seenAt < DEDUP_TTL_MS;
}
function pruneMemory(now = Date.now()) {
	for (const [key, seenAt] of memory) if (!isRecent(seenAt, now)) memory.delete(key);
	if (memory.size <= MEMORY_MAX_SIZE) return;
	const toRemove = Array.from(memory.entries()).toSorted(([, left], [, right]) => left - right).slice(0, memory.size - MEMORY_MAX_SIZE);
	for (const [key] of toRemove) memory.delete(key);
}
function remember(namespace, messageId, seenAt = Date.now()) {
	memory.set(memoryKey(namespace, messageId), seenAt);
	pruneMemory(seenAt);
}
function hasMemory(namespace, messageId, now = Date.now()) {
	const key = memoryKey(namespace, messageId);
	if (isRecent(memory.get(key), now)) return true;
	memory.delete(key);
	return false;
}
async function claimUnprocessedFeishuMessage(params) {
	const { messageId, namespace = "global", log } = params;
	const normalizedMessageId = normalizeMessageId(messageId);
	if (!normalizedMessageId) return "invalid";
	if (await hasProcessedFeishuMessage(normalizedMessageId, namespace, log)) return "duplicate";
	if (!tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) return "inflight";
	return "claimed";
}
async function finalizeFeishuMessageProcessing(params) {
	const { messageId, namespace = "global", log, claimHeld = false } = params;
	const normalizedMessageId = normalizeMessageId(messageId);
	if (!normalizedMessageId) return false;
	if (!claimHeld && !tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) return false;
	if (!await tryRecordMessagePersistent(normalizedMessageId, namespace, log)) {
		releaseFeishuMessageProcessing(normalizedMessageId, namespace);
		return false;
	}
	return true;
}
async function recordProcessedFeishuMessage(messageId, namespace = "global", log) {
	const normalizedMessageId = normalizeMessageId(messageId);
	if (!normalizedMessageId) return false;
	return await tryRecordMessagePersistent(normalizedMessageId, namespace, log);
}
async function forgetProcessedFeishuMessage(messageId, namespace = "global", log) {
	const normalizedNamespace = normalizeNamespace(namespace);
	const normalizedMessageId = normalizeMessageId(messageId);
	if (!normalizedMessageId) return false;
	memory.delete(memoryKey(normalizedNamespace, normalizedMessageId));
	const key = dedupeStoreKey(normalizedNamespace, normalizedMessageId);
	try {
		return openDedupStore(normalizedNamespace).delete(key);
	} catch (error) {
		log?.(`feishu-dedup: persistent delete failed: ${String(error)}`);
		return false;
	}
}
async function hasProcessedFeishuMessage(messageId, namespace = "global", log) {
	const normalizedMessageId = normalizeMessageId(messageId);
	if (!normalizedMessageId) return false;
	return hasRecordedMessagePersistent(normalizedMessageId, namespace, log);
}
async function tryRecordMessagePersistent(messageId, namespace = "global", log) {
	const normalizedNamespace = normalizeNamespace(namespace);
	const normalizedMessageId = normalizeMessageId(messageId);
	if (!normalizedMessageId) return true;
	const now = Date.now();
	if (hasMemory(normalizedNamespace, normalizedMessageId, now)) return false;
	const key = dedupeStoreKey(normalizedNamespace, normalizedMessageId);
	try {
		const store = openDedupStore(normalizedNamespace);
		const existingSeenAt = store.lookup(key)?.seenAt;
		if (isRecent(existingSeenAt, now)) {
			remember(normalizedNamespace, normalizedMessageId, existingSeenAt);
			return false;
		}
		if (!store.registerIfAbsent(key, {
			namespace: normalizedNamespace,
			messageId: normalizedMessageId,
			seenAt: now
		}, { ttlMs: DEDUP_TTL_MS })) {
			const currentSeenAt = store.lookup(key)?.seenAt;
			if (isRecent(currentSeenAt, now)) {
				remember(normalizedNamespace, normalizedMessageId, currentSeenAt);
				return false;
			}
			store.register(key, {
				namespace: normalizedNamespace,
				messageId: normalizedMessageId,
				seenAt: now
			}, { ttlMs: DEDUP_TTL_MS });
		}
		remember(normalizedNamespace, normalizedMessageId, now);
		return true;
	} catch (error) {
		log?.(`feishu-dedup: persistent state error, falling back to memory: ${String(error)}`);
		remember(normalizedNamespace, normalizedMessageId, now);
		return true;
	}
}
async function hasRecordedMessagePersistent(messageId, namespace = "global", log) {
	const normalizedNamespace = normalizeNamespace(namespace);
	const normalizedMessageId = normalizeMessageId(messageId);
	if (!normalizedMessageId) return false;
	const now = Date.now();
	if (hasMemory(normalizedNamespace, normalizedMessageId, now)) return true;
	try {
		const existingSeenAt = openDedupStore(normalizedNamespace).lookup(dedupeStoreKey(normalizedNamespace, normalizedMessageId))?.seenAt;
		if (!isRecent(existingSeenAt, now)) return false;
		remember(normalizedNamespace, normalizedMessageId, existingSeenAt);
		return true;
	} catch (error) {
		log?.(`feishu-dedup: persistent peek failed: ${String(error)}`);
		return hasMemory(normalizedNamespace, normalizedMessageId, now);
	}
}
async function warmupDedupFromPluginState(namespace, log) {
	const normalizedNamespace = normalizeNamespace(namespace);
	try {
		let loaded = 0;
		const now = Date.now();
		for (const entry of openDedupStore(normalizedNamespace).entries()) {
			if (entry.value.namespace !== normalizedNamespace || !isRecent(entry.value.seenAt, now)) continue;
			remember(normalizedNamespace, entry.value.messageId, entry.value.seenAt);
			loaded++;
		}
		return loaded;
	} catch (error) {
		log?.(`feishu-dedup: warmup persistent state error: ${String(error)}`);
		return 0;
	}
}
const testingHooks = {
	resetFeishuDedupForTests() {
		memory.clear();
		for (const store of cachedDedupStores.values()) store.clear();
		cachedDedupStores.clear();
	},
	resetFeishuDedupMemoryForTests() {
		memory.clear();
	}
};
//#endregion
export { claimUnprocessedFeishuMessage, finalizeFeishuMessageProcessing, forgetProcessedFeishuMessage, hasProcessedFeishuMessage, recordProcessedFeishuMessage, releaseFeishuMessageProcessing, testingHooks, tryBeginFeishuMessageProcessing, tryRecordMessagePersistent, warmupDedupFromPluginState };
