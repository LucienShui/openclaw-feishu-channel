import { createFeishuClient } from "./client.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import { asDateTimestampMs, resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
//#region src/probe.ts
/** Cache probe results to reduce repeated health-check calls.
* Gateway health checks call probeFeishu() every minute; without caching this
* burns ~43,200 calls/month, easily exceeding Feishu's free-tier quota.
* Successful bot info is effectively static, while failures are cached briefly
* to avoid hammering the API during transient outages. */
const probeCache = /* @__PURE__ */ new Map();
const PROBE_SUCCESS_TTL_MS = 600 * 1e3;
const PROBE_ERROR_TTL_MS = 60 * 1e3;
const MAX_PROBE_CACHE_SIZE = 64;
const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 1e4;
function setCachedProbeResult(cacheKey, result, ttlMs) {
	const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs);
	if (expiresAt === void 0) {
		probeCache.delete(cacheKey);
		return result;
	}
	probeCache.set(cacheKey, {
		result,
		expiresAt
	});
	if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
		const oldest = probeCache.keys().next().value;
		if (oldest !== void 0) probeCache.delete(oldest);
	}
	return result;
}
async function probeFeishu(creds, options = {}) {
	if (!creds?.appId || !creds?.appSecret) return {
		ok: false,
		error: "missing credentials (appId, appSecret)"
	};
	if (options.abortSignal?.aborted) return {
		ok: false,
		appId: creds.appId,
		error: "probe aborted"
	};
	const timeoutMs = options.timeoutMs ?? 1e4;
	const cacheKey = creds.accountId ?? `${creds.appId}:${creds.appSecret.slice(0, 8)}`;
	const cached = probeCache.get(cacheKey);
	if (cached) {
		const now = asDateTimestampMs(Date.now());
		const expiresAt = asDateTimestampMs(cached.expiresAt);
		if (now !== void 0 && expiresAt !== void 0 && expiresAt > now) return cached.result;
		probeCache.delete(cacheKey);
	}
	try {
		const responseResult = await raceWithTimeoutAndAbort(createFeishuClient(creds).request({
			method: "POST",
			url: "/open-apis/bot/v1/openclaw_bot/ping",
			data: { needBotInfo: true },
			timeout: timeoutMs
		}), {
			timeoutMs,
			abortSignal: options.abortSignal
		});
		if (responseResult.status === "aborted") return {
			ok: false,
			appId: creds.appId,
			error: "probe aborted"
		};
		if (responseResult.status === "timeout") return setCachedProbeResult(cacheKey, {
			ok: false,
			appId: creds.appId,
			error: `probe timed out after ${timeoutMs}ms`
		}, PROBE_ERROR_TTL_MS);
		const response = responseResult.value;
		if (options.abortSignal?.aborted) return {
			ok: false,
			appId: creds.appId,
			error: "probe aborted"
		};
		if (response.code !== 0) return setCachedProbeResult(cacheKey, {
			ok: false,
			appId: creds.appId,
			error: `API error: ${response.msg || `code ${response.code}`}`
		}, PROBE_ERROR_TTL_MS);
		const botInfo = response.data?.pingBotInfo;
		return setCachedProbeResult(cacheKey, {
			ok: true,
			appId: creds.appId,
			botName: botInfo?.botName,
			botOpenId: botInfo?.botID
		}, PROBE_SUCCESS_TTL_MS);
	} catch (err) {
		return setCachedProbeResult(cacheKey, {
			ok: false,
			appId: creds.appId,
			error: formatErrorMessage(err)
		}, PROBE_ERROR_TTL_MS);
	}
}
/** Clear the probe cache (for testing). */
function clearProbeCache() {
	probeCache.clear();
}
//#endregion
export { FEISHU_PROBE_REQUEST_TIMEOUT_MS, clearProbeCache, probeFeishu };
