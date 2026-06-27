import { normalizeString } from "./comment-shared.js";
import { DEFAULT_ACCOUNT_ID, createAccountListHelpers, hasConfiguredAccountValue, normalizeAccountId, normalizeOptionalAccountId, resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { coerceSecretRef } from "openclaw/plugin-sdk/provider-auth";
//#region src/accounts.ts
const { listAccountIds: listFeishuAccountIds, resolveDefaultAccountId } = createAccountListHelpers("feishu", {
	allowUnlistedDefaultAccount: true,
	hasImplicitDefaultAccount: (cfg) => {
		const feishu = cfg.channels?.feishu;
		return hasConfiguredAccountValue(feishu?.appId) && hasConfiguredAccountValue(feishu?.appSecret);
	}
});
function formatSecretRefLabel(ref) {
	return `${ref.source}:${ref.provider}:${ref.id}`;
}
var FeishuSecretRefUnavailableError = class extends Error {
	path;
	constructor(path, ref) {
		super(`${path}: unresolved SecretRef "${formatSecretRefLabel(ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`);
		this.name = "FeishuSecretRefUnavailableError";
		this.path = path;
	}
};
function resolveFeishuSecretLike(params) {
	const asString = normalizeString(params.value);
	if (asString) return asString;
	const ref = coerceSecretRef(params.value);
	if (!ref) return;
	if (params.mode === "inspect") {
		if (params.allowEnvSecretRefRead && ref.source === "env") {
			const envValue = normalizeString(process.env[ref.id]);
			if (envValue) return envValue;
		}
		return;
	}
	throw new FeishuSecretRefUnavailableError(params.path, ref);
}
function resolveFeishuBaseCredentials(cfg, mode) {
	const appId = resolveFeishuSecretLike({
		value: cfg?.appId,
		path: "channels.feishu.appId",
		mode,
		allowEnvSecretRefRead: true
	});
	const appSecret = resolveFeishuSecretLike({
		value: cfg?.appSecret,
		path: "channels.feishu.appSecret",
		mode,
		allowEnvSecretRefRead: true
	});
	if (!appId || !appSecret) return null;
	return {
		appId,
		appSecret,
		domain: cfg?.domain ?? "feishu"
	};
}
function resolveFeishuEventSecrets(cfg, mode) {
	return {
		encryptKey: (cfg?.connectionMode ?? "websocket") === "webhook" ? resolveFeishuSecretLike({
			value: cfg?.encryptKey,
			path: "channels.feishu.encryptKey",
			mode,
			allowEnvSecretRefRead: true
		}) : normalizeString(cfg?.encryptKey),
		verificationToken: resolveFeishuSecretLike({
			value: cfg?.verificationToken,
			path: "channels.feishu.verificationToken",
			mode,
			allowEnvSecretRefRead: true
		})
	};
}
/**
* Resolve the default account selection and its source.
*/
function resolveDefaultFeishuAccountSelection(cfg) {
	const preferred = normalizeOptionalAccountId((cfg.channels?.feishu)?.defaultAccount);
	if (preferred) return {
		accountId: preferred,
		source: "explicit-default"
	};
	const ids = listFeishuAccountIds(cfg);
	if (ids.includes(DEFAULT_ACCOUNT_ID)) return {
		accountId: DEFAULT_ACCOUNT_ID,
		source: "mapped-default"
	};
	return {
		accountId: ids[0] ?? DEFAULT_ACCOUNT_ID,
		source: "fallback"
	};
}
/**
* Resolve the default account ID.
*/
function resolveDefaultFeishuAccountId(cfg) {
	return resolveDefaultAccountId(cfg);
}
function resolveRawFeishuAccountConfig(accounts, accountId) {
	if (!accounts || typeof accounts !== "object") return;
	if (Object.hasOwn(accounts, accountId)) return accounts[accountId];
	const normalized = accountId.toLowerCase();
	const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized);
	return matchKey ? accounts[matchKey] : void 0;
}
/**
* Merge top-level config with account-specific config.
* Account-specific fields override top-level fields.
*/
function mergeFeishuAccountConfig(cfg, accountId) {
	const feishuCfg = cfg.channels?.feishu;
	const accounts = feishuCfg?.accounts;
	const accountTools = resolveRawFeishuAccountConfig(accounts, accountId)?.tools;
	const merged = resolveMergedAccountConfig({
		channelConfig: feishuCfg,
		accounts,
		accountId,
		omitKeys: ["defaultAccount"],
		nestedObjectKeys: ["tools"]
	});
	const topTools = feishuCfg?.tools;
	if (merged.tools === void 0 && topTools !== void 0) return {
		...merged,
		tools: topTools
	};
	if (topTools?.bitable === false || topTools?.bitable === void 0 && topTools?.base === false) return {
		...merged,
		tools: {
			...merged.tools,
			bitable: false,
			base: false
		}
	};
	if (accountTools?.bitable === void 0 && accountTools?.base !== void 0) return {
		...merged,
		tools: {
			...merged.tools,
			bitable: accountTools.base,
			base: accountTools.base
		}
	};
	return merged;
}
function resolveFeishuCredentials(cfg, options) {
	const mode = options?.mode ?? (options?.allowUnresolvedSecretRef ? "inspect" : "strict");
	const base = resolveFeishuBaseCredentials(cfg, mode);
	if (!base) return null;
	const eventSecrets = resolveFeishuEventSecrets(cfg, mode);
	return {
		...base,
		...eventSecrets
	};
}
function inspectFeishuCredentials(cfg) {
	return resolveFeishuCredentials(cfg, { mode: "inspect" });
}
function buildResolvedFeishuAccount(params) {
	const hasExplicitAccountId = typeof params.accountId === "string" && params.accountId.trim() !== "";
	const defaultSelection = hasExplicitAccountId ? null : resolveDefaultFeishuAccountSelection(params.cfg);
	const accountId = hasExplicitAccountId ? normalizeAccountId(params.accountId) : defaultSelection?.accountId ?? DEFAULT_ACCOUNT_ID;
	const selectionSource = hasExplicitAccountId ? "explicit" : defaultSelection?.source ?? "fallback";
	const baseEnabled = (params.cfg.channels?.feishu)?.enabled !== false;
	const merged = mergeFeishuAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const baseCreds = resolveFeishuBaseCredentials(merged, params.baseMode);
	const eventSecrets = resolveFeishuEventSecrets(merged, params.eventSecretMode);
	const accountName = merged.name;
	return {
		accountId,
		selectionSource,
		enabled,
		configured: Boolean(baseCreds),
		name: typeof accountName === "string" ? accountName.trim() || void 0 : void 0,
		appId: baseCreds?.appId,
		appSecret: baseCreds?.appSecret,
		encryptKey: eventSecrets.encryptKey,
		verificationToken: eventSecrets.verificationToken,
		domain: baseCreds?.domain ?? "feishu",
		config: merged
	};
}
/**
* Resolve a read-only Feishu account snapshot for CLI/config surfaces.
* Unresolved SecretRefs are treated as unavailable instead of throwing.
*/
function resolveFeishuAccount(params) {
	return buildResolvedFeishuAccount({
		...params,
		baseMode: "inspect",
		eventSecretMode: "inspect"
	});
}
/**
* Resolve a runtime Feishu account.
* Required app credentials stay strict; event-only secrets can be required by callers.
*/
function resolveFeishuRuntimeAccount(params, options) {
	return buildResolvedFeishuAccount({
		...params,
		baseMode: "strict",
		eventSecretMode: options?.requireEventSecrets ? "strict" : "inspect"
	});
}
/**
* List all enabled and configured accounts.
*/
function listEnabledFeishuAccounts(cfg) {
	return listFeishuAccountIds(cfg).map((accountId) => resolveFeishuAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled && account.configured);
}
//#endregion
export { FeishuSecretRefUnavailableError, inspectFeishuCredentials, listEnabledFeishuAccounts, listFeishuAccountIds, resolveDefaultFeishuAccountId, resolveDefaultFeishuAccountSelection, resolveFeishuAccount, resolveFeishuCredentials, resolveFeishuRuntimeAccount };
