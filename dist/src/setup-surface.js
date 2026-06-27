import { resolveDefaultFeishuAccountId, resolveFeishuAccount } from "./accounts.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_ACCOUNT_ID, createSetupTranslator, formatDocsLink, hasConfiguredSecretInput, mergeAllowFromEntries, patchTopLevelChannelConfigSection, promptSingleChannelSecretInput, splitSetupEntries } from "openclaw/plugin-sdk/setup";
//#region src/setup-surface.ts
const t = createSetupTranslator();
const channel = "feishu";
const SCAN_TO_CREATE_TP = "ob_cli_app";
const FEISHU_SETUP_FLOW_KEY = "_flow";
function isFeishuConfigured(cfg) {
	const feishuCfg = cfg.channels?.feishu;
	const isAppIdConfigured = (value) => {
		if (normalizeOptionalString(value)) return true;
		if (!value || typeof value !== "object") return false;
		const rec = value;
		const source = normalizeOptionalString(rec.source)?.toLowerCase();
		const id = normalizeOptionalString(rec.id);
		if (source === "env" && id) return Boolean(normalizeOptionalString(process.env[id]));
		return hasConfiguredSecretInput(value);
	};
	const topLevelConfigured = isAppIdConfigured(feishuCfg?.appId) && hasConfiguredSecretInput(feishuCfg?.appSecret);
	const accountConfigured = Object.values(feishuCfg?.accounts ?? {}).some((account) => {
		if (!account || typeof account !== "object") return false;
		const hasOwnAppId = Object.hasOwn(account, "appId");
		const hasOwnAppSecret = Object.hasOwn(account, "appSecret");
		const accountAppIdConfigured = hasOwnAppId ? isAppIdConfigured(account.appId) : isAppIdConfigured(feishuCfg?.appId);
		const accountSecretConfigured = hasOwnAppSecret ? hasConfiguredSecretInput(account.appSecret) : hasConfiguredSecretInput(feishuCfg?.appSecret);
		return accountAppIdConfigured && accountSecretConfigured;
	});
	return topLevelConfigured || accountConfigured;
}
function formatFeishuStatusLine(status) {
	if (status === "needs-credentials") return `Feishu: ${t("wizard.channels.statusNeedsAppCredentials")}`;
	return `Feishu: ${t("wizard.channels.statusConfiguredConnectionNotVerified")}`;
}
/**
* Patch feishu config at the correct location based on accountId.
* - DEFAULT_ACCOUNT_ID → writes to top-level channels.feishu
* - named account → writes to channels.feishu.accounts[accountId]
*/
function patchFeishuConfig(cfg, accountId, patch) {
	const feishuCfg = cfg.channels?.feishu;
	if (accountId === DEFAULT_ACCOUNT_ID) return patchTopLevelChannelConfigSection({
		cfg,
		channel,
		enabled: true,
		patch
	});
	const nextAccountPatch = {
		...feishuCfg?.accounts?.[accountId],
		enabled: true,
		...patch
	};
	return patchTopLevelChannelConfigSection({
		cfg,
		channel,
		enabled: true,
		patch: { accounts: {
			...feishuCfg?.accounts,
			[accountId]: nextAccountPatch
		} }
	});
}
async function promptFeishuAllowFrom(params) {
	const feishuCfg = params.cfg.channels?.feishu;
	const resolvedAccountId = params.accountId ?? resolveDefaultFeishuAccountId(params.cfg);
	const existingAllowFrom = (resolvedAccountId !== DEFAULT_ACCOUNT_ID ? feishuCfg?.accounts?.[resolvedAccountId] : void 0)?.allowFrom ?? feishuCfg?.allowFrom ?? [];
	await params.prompter.note([
		t("wizard.feishu.allowlistIntro"),
		t("wizard.feishu.allowlistFindUser"),
		t("wizard.feishu.examples"),
		"- ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		"- on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
	].join("\n"), t("wizard.feishu.allowlistTitle"));
	const mergedAllowFrom = mergeAllowFromEntries(existingAllowFrom, splitSetupEntries(await params.prompter.text({
		message: t("wizard.feishu.allowFromPrompt"),
		placeholder: "ou_xxxxx, ou_yyyyy",
		initialValue: existingAllowFrom.length > 0 ? existingAllowFrom.map(String).join(", ") : void 0
	})));
	return patchFeishuConfig(params.cfg, resolvedAccountId, { allowFrom: mergedAllowFrom });
}
async function noteFeishuCredentialHelp(prompter) {
	await prompter.note([
		t("wizard.feishu.credentialsStepOpenPlatform"),
		t("wizard.feishu.credentialsStepCreateApp"),
		t("wizard.feishu.credentialsStepGetCredentials"),
		t("wizard.feishu.credentialsStepPermissions"),
		t("wizard.feishu.credentialsStepPublish"),
		t("wizard.feishu.credentialsEnvTip"),
		t("wizard.channels.docs", { link: formatDocsLink("/channels/feishu", "feishu") })
	].join("\n"), t("wizard.feishu.credentialsTitle"));
}
async function promptFeishuAppId(params) {
	return (await params.prompter.text({
		message: t("wizard.feishu.appIdPrompt"),
		initialValue: params.initialValue,
		validate: (value) => value?.trim() ? void 0 : t("common.required")
	})).trim();
}
const feishuDmPolicy = {
	label: "Feishu",
	channel,
	policyKey: "channels.feishu.dmPolicy",
	allowFromKey: "channels.feishu.allowFrom",
	resolveConfigKeys: (_cfg, accountId) => {
		const resolvedAccountId = accountId ?? resolveDefaultFeishuAccountId(_cfg);
		return resolvedAccountId !== DEFAULT_ACCOUNT_ID ? {
			policyKey: `channels.feishu.accounts.${resolvedAccountId}.dmPolicy`,
			allowFromKey: `channels.feishu.accounts.${resolvedAccountId}.allowFrom`
		} : {
			policyKey: "channels.feishu.dmPolicy",
			allowFromKey: "channels.feishu.allowFrom"
		};
	},
	getCurrent: (cfg, accountId) => {
		const feishuCfg = cfg.channels?.feishu;
		const resolvedAccountId = accountId ?? resolveDefaultFeishuAccountId(cfg);
		if (resolvedAccountId !== DEFAULT_ACCOUNT_ID) {
			const account = feishuCfg?.accounts?.[resolvedAccountId];
			if (account?.dmPolicy) return account.dmPolicy;
		}
		return feishuCfg?.dmPolicy ?? "pairing";
	},
	setPolicy: (cfg, policy, accountId) => {
		return patchFeishuConfig(cfg, accountId ?? resolveDefaultFeishuAccountId(cfg), {
			dmPolicy: policy,
			...policy === "open" ? { allowFrom: mergeAllowFromEntries([], ["*"]) } : {}
		});
	},
	promptAllowFrom: promptFeishuAllowFrom
};
function applyNewAppSecurityPolicy(cfg, accountId, openId, groupPolicy) {
	let next = cfg;
	if (openId) next = patchFeishuConfig(next, accountId, {
		dmPolicy: "allowlist",
		allowFrom: [openId]
	});
	const groupPatch = { groupPolicy };
	if (groupPolicy === "open") groupPatch.requireMention = true;
	next = patchFeishuConfig(next, accountId, groupPatch);
	return next;
}
let appRegistrationModulePromise = null;
const loadAppRegistrationModule = async () => {
	appRegistrationModulePromise ??= import("./app-registration.js");
	return await appRegistrationModulePromise;
};
async function promptFeishuDomain(params) {
	return await params.prompter.select({
		message: t("wizard.feishu.domainPrompt"),
		options: [{
			value: "feishu",
			label: t("wizard.feishu.domainFeishu")
		}, {
			value: "lark",
			label: t("wizard.feishu.domainLark")
		}],
		initialValue: params.initialValue ?? "feishu"
	});
}
async function promptFeishuSetupMethod(prompter) {
	return await prompter.select({
		message: t("wizard.feishu.setupMethodPrompt"),
		options: [{
			value: "manual",
			label: t("wizard.feishu.setupMethodManual")
		}, {
			value: "scan",
			label: t("wizard.feishu.setupMethodScan")
		}],
		initialValue: "manual"
	});
}
async function runScanToCreate(prompter, domain) {
	const { beginAppRegistration, initAppRegistration, pollAppRegistration, printQrCode } = await loadAppRegistrationModule();
	try {
		await initAppRegistration(domain);
	} catch {
		await prompter.note(t("wizard.feishu.scanUnavailable"), t("wizard.feishu.setupTitle"));
		return null;
	}
	const begin = await beginAppRegistration(domain);
	await prompter.note(t("wizard.feishu.scanQr"), t("wizard.feishu.scanTitle"));
	await printQrCode(begin.qrUrl);
	const progress = prompter.progress(t("wizard.feishu.fetchingConfig"));
	const outcome = await pollAppRegistration({
		deviceCode: begin.deviceCode,
		interval: begin.interval,
		expireIn: begin.expireIn,
		initialDomain: domain,
		tp: SCAN_TO_CREATE_TP
	});
	switch (outcome.status) {
		case "success":
			progress.stop(t("wizard.feishu.scanCompleted"));
			return outcome.result;
		case "access_denied":
			progress.stop(t("wizard.feishu.scanDenied"));
			return null;
		case "expired":
			progress.stop(t("wizard.feishu.scanExpired"));
			return null;
		case "timeout":
			progress.stop(t("wizard.feishu.scanTimedOut"));
			return null;
		case "error":
			progress.stop(t("wizard.feishu.scanError", { error: outcome.message }));
			return null;
	}
	return null;
}
async function runNewAppFlow(params) {
	const { prompter, options } = params;
	let next = params.cfg;
	const targetAccountId = resolveDefaultFeishuAccountId(next);
	let appId;
	let appSecret = null;
	let appSecretProbeValue = null;
	let scanDomain;
	let scanOpenId;
	const currentDomain = (next.channels?.feishu)?.domain ?? "feishu";
	const setupMethod = await promptFeishuSetupMethod(prompter);
	const selectedDomain = await promptFeishuDomain({
		prompter,
		initialValue: currentDomain
	});
	scanDomain = selectedDomain;
	const scanResult = setupMethod === "scan" ? await runScanToCreate(prompter, selectedDomain) : null;
	if (scanResult) {
		appId = scanResult.appId;
		appSecret = scanResult.appSecret;
		scanDomain = scanResult.domain;
		scanOpenId = scanResult.openId;
	} else {
		await noteFeishuCredentialHelp(prompter);
		appId = await promptFeishuAppId({
			prompter,
			initialValue: normalizeOptionalString(process.env.FEISHU_APP_ID)
		});
		const appSecretResult = await promptSingleChannelSecretInput({
			cfg: next,
			prompter,
			providerHint: "feishu",
			credentialLabel: "App Secret",
			secretInputMode: options?.secretInputMode,
			accountConfigured: false,
			canUseEnv: false,
			hasConfigToken: false,
			envPrompt: "",
			keepPrompt: t("wizard.feishu.appSecretKeep"),
			inputPrompt: t("wizard.feishu.appSecretPrompt"),
			preferredEnvVar: "FEISHU_APP_SECRET"
		});
		if (appSecretResult.action === "set") {
			appSecret = appSecretResult.value;
			appSecretProbeValue = appSecretResult.resolvedValue;
		}
		if (appId && appSecretProbeValue) {
			const { getAppOwnerOpenId } = await loadAppRegistrationModule();
			scanOpenId = await getAppOwnerOpenId({
				appId,
				appSecret: appSecretProbeValue,
				domain: selectedDomain
			});
		}
	}
	const groupPolicy = await prompter.select({
		message: t("wizard.feishu.groupPolicyPrompt"),
		options: [
			{
				value: "allowlist",
				label: t("wizard.feishu.groupPolicyAllowlist")
			},
			{
				value: "open",
				label: t("wizard.feishu.groupPolicyOpen")
			},
			{
				value: "disabled",
				label: t("wizard.feishu.groupPolicyDisabled")
			}
		],
		initialValue: "allowlist"
	});
	const configProgress = prompter.progress(t("wizard.feishu.configuring"));
	await new Promise((resolve) => {
		setTimeout(resolve, 50);
	});
	if (appId && appSecret) next = patchFeishuConfig(next, targetAccountId, {
		appId,
		appSecret,
		connectionMode: "websocket",
		...scanDomain ? { domain: scanDomain } : {}
	});
	else if (scanDomain) next = patchFeishuConfig(next, targetAccountId, { domain: scanDomain });
	next = applyNewAppSecurityPolicy(next, targetAccountId, scanOpenId, groupPolicy);
	configProgress.stop(t("wizard.feishu.botConfigured"));
	return { cfg: next };
}
async function runEditFlow(params) {
	const { prompter, options } = params;
	const next = params.cfg;
	const feishuCfg = next.channels?.feishu;
	const resolveAppIdLabel = (value) => {
		const asString = normalizeOptionalString(value);
		if (asString) return asString;
		if (value && typeof value === "object") {
			const rec = value;
			if (normalizeOptionalString(rec.source) && normalizeOptionalString(rec.id)) return normalizeOptionalString(process.env[rec.id]) ?? `env:${String(rec.id)}`;
			if (hasConfiguredSecretInput(value)) return "(configured)";
		}
	};
	const existingAppId = resolveAppIdLabel(feishuCfg?.appId) ?? Object.values(feishuCfg?.accounts ?? {}).reduce((found, account) => {
		if (found) return found;
		if (account && typeof account === "object") return resolveAppIdLabel(account.appId);
	}, void 0);
	if (existingAppId) {
		if (!await prompter.confirm({
			message: t("wizard.feishu.existingBotPrompt", { appId: existingAppId }),
			initialValue: true
		})) return runNewAppFlow({
			cfg: next,
			prompter,
			options
		});
	} else return runNewAppFlow({
		cfg: next,
		prompter,
		options
	});
	await prompter.note(t("wizard.feishu.botConfigured"), "");
	return { cfg: next };
}
async function runFeishuLogin(params) {
	const { cfg, prompter } = params;
	const options = {};
	if (isFeishuConfigured(cfg)) {
		const result = await runEditFlow({
			cfg,
			prompter,
			options
		});
		if (result === null) return cfg;
		return result.cfg;
	}
	return (await runNewAppFlow({
		cfg,
		prompter,
		options
	})).cfg;
}
const feishuSetupWizard = {
	channel,
	resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId, cfg }) => (typeof accountOverride === "string" && accountOverride.trim() ? accountOverride.trim() : void 0) ?? resolveDefaultFeishuAccountId(cfg) ?? defaultAccountId,
	resolveShouldPromptAccountIds: () => false,
	status: {
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsAppCredentials"),
		configuredHint: t("wizard.channels.statusConfigured"),
		unconfiguredHint: t("wizard.channels.statusNeedsAppCreds"),
		configuredScore: 2,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => isFeishuConfigured(cfg),
		resolveStatusLines: async ({ cfg, accountId, configured }) => {
			const account = resolveFeishuAccount({
				cfg,
				accountId
			});
			let probeResult = null;
			if (configured && account.configured) try {
				const { probeFeishu } = await import("./probe.js");
				probeResult = await probeFeishu(account);
			} catch {}
			if (!configured) return [formatFeishuStatusLine("needs-credentials")];
			if (probeResult?.ok) return [`Feishu: ${t("wizard.channels.statusConnectedAs", { name: probeResult.botName ?? probeResult.botOpenId ?? "bot" })}`];
			return [formatFeishuStatusLine("configured-unverified")];
		}
	},
	prepare: async ({ cfg, credentialValues }) => {
		if (isFeishuConfigured(cfg)) return { credentialValues: {
			...credentialValues,
			[FEISHU_SETUP_FLOW_KEY]: "edit"
		} };
		return { credentialValues: {
			...credentialValues,
			[FEISHU_SETUP_FLOW_KEY]: "new"
		} };
	},
	credentials: [],
	finalize: async ({ cfg, prompter, options, credentialValues }) => {
		if ((credentialValues[FEISHU_SETUP_FLOW_KEY] ?? "new") === "edit") {
			const result = await runEditFlow({
				cfg,
				prompter,
				options
			});
			if (result === null) return { cfg };
			return result;
		}
		return runNewAppFlow({
			cfg,
			prompter,
			options
		});
	},
	dmPolicy: feishuDmPolicy,
	disable: (cfg) => patchTopLevelChannelConfigSection({
		cfg,
		channel,
		patch: { enabled: false }
	})
};
//#endregion
export { feishuSetupWizard, runFeishuLogin };
