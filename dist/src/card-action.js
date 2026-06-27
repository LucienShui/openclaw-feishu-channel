import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { buildFeishuCardActionTextFallback, decodeFeishuCardAction } from "./card-interaction.js";
import { createFeishuClient } from "./client.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";
import { handleFeishuMessage } from "./bot.js";
import { createApprovalCard } from "./card-ux-approval.js";
import { asDateTimestampMs, isFutureDateTimestampMs, resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
//#region src/card-action.ts
const FEISHU_APPROVAL_CARD_TTL_MS = 5 * 6e4;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 6e4;
const processedCardActionTokens = /* @__PURE__ */ new Map();
var FeishuRetryableCardActionError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "FeishuRetryableCardActionError";
	}
};
function resetProcessedFeishuCardActionTokensForTests() {
	processedCardActionTokens.clear();
	resolvedChatTypeCache.clear();
}
function pruneProcessedCardActionTokens(now) {
	const validNow = asDateTimestampMs(now);
	if (validNow === void 0) {
		processedCardActionTokens.clear();
		return;
	}
	for (const [key, entry] of processedCardActionTokens.entries()) if (!isFutureDateTimestampMs(entry.expiresAt, { nowMs: validNow })) processedCardActionTokens.delete(key);
}
function resolveProcessedCardActionTokenExpiresAt(now) {
	return resolveExpiresAtMsFromDurationMs(FEISHU_CARD_ACTION_TOKEN_TTL_MS, { nowMs: now });
}
function beginFeishuCardActionToken(params) {
	const now = params.now ?? Date.now();
	pruneProcessedCardActionTokens(now);
	const normalizedToken = params.token.trim();
	if (!normalizedToken) return false;
	const key = `${params.accountId}:${normalizedToken}`;
	const existing = processedCardActionTokens.get(key);
	if (existing && isFutureDateTimestampMs(existing.expiresAt, { nowMs: now })) return false;
	processedCardActionTokens.delete(key);
	const expiresAt = resolveProcessedCardActionTokenExpiresAt(now);
	if (expiresAt !== void 0) processedCardActionTokens.set(key, {
		status: "inflight",
		expiresAt
	});
	return true;
}
function completeFeishuCardActionToken(params) {
	const now = params.now ?? Date.now();
	const normalizedToken = params.token.trim();
	if (!normalizedToken) return;
	const key = `${params.accountId}:${normalizedToken}`;
	const expiresAt = resolveProcessedCardActionTokenExpiresAt(now);
	if (expiresAt === void 0) {
		processedCardActionTokens.delete(key);
		return;
	}
	processedCardActionTokens.set(key, {
		status: "completed",
		expiresAt
	});
}
function releaseFeishuCardActionToken(params) {
	const normalizedToken = params.token.trim();
	if (!normalizedToken) return;
	processedCardActionTokens.delete(`${params.accountId}:${normalizedToken}`);
}
function buildSyntheticMessageEvent(event, content, chatType) {
	const replyTargetMessageId = event.context.open_message_id ?? event.open_message_id;
	const isTemporaryCardActionId = replyTargetMessageId?.startsWith("card-action-c-");
	const validReplyTargetId = replyTargetMessageId && !isTemporaryCardActionId ? replyTargetMessageId : void 0;
	return {
		sender: { sender_id: {
			open_id: event.operator.open_id,
			user_id: event.operator.user_id,
			union_id: event.operator.union_id
		} },
		message: {
			message_id: `card-action-${event.token}`,
			...validReplyTargetId ? { reply_target_message_id: validReplyTargetId } : {},
			...validReplyTargetId ? { typing_target_message_id: validReplyTargetId } : {},
			...!validReplyTargetId ? { suppress_reply_target: true } : {},
			chat_id: event.context.chat_id || event.operator.open_id,
			chat_type: chatType,
			message_type: "text",
			content: JSON.stringify({ text: content })
		}
	};
}
function resolveCallbackTarget(event) {
	const chatId = event.context.chat_id?.trim();
	if (chatId) return `chat:${chatId}`;
	return `user:${event.operator.open_id}`;
}
async function dispatchSyntheticCommand(params) {
	const resolvedChatType = await resolveCardActionChatType({
		event: params.event,
		account: params.account,
		chatType: params.chatType,
		log: params.runtime?.log ?? console.log
	});
	await handleFeishuMessage({
		cfg: params.cfg,
		event: buildSyntheticMessageEvent(params.event, params.command, resolvedChatType),
		botOpenId: params.botOpenId,
		runtime: params.runtime,
		channelRuntime: params.channelRuntime,
		accountId: params.accountId
	});
}
function normalizeResolvedCardActionChatType(value) {
	if (value === "group" || value === "topic" || value === "public") return "group";
	if (value === "p2p" || value === "private") return "p2p";
}
const resolvedChatTypeCache = /* @__PURE__ */ new Map();
const CHAT_TYPE_CACHE_TTL_MS = 30 * 6e4;
const CHAT_TYPE_CACHE_MAX_SIZE = 5e3;
function pruneChatTypeCache(now) {
	const validNow = asDateTimestampMs(now);
	if (validNow === void 0) {
		resolvedChatTypeCache.clear();
		return;
	}
	for (const [key, entry] of resolvedChatTypeCache.entries()) {
		const expiresAt = asDateTimestampMs(entry.expiresAt);
		if (expiresAt === void 0 || expiresAt <= validNow) resolvedChatTypeCache.delete(key);
	}
	if (resolvedChatTypeCache.size > CHAT_TYPE_CACHE_MAX_SIZE) {
		const excess = resolvedChatTypeCache.size - CHAT_TYPE_CACHE_MAX_SIZE;
		const iter = resolvedChatTypeCache.keys();
		for (let i = 0; i < excess; i++) {
			const key = iter.next().value;
			if (key !== void 0) resolvedChatTypeCache.delete(key);
		}
	}
}
function sanitizeLogValue(v) {
	return v.replace(/[\r\n]/g, " ").slice(0, 500);
}
function resolveFeishuApprovalCardExpiresAt(nowRaw = Date.now()) {
	const now = asDateTimestampMs(nowRaw);
	return now === void 0 ? void 0 : resolveExpiresAtMsFromDurationMs(FEISHU_APPROVAL_CARD_TTL_MS, { nowMs: now });
}
function cacheResolvedCardActionChatType(cacheKey, value, now) {
	const expiresAt = resolveExpiresAtMsFromDurationMs(CHAT_TYPE_CACHE_TTL_MS, { nowMs: now });
	resolvedChatTypeCache.delete(cacheKey);
	if (expiresAt !== void 0) resolvedChatTypeCache.set(cacheKey, {
		value,
		expiresAt
	});
}
async function resolveCardActionChatType(params) {
	const explicitChatType = normalizeResolvedCardActionChatType(params.chatType);
	if (explicitChatType) return explicitChatType;
	const chatId = params.event.context.chat_id?.trim();
	if (!chatId) return "p2p";
	const cacheKey = `${params.account.accountId}:${chatId}`;
	const now = Date.now();
	pruneChatTypeCache(now);
	const cached = resolvedChatTypeCache.get(cacheKey);
	const cachedExpiresAt = cached ? asDateTimestampMs(cached.expiresAt) : void 0;
	if (cached && cachedExpiresAt !== void 0) return cached.value;
	if (cached) resolvedChatTypeCache.delete(cacheKey);
	try {
		const response = await createFeishuClient(params.account).im.chat.get({ path: { chat_id: chatId } });
		if (response.code === 0) {
			const resolvedChatType = normalizeResolvedCardActionChatType(response.data?.chat_mode) ?? normalizeResolvedCardActionChatType(response.data?.chat_type);
			if (resolvedChatType) {
				cacheResolvedCardActionChatType(cacheKey, resolvedChatType, now);
				return resolvedChatType;
			}
			params.log(`feishu[${params.account.accountId}]: card action missing chat type for chat; defaulting to p2p`);
		} else params.log(`feishu[${params.account.accountId}]: failed to resolve chat type: ${sanitizeLogValue(response.msg ?? "unknown error")}; defaulting to p2p`);
	} catch (err) {
		const message = err instanceof Error ? err.message : "unknown";
		params.log(`feishu[${params.account.accountId}]: failed to resolve chat type: ${sanitizeLogValue(message)}; defaulting to p2p`);
	}
	return "p2p";
}
async function sendInvalidInteractionNotice(params) {
	const reasonText = params.reason === "stale" ? "This card action has expired. Open a fresh launcher card and try again." : params.reason === "wrong_user" ? "This card action belongs to a different user." : params.reason === "wrong_conversation" ? "This card action belongs to a different conversation." : "This card action payload is invalid.";
	await sendMessageFeishu({
		cfg: params.cfg,
		to: resolveCallbackTarget(params.event),
		text: `⚠️ ${reasonText}`,
		accountId: params.accountId
	});
}
async function handleFeishuCardAction(params) {
	const { cfg, event, runtime, accountId } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	const log = runtime?.log ?? console.log;
	if (!event.token.trim()) {
		log(`feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: missing token`);
		return;
	}
	const decoded = decodeFeishuCardAction({ event });
	if (!beginFeishuCardActionToken({
		token: event.token,
		accountId: account.accountId
	})) {
		log(`feishu[${account.accountId}]: skipping duplicate card action token ${event.token}`);
		return;
	}
	try {
		if (decoded.kind === "invalid") {
			log(`feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: ${decoded.reason}`);
			await sendInvalidInteractionNotice({
				cfg,
				event,
				reason: decoded.reason,
				accountId
			});
			completeFeishuCardActionToken({
				token: event.token,
				accountId: account.accountId
			});
			return;
		}
		if (decoded.kind === "structured") {
			const { envelope } = decoded;
			log(`feishu[${account.accountId}]: handling structured card action ${envelope.a} from ${event.operator.open_id}`);
			if (envelope.a === "feishu.quick_actions.request_approval") {
				const command = typeof envelope.m?.command === "string" ? envelope.m.command.trim() : "";
				if (!command) {
					await sendInvalidInteractionNotice({
						cfg,
						event,
						reason: "malformed",
						accountId
					});
					completeFeishuCardActionToken({
						token: event.token,
						accountId: account.accountId
					});
					return;
				}
				const prompt = typeof envelope.m?.prompt === "string" && envelope.m.prompt.trim() ? envelope.m.prompt : `Run \`${command}\` in this Feishu conversation?`;
				const expiresAt = resolveFeishuApprovalCardExpiresAt();
				if (expiresAt === void 0) {
					await sendInvalidInteractionNotice({
						cfg,
						event,
						reason: "malformed",
						accountId
					});
					completeFeishuCardActionToken({
						token: event.token,
						accountId: account.accountId
					});
					return;
				}
				await sendCardFeishu({
					cfg,
					to: resolveCallbackTarget(event),
					card: createApprovalCard({
						operatorOpenId: event.operator.open_id,
						chatId: event.context.chat_id || void 0,
						command,
						prompt,
						sessionKey: envelope.c?.s,
						expiresAt,
						chatType: await resolveCardActionChatType({
							event,
							account,
							chatType: envelope.c?.t,
							log
						}),
						confirmLabel: command === "/reset" ? "Reset" : "Confirm"
					}),
					accountId
				});
				completeFeishuCardActionToken({
					token: event.token,
					accountId: account.accountId
				});
				return;
			}
			if (envelope.a === "feishu.approval.cancel") {
				await sendMessageFeishu({
					cfg,
					to: resolveCallbackTarget(event),
					text: "Cancelled.",
					accountId
				});
				completeFeishuCardActionToken({
					token: event.token,
					accountId: account.accountId
				});
				return;
			}
			if (envelope.a === "feishu.approval.confirm" || envelope.k === "quick") {
				const command = envelope.q?.trim();
				if (!command) {
					await sendInvalidInteractionNotice({
						cfg,
						event,
						reason: "malformed",
						accountId
					});
					completeFeishuCardActionToken({
						token: event.token,
						accountId: account.accountId
					});
					return;
				}
				await dispatchSyntheticCommand({
					cfg,
					event,
					command,
					account,
					botOpenId: params.botOpenId,
					runtime,
					channelRuntime: params.channelRuntime,
					accountId,
					chatType: envelope.c?.t
				});
				completeFeishuCardActionToken({
					token: event.token,
					accountId: account.accountId
				});
				return;
			}
			await sendInvalidInteractionNotice({
				cfg,
				event,
				reason: "malformed",
				accountId
			});
			completeFeishuCardActionToken({
				token: event.token,
				accountId: account.accountId
			});
			return;
		}
		const content = buildFeishuCardActionTextFallback(event);
		log(`feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`);
		await dispatchSyntheticCommand({
			cfg,
			event,
			command: content,
			account,
			botOpenId: params.botOpenId,
			runtime,
			channelRuntime: params.channelRuntime,
			accountId
		});
		completeFeishuCardActionToken({
			token: event.token,
			accountId: account.accountId
		});
	} catch (err) {
		if (err instanceof FeishuRetryableCardActionError) releaseFeishuCardActionToken({
			token: event.token,
			accountId: account.accountId
		});
		else completeFeishuCardActionToken({
			token: event.token,
			accountId: account.accountId
		});
		throw err;
	}
}
//#endregion
export { FeishuRetryableCardActionError, handleFeishuCardAction, resetProcessedFeishuCardActionTokensForTests };
