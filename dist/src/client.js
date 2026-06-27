import { FEISHU_HTTP_TIMEOUT_ENV_VAR, FEISHU_HTTP_TIMEOUT_MAX_MS, FEISHU_HTTP_TIMEOUT_MS, resolveConfiguredHttpTimeoutMs } from "./client-timeout.js";
import { createRequire } from "node:module";
import * as Lark from "@larksuiteoapi/node-sdk";
import { readPluginPackageVersion, resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
//#region src/client.ts
const pluginVersion = readPluginPackageVersion({ require: createRequire(import.meta.url) });
const FEISHU_USER_AGENT = `openclaw-feishu-builtin/${pluginVersion}/${process.platform}`;
const FEISHU_WS_CONFIG = {
	PingInterval: 30,
	PingTimeout: 3
};
/** User-Agent header value for all Feishu API requests. */
function getFeishuUserAgent() {
	return FEISHU_USER_AGENT;
}
const defaultFeishuClientSdk = {
	AppType: Lark.AppType,
	Client: Lark.Client,
	defaultHttpInstance: Lark.defaultHttpInstance,
	Domain: Lark.Domain,
	EventDispatcher: Lark.EventDispatcher,
	LoggerLevel: Lark.LoggerLevel,
	WSClient: Lark.WSClient
};
let feishuClientSdk = defaultFeishuClientSdk;
function setRequestUserAgent(req) {
	const request = req;
	const headers = request.headers;
	if (!headers) {
		request.headers = { "User-Agent": getFeishuUserAgent() };
		return req;
	}
	const maybeAxiosHeaders = headers;
	if (typeof maybeAxiosHeaders.set === "function") {
		maybeAxiosHeaders.set("User-Agent", getFeishuUserAgent());
		return req;
	}
	headers["User-Agent"] = getFeishuUserAgent();
	return req;
}
Lark.defaultHttpInstance.interceptors?.request?.use(setRequestUserAgent);
async function getWsProxyAgent() {
	return resolveAmbientNodeProxyAgent();
}
const clientCache = /* @__PURE__ */ new Map();
function resolveDomain(domain) {
	if (domain === "lark") return feishuClientSdk.Domain.Lark;
	if (domain === "feishu" || !domain) return feishuClientSdk.Domain.Feishu;
	return domain.replace(/\/+$/, "");
}
/**
* Create an HTTP instance that delegates to the Lark SDK's default instance
* but injects a default request timeout and User-Agent header to prevent
* indefinite hangs and set a standardized User-Agent per OAPI best practices.
*/
function createTimeoutHttpInstance(defaultTimeoutMs) {
	const base = feishuClientSdk.defaultHttpInstance;
	function injectTimeout(opts) {
		return {
			timeout: defaultTimeoutMs,
			...opts
		};
	}
	return {
		request: (opts) => base.request(injectTimeout(opts)),
		get: (url, opts) => base.get(url, injectTimeout(opts)),
		post: (url, data, opts) => base.post(url, data, injectTimeout(opts)),
		put: (url, data, opts) => base.put(url, data, injectTimeout(opts)),
		patch: (url, data, opts) => base.patch(url, data, injectTimeout(opts)),
		delete: (url, opts) => base.delete(url, injectTimeout(opts)),
		head: (url, opts) => base.head(url, injectTimeout(opts)),
		options: (url, opts) => base.options(url, injectTimeout(opts))
	};
}
/**
* Create or get a cached Feishu client for an account.
* Accepts any object with appId, appSecret, and optional domain/accountId.
*/
function createFeishuClient(creds) {
	const { accountId = "default", appId, appSecret, domain } = creds;
	const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(creds);
	if (!appId || !appSecret) throw new Error(`Feishu credentials not configured for account "${accountId}"`);
	const cached = clientCache.get(accountId);
	if (cached && cached.config.appId === appId && cached.config.appSecret === appSecret && cached.config.domain === domain && cached.config.httpTimeoutMs === defaultHttpTimeoutMs) return cached.client;
	const client = new feishuClientSdk.Client({
		appId,
		appSecret,
		appType: feishuClientSdk.AppType.SelfBuild,
		domain: resolveDomain(domain),
		httpInstance: createTimeoutHttpInstance(defaultHttpTimeoutMs)
	});
	clientCache.set(accountId, {
		client,
		config: {
			appId,
			appSecret,
			domain,
			httpTimeoutMs: defaultHttpTimeoutMs
		}
	});
	return client;
}
/**
* Create a Feishu WebSocket client for an account.
* Note: WSClient is not cached since each call creates a new connection.
*/
async function createFeishuWSClient(account, callbacks = {}) {
	const { accountId, appId, appSecret, domain } = account;
	if (!appId || !appSecret) throw new Error(`Feishu credentials not configured for account "${accountId}"`);
	const agent = await getWsProxyAgent();
	return new feishuClientSdk.WSClient({
		appId,
		appSecret,
		domain: resolveDomain(domain),
		...callbacks,
		loggerLevel: feishuClientSdk.LoggerLevel.info,
		wsConfig: FEISHU_WS_CONFIG,
		...agent ? { agent } : {}
	});
}
/**
* Create an event dispatcher for an account.
*/
function createEventDispatcher(account) {
	return new feishuClientSdk.EventDispatcher({
		encryptKey: account.encryptKey,
		verificationToken: account.verificationToken
	});
}
/**
* Clear client cache for a specific account or all accounts.
*/
function clearClientCache(accountId) {
	if (accountId) clientCache.delete(accountId);
	else clientCache.clear();
}
function setFeishuClientRuntimeForTest(overrides) {
	feishuClientSdk = overrides?.sdk ? {
		...defaultFeishuClientSdk,
		...overrides.sdk
	} : defaultFeishuClientSdk;
	clearClientCache();
}
//#endregion
export { FEISHU_HTTP_TIMEOUT_ENV_VAR, FEISHU_HTTP_TIMEOUT_MAX_MS, FEISHU_HTTP_TIMEOUT_MS, FEISHU_USER_AGENT, clearClientCache, createEventDispatcher, createFeishuClient, createFeishuWSClient, getFeishuUserAgent, pluginVersion, setFeishuClientRuntimeForTest };
