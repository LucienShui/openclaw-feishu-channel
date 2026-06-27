import { listFeishuAccountIds, resolveFeishuAccount, resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/tool-account.ts
function resolveImplicitToolAccountId(params) {
	const explicitAccountId = normalizeOptionalString(params.executeParams?.accountId);
	if (explicitAccountId) return explicitAccountId;
	const contextualAccountId = normalizeOptionalString(params.defaultAccountId);
	if (contextualAccountId && listFeishuAccountIds(params.api.config).includes(contextualAccountId)) {
		if (resolveFeishuAccount({
			cfg: params.api.config,
			accountId: contextualAccountId
		}).enabled) return contextualAccountId;
	}
	const configuredDefaultAccountId = normalizeOptionalString((params.api.config?.channels?.feishu)?.defaultAccount);
	if (configuredDefaultAccountId) return configuredDefaultAccountId;
	if (params.requiredTool && params.api.config) for (const accountId of listFeishuAccountIds(params.api.config)) {
		const account = resolveFeishuAccount({
			cfg: params.api.config,
			accountId
		});
		if (account.enabled && account.configured && resolveToolsConfig(account.config.tools)[params.requiredTool.family]) return accountId;
	}
}
function resolveFeishuToolAccount(params) {
	if (!params.api.config) throw new Error("Feishu config unavailable");
	const account = resolveFeishuRuntimeAccount({
		cfg: params.api.config,
		accountId: resolveImplicitToolAccountId(params)
	});
	if (params.requiredTool && !resolveToolsConfig(account.config.tools)[params.requiredTool.family]) throw new Error(`Feishu ${params.requiredTool.label} tools are disabled for account "${account.accountId}"`);
	return account;
}
function createFeishuToolClient(params) {
	return createFeishuClient(resolveFeishuToolAccount(params));
}
function resolveAnyEnabledFeishuToolsConfig(accounts) {
	const merged = {
		doc: false,
		chat: false,
		wiki: false,
		drive: false,
		perm: false,
		scopes: false,
		bitable: false,
		base: false
	};
	for (const account of accounts) {
		const cfg = resolveToolsConfig(account.config.tools);
		merged.doc = merged.doc || cfg.doc;
		merged.chat = merged.chat || cfg.chat;
		merged.wiki = merged.wiki || cfg.wiki;
		merged.drive = merged.drive || cfg.drive;
		merged.perm = merged.perm || cfg.perm;
		merged.scopes = merged.scopes || cfg.scopes;
		merged.bitable = merged.bitable || cfg.bitable;
		merged.base = merged.base || cfg.base;
	}
	return merged;
}
//#endregion
export { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount };
