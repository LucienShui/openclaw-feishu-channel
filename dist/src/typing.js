import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { getFeishuRuntime } from "./runtime.js";
import { createFeishuClient } from "./client.js";
//#region src/typing.ts
const TYPING_EMOJI = "Typing";
/**
* Feishu API error codes that indicate the caller should back off.
* These must propagate to the typing circuit breaker so the keepalive loop
* can trip and stop retrying.
*
* - 99991400: Rate limit (too many requests per second)
* - 99991403: Monthly API call quota exceeded
* - 429: Standard HTTP 429 returned as a Feishu SDK error code
*
* @see https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
*/
const FEISHU_BACKOFF_CODES = /* @__PURE__ */ new Set([
	99991400,
	99991403,
	429
]);
/**
* Custom error class for Feishu backoff conditions detected from non-throwing
* SDK responses. Carries a numeric `.code` so that `isFeishuBackoffError()`
* recognises it when the error is caught downstream.
*/
var FeishuBackoffError = class extends Error {
	code;
	constructor(code) {
		super(`Feishu API backoff: code ${code}`);
		this.name = "FeishuBackoffError";
		this.code = code;
	}
};
/**
* Check whether an error represents a rate-limit or quota-exceeded condition
* from the Feishu API that should stop the typing keepalive loop.
*
* Handles two shapes:
* 1. AxiosError with `response.status` and `response.data.code`
* 2. Feishu SDK error with a top-level `code` property
*/
function isFeishuBackoffError(err) {
	if (typeof err !== "object" || err === null) return false;
	const response = err.response;
	if (response) {
		if (response.status === 429) return true;
		if (typeof response.data?.code === "number" && FEISHU_BACKOFF_CODES.has(response.data.code)) return true;
	}
	const code = err.code;
	if (typeof code === "number" && FEISHU_BACKOFF_CODES.has(code)) return true;
	return false;
}
/**
* Check whether a Feishu SDK response object contains a backoff error code.
*
* The Feishu SDK sometimes returns a normal response (no throw) with an
* API-level error code in the response body. This must be detected so the
* circuit breaker can trip. See codex review on #28157.
*/
function getBackoffCodeFromResponse(response) {
	if (typeof response !== "object" || response === null) return;
	const code = response.code;
	if (typeof code === "number" && FEISHU_BACKOFF_CODES.has(code)) return code;
}
/**
* Add a typing indicator (reaction) to a message.
*
* Rate-limit and quota errors are re-thrown so the circuit breaker in
* `createTypingCallbacks` (typing-start-guard) can trip and stop the
* keepalive loop. See #28062.
*
* Also checks for backoff codes in non-throwing SDK responses (#28157).
*/
async function addTypingIndicator(params) {
	const { cfg, messageId, accountId, runtime } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) return {
		messageId,
		reactionId: null
	};
	const client = createFeishuClient(account);
	try {
		const response = await client.im.messageReaction.create({
			path: { message_id: messageId },
			data: { reaction_type: { emoji_type: TYPING_EMOJI } }
		});
		const backoffCode = getBackoffCodeFromResponse(response);
		if (backoffCode !== void 0) {
			if (getFeishuRuntime().logging.shouldLogVerbose()) runtime?.log?.(`[feishu] typing indicator response contains backoff code ${backoffCode}, stopping keepalive`);
			throw new FeishuBackoffError(backoffCode);
		}
		return {
			messageId,
			reactionId: response.data?.reaction_id ?? null
		};
	} catch (err) {
		if (isFeishuBackoffError(err)) {
			if (getFeishuRuntime().logging.shouldLogVerbose()) runtime?.log?.("[feishu] typing indicator hit rate-limit/quota, stopping keepalive");
			throw err;
		}
		if (getFeishuRuntime().logging.shouldLogVerbose()) runtime?.log?.(`[feishu] failed to add typing indicator: ${String(err)}`);
		return {
			messageId,
			reactionId: null
		};
	}
}
/**
* Remove a typing indicator (reaction) from a message.
*
* Rate-limit and quota errors are re-thrown for the same reason as above.
*/
async function removeTypingIndicator(params) {
	const { cfg, state, accountId, runtime } = params;
	if (!state.reactionId) return;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) return;
	const client = createFeishuClient(account);
	try {
		const backoffCode = getBackoffCodeFromResponse(await client.im.messageReaction.delete({ path: {
			message_id: state.messageId,
			reaction_id: state.reactionId
		} }));
		if (backoffCode !== void 0) {
			if (getFeishuRuntime().logging.shouldLogVerbose()) runtime?.log?.(`[feishu] typing indicator removal response contains backoff code ${backoffCode}, stopping keepalive`);
			throw new FeishuBackoffError(backoffCode);
		}
	} catch (err) {
		if (isFeishuBackoffError(err)) {
			if (getFeishuRuntime().logging.shouldLogVerbose()) runtime?.log?.("[feishu] typing indicator removal hit rate-limit/quota, stopping keepalive");
			throw err;
		}
		if (getFeishuRuntime().logging.shouldLogVerbose()) runtime?.log?.(`[feishu] failed to remove typing indicator: ${String(err)}`);
	}
}
//#endregion
export { FeishuBackoffError, addTypingIndicator, getBackoffCodeFromResponse, isFeishuBackoffError, removeTypingIndicator };
