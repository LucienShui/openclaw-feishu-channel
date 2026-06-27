import { waitForAbortableDelay } from "./async.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import { setFeishuBotIdentityState } from "./monitor.state.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/monitor.bot-identity.ts
const BOT_IDENTITY_RETRY_DELAYS_MS = [
	6e4,
	12e4,
	3e5,
	6e5,
	9e5
];
function applyBotIdentityState(accountId, identity) {
	const botOpenId = normalizeOptionalString(identity.botOpenId);
	const botName = normalizeOptionalString(identity.botName);
	setFeishuBotIdentityState(accountId, {
		botOpenId: botOpenId ?? "",
		botName
	});
	return {
		botOpenId,
		botName
	};
}
async function retryBotIdentityProbe(account, accountId, runtime, abortSignal) {
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	for (let i = 0; i < BOT_IDENTITY_RETRY_DELAYS_MS.length; i += 1) {
		if (abortSignal?.aborted) return;
		if (!await waitForAbortableDelay(BOT_IDENTITY_RETRY_DELAYS_MS[i], abortSignal)) return;
		const resolved = applyBotIdentityState(accountId, await fetchBotIdentityForMonitor(account, {
			runtime,
			abortSignal
		}));
		if (resolved.botOpenId) {
			log(`feishu[${accountId}]: bot open_id recovered via background retry: ${resolved.botOpenId}`);
			return;
		}
		const nextDelay = BOT_IDENTITY_RETRY_DELAYS_MS[i + 1];
		error(`feishu[${accountId}]: bot identity background retry ${i + 1}/${BOT_IDENTITY_RETRY_DELAYS_MS.length} failed` + (nextDelay ? `; next attempt in ${nextDelay / 1e3}s` : ""));
	}
	error(`feishu[${accountId}]: bot identity background retry exhausted; requireMention group messages may be skipped until restart`);
}
function startBotIdentityRecovery(params) {
	const { account, accountId, runtime, abortSignal } = params;
	const log = runtime?.log ?? console.log;
	log(`feishu[${accountId}]: bot open_id unknown; starting background retry (delays: ${BOT_IDENTITY_RETRY_DELAYS_MS.map((delay) => `${delay / 1e3}s`).join(", ")})`);
	log(`feishu[${accountId}]: requireMention group messages stay gated until bot identity recovery succeeds`);
	retryBotIdentityProbe(account, accountId, runtime, abortSignal);
}
//#endregion
export { applyBotIdentityState, startBotIdentityRecovery };
