import { WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, createFixedWindowRateLimiter, createWebhookAnomalyTracker } from "./monitor-state-runtime-api.js";
//#region src/monitor.state.ts
const wsClients = /* @__PURE__ */ new Map();
const httpServers = /* @__PURE__ */ new Map();
const botOpenIds = /* @__PURE__ */ new Map();
const botNames = /* @__PURE__ */ new Map();
const botIdentityRevisions = /* @__PURE__ */ new Map();
const FEISHU_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 5e3;
const FEISHU_HTTP_SERVER_CLOSE_TIMEOUT_MS = 5e3;
const FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS = {
	windowMs: 6e4,
	maxRequests: 120,
	maxTrackedKeys: 4096
};
const FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS = {
	maxTrackedKeys: 4096,
	ttlMs: 360 * 6e4,
	logEvery: 25
};
function coercePositiveInt(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : fallback;
}
function resolveFeishuWebhookRateLimitDefaultsForTest(defaults) {
	const resolved = defaults;
	return {
		windowMs: coercePositiveInt(resolved?.windowMs, FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.windowMs),
		maxRequests: coercePositiveInt(resolved?.maxRequests, FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.maxRequests),
		maxTrackedKeys: coercePositiveInt(resolved?.maxTrackedKeys, FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.maxTrackedKeys)
	};
}
function resolveFeishuWebhookAnomalyDefaultsForTest(defaults) {
	const resolved = defaults;
	return {
		maxTrackedKeys: coercePositiveInt(resolved?.maxTrackedKeys, FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.maxTrackedKeys),
		ttlMs: coercePositiveInt(resolved?.ttlMs, FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.ttlMs),
		logEvery: coercePositiveInt(resolved?.logEvery, FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.logEvery)
	};
}
const feishuWebhookRateLimitDefaults = resolveFeishuWebhookRateLimitDefaultsForTest(WEBHOOK_RATE_LIMIT_DEFAULTS);
const feishuWebhookAnomalyDefaults = resolveFeishuWebhookAnomalyDefaultsForTest(WEBHOOK_ANOMALY_COUNTER_DEFAULTS);
const feishuWebhookRateLimiter = createFixedWindowRateLimiter({
	windowMs: feishuWebhookRateLimitDefaults.windowMs,
	maxRequests: feishuWebhookRateLimitDefaults.maxRequests,
	maxTrackedKeys: feishuWebhookRateLimitDefaults.maxTrackedKeys
});
const feishuWebhookAnomalyTracker = createWebhookAnomalyTracker({
	maxTrackedKeys: feishuWebhookAnomalyDefaults.maxTrackedKeys,
	ttlMs: feishuWebhookAnomalyDefaults.ttlMs,
	logEvery: feishuWebhookAnomalyDefaults.logEvery
});
function closeWsClient(client) {
	if (!client) return;
	try {
		client.close();
	} catch {}
}
function readBotIdentityRevision(accountId) {
	return botIdentityRevisions.get(accountId) ?? 0;
}
function bumpBotIdentityRevision(accountId) {
	botIdentityRevisions.set(accountId, readBotIdentityRevision(accountId) + 1);
}
function captureBotIdentitySnapshot(accountId) {
	return { revision: readBotIdentityRevision(accountId) };
}
function captureBotIdentitySnapshots() {
	const accountIds = /* @__PURE__ */ new Set([...botOpenIds.keys(), ...botNames.keys()]);
	return Array.from(accountIds, (accountId) => [accountId, captureBotIdentitySnapshot(accountId)]);
}
function clearFeishuBotIdentityStateIfUnchanged(accountId, snapshot) {
	if (readBotIdentityRevision(accountId) !== snapshot.revision) return;
	botOpenIds.delete(accountId);
	botNames.delete(accountId);
	bumpBotIdentityRevision(accountId);
}
function setFeishuBotIdentityState(accountId, identity) {
	botOpenIds.set(accountId, identity.botOpenId);
	if (identity.botName) botNames.set(accountId, identity.botName);
	else botNames.delete(accountId);
	bumpBotIdentityRevision(accountId);
}
function clearFeishuBotIdentityState(accountId) {
	botOpenIds.delete(accountId);
	botNames.delete(accountId);
	bumpBotIdentityRevision(accountId);
}
function isServerNotRunningError(error) {
	return error.code === "ERR_SERVER_NOT_RUNNING";
}
async function closeFeishuHttpServer(server) {
	await new Promise((resolve, reject) => {
		let settled = false;
		const settle = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(fallbackTimer);
			if (!err || isServerNotRunningError(err)) {
				resolve();
				return;
			}
			reject(err);
		};
		const fallbackTimer = setTimeout(() => {
			try {
				server.closeAllConnections();
				settle();
			} catch (err) {
				settle(err instanceof Error ? err : new Error(String(err)));
			}
		}, FEISHU_HTTP_SERVER_CLOSE_TIMEOUT_MS);
		try {
			server.close((err) => {
				settle(err);
			});
		} catch (err) {
			settle(err instanceof Error ? err : new Error(String(err)));
		}
	});
}
async function closeTrackedFeishuHttpServer(accountId, server) {
	const identitySnapshot = captureBotIdentitySnapshot(accountId);
	try {
		await closeFeishuHttpServer(server);
	} finally {
		if (httpServers.get(accountId) === server) {
			httpServers.delete(accountId);
			clearFeishuBotIdentityStateIfUnchanged(accountId, identitySnapshot);
		}
	}
}
async function closeTrackedHttpServers(entries) {
	const rejected = (await Promise.allSettled(entries.map(([accountId, server]) => closeTrackedFeishuHttpServer(accountId, server)))).find((result) => result.status === "rejected");
	if (rejected) throw rejected.reason;
}
function clearFeishuWebhookRateLimitStateForTest() {
	feishuWebhookRateLimiter.clear();
	feishuWebhookAnomalyTracker.clear();
}
function getFeishuWebhookRateLimitStateSizeForTest() {
	return feishuWebhookRateLimiter.size();
}
function isWebhookRateLimitedForTest(key, nowMs) {
	return feishuWebhookRateLimiter.isRateLimited(key, nowMs);
}
function recordWebhookStatus(runtime, accountId, path, statusCode) {
	feishuWebhookAnomalyTracker.record({
		key: `${accountId}:${path}:${statusCode}`,
		statusCode,
		log: runtime?.log ?? console.log,
		message: (count) => `feishu[${accountId}]: webhook anomaly path=${path} status=${statusCode} count=${count}`
	});
}
async function stopFeishuMonitorState(accountId) {
	if (accountId) {
		closeWsClient(wsClients.get(accountId));
		wsClients.delete(accountId);
		const server = httpServers.get(accountId);
		if (server) {
			await closeTrackedFeishuHttpServer(accountId, server);
			return;
		}
		clearFeishuBotIdentityState(accountId);
		return;
	}
	for (const client of wsClients.values()) closeWsClient(client);
	wsClients.clear();
	const identitySnapshots = captureBotIdentitySnapshots();
	try {
		await closeTrackedHttpServers([...httpServers.entries()]);
	} finally {
		for (const [identityAccountId, snapshot] of identitySnapshots) if (!httpServers.has(identityAccountId)) clearFeishuBotIdentityStateIfUnchanged(identityAccountId, snapshot);
	}
}
//#endregion
export { FEISHU_HTTP_SERVER_CLOSE_TIMEOUT_MS, FEISHU_WEBHOOK_BODY_TIMEOUT_MS, FEISHU_WEBHOOK_MAX_BODY_BYTES, botNames, botOpenIds, clearFeishuBotIdentityState, clearFeishuWebhookRateLimitStateForTest, closeFeishuHttpServer, closeTrackedFeishuHttpServer, feishuWebhookRateLimiter, getFeishuWebhookRateLimitStateSizeForTest, httpServers, isWebhookRateLimitedForTest, recordWebhookStatus, resolveFeishuWebhookAnomalyDefaultsForTest, resolveFeishuWebhookRateLimitDefaultsForTest, setFeishuBotIdentityState, stopFeishuMonitorState, wsClients };
