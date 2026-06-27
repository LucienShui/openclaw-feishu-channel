import { isRecord, readString } from "./comment-shared.js";
import { getFeishuRuntime } from "./runtime.js";
import { createEventDispatcher } from "./client.js";
import { createFeishuThreadBindingManager } from "./thread-bindings.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import { hasProcessedFeishuMessage, recordProcessedFeishuMessage, warmupDedupFromPluginState } from "./dedup.js";
import { getMessageFeishu } from "./send.js";
import { handleFeishuMessage, parseFeishuMessageEvent } from "./bot.js";
import { handleFeishuCardAction } from "./card-action.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { applyBotIdentityState, startBotIdentityRecovery } from "./monitor.bot-identity.js";
import { FeishuRetryableSyntheticEventError } from "./monitor.synthetic-error.js";
import { createFeishuBotMenuHandler } from "./monitor.bot-menu-handler.js";
import { createFeishuDriveCommentNoticeHandler } from "./monitor.comment-notice-handler.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { monitorWebSocket, monitorWebhook } from "./monitor.transport.js";
import { getFeishuSequentialKey } from "./sequential-key.js";
import * as crypto$1 from "node:crypto";
//#region src/monitor.account.ts
const FEISHU_REACTION_VERIFY_TIMEOUT_MS = 1500;
async function resolveReactionSyntheticEvent(params) {
	const { cfg, accountId, event, botOpenId, fetchMessage = getMessageFeishu, verificationTimeoutMs = FEISHU_REACTION_VERIFY_TIMEOUT_MS, logger, uuid = () => crypto$1.randomUUID(), action = "created" } = params;
	const emoji = event.reaction_type?.emoji_type;
	const messageId = event.message_id;
	const senderId = event.user_id?.open_id;
	const senderUserId = event.user_id?.user_id;
	if (!emoji || !messageId || !senderId) return null;
	const { resolveFeishuAccount } = await import("./accounts.js");
	const reactionNotifications = resolveFeishuAccount({
		cfg,
		accountId
	}).config.reactionNotifications ?? "own";
	if (reactionNotifications === "off") return null;
	if (event.operator_type === "app" || senderId === botOpenId) return null;
	if (emoji === "Typing") return null;
	if (reactionNotifications === "own" && !botOpenId) {
		logger?.(`feishu[${accountId}]: bot open_id unavailable, skipping reaction ${emoji} on ${messageId}`);
		return null;
	}
	const reactedMsg = await raceWithTimeoutAndAbort(fetchMessage({
		cfg,
		messageId,
		accountId
	}), { timeoutMs: verificationTimeoutMs }).then((result) => result.status === "resolved" ? result.value : null).catch(() => null);
	const isBotMessage = reactedMsg?.senderType === "app" || reactedMsg?.senderOpenId === botOpenId;
	if (!reactedMsg || reactionNotifications === "own" && !isBotMessage) {
		logger?.(`feishu[${accountId}]: ignoring reaction on non-bot/unverified message ${messageId} (sender: ${reactedMsg?.senderOpenId ?? "unknown"})`);
		return null;
	}
	const fallbackChatType = reactedMsg.chatType;
	const resolvedChatType = normalizeFeishuChatType(event.chat_type) ?? fallbackChatType;
	if (!resolvedChatType) {
		logger?.(`feishu[${accountId}]: skipping reaction ${emoji} on ${messageId} without chat type context`);
		return null;
	}
	const syntheticChatIdRaw = event.chat_id ?? reactedMsg.chatId;
	const syntheticChatId = syntheticChatIdRaw?.trim() ? syntheticChatIdRaw : `p2p:${senderId}`;
	const syntheticChatType = resolvedChatType;
	return {
		sender: {
			sender_id: {
				open_id: senderId,
				...senderUserId ? { user_id: senderUserId } : {}
			},
			sender_type: "user"
		},
		message: {
			message_id: `${messageId}:reaction:${emoji}:${uuid()}`,
			typing_target_message_id: messageId,
			chat_id: syntheticChatId,
			chat_type: syntheticChatType,
			message_type: "text",
			content: JSON.stringify({ text: action === "deleted" ? `[removed reaction ${emoji} from message ${messageId}]` : `[reacted with ${emoji} to message ${messageId}]` })
		}
	};
}
function normalizeFeishuChatType(value) {
	return value === "group" || value === "topic_group" || value === "private" || value === "p2p" ? value : void 0;
}
function parseFeishuBotAddedEventPayload(value) {
	if (!isRecord(value) || !readString(value.chat_id) || !isRecord(value.operator_id)) return null;
	return value;
}
function parseFeishuBotRemovedChatId(value) {
	if (!isRecord(value)) return null;
	return readString(value.chat_id) ?? null;
}
function firstString(...values) {
	for (const value of values) {
		const trimmed = readString(value)?.trim();
		if (trimmed) return trimmed;
	}
}
function readFeishuIdentityField(value, field) {
	if (!isRecord(value)) return;
	return firstString(value[field]);
}
function parseFeishuCardActionEventPayload(value) {
	if (!isRecord(value)) return null;
	const operator = isRecord(value.operator) ? value.operator : {};
	const action = value.action;
	const context = isRecord(value.context) ? value.context : {};
	if (!isRecord(action)) return null;
	const operatorUserId = operator.user_id;
	const token = readString(value.token);
	const openId = firstString(operator.open_id, readFeishuIdentityField(operatorUserId, "open_id"), value.open_id, context.open_id);
	const userId = firstString(operator.user_id, readFeishuIdentityField(operatorUserId, "user_id"), value.user_id, context.user_id);
	const unionId = firstString(operator.union_id, readFeishuIdentityField(operatorUserId, "union_id"));
	const tag = readString(action.tag);
	const actionValue = action.value;
	const openMessageId = firstString(context.open_message_id, value.open_message_id);
	const contextOpenId = firstString(context.open_id, openId);
	const contextUserId = firstString(context.user_id, userId);
	const chatId = firstString(context.chat_id, context.open_chat_id);
	if (!token || !openId || !tag || !isRecord(actionValue)) return null;
	return {
		operator: {
			open_id: openId,
			...userId ? { user_id: userId } : {},
			...unionId ? { union_id: unionId } : {}
		},
		token,
		action: {
			value: actionValue,
			tag
		},
		...openMessageId ? { open_message_id: openMessageId } : {},
		context: {
			...openMessageId ? { open_message_id: openMessageId } : {},
			...contextOpenId ? { open_id: contextOpenId } : {},
			...contextUserId ? { user_id: contextUserId } : {},
			...chatId ? { chat_id: chatId } : {}
		}
	};
}
function registerEventHandlers(eventDispatcher, context) {
	const { cfg, accountId, channelRuntime, runtime, chatHistories, fireAndForget } = context;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	const runFeishuHandler = async (params) => {
		if (fireAndForget) {
			params.task().catch((err) => {
				error(`${params.errorMessage}: ${String(err)}`);
			});
			return;
		}
		try {
			await params.task();
		} catch (err) {
			error(`${params.errorMessage}: ${String(err)}`);
		}
	};
	eventDispatcher.register({
		"im.message.receive_v1": createFeishuMessageReceiveHandler({
			cfg,
			channelRuntime,
			accountId,
			runtime,
			chatHistories,
			fireAndForget,
			handleMessage: handleFeishuMessage,
			resolveDebounceText: ({ event, botOpenId, botName }) => parseFeishuMessageEvent(event, botOpenId, botName).content,
			hasProcessedMessage: hasProcessedFeishuMessage,
			recordProcessedMessage: recordProcessedFeishuMessage,
			getBotOpenId: (id) => botOpenIds.get(id),
			getBotName: (id) => botNames.get(id),
			fetchMessage: getMessageFeishu,
			resolveSequentialKey: getFeishuSequentialKey
		}),
		"im.message.message_read_v1": async () => {},
		"im.chat.access_event.bot_p2p_chat_entered_v1": async () => {},
		"im.chat.member.bot.added_v1": async (data) => {
			try {
				const event = parseFeishuBotAddedEventPayload(data);
				if (!event) return;
				log(`feishu[${accountId}]: bot added to chat ${event.chat_id}`);
			} catch (err) {
				error(`feishu[${accountId}]: error handling bot added event: ${String(err)}`);
			}
		},
		"im.chat.member.bot.deleted_v1": async (data) => {
			try {
				const chatId = parseFeishuBotRemovedChatId(data);
				if (!chatId) return;
				log(`feishu[${accountId}]: bot removed from chat ${chatId}`);
			} catch (err) {
				error(`feishu[${accountId}]: error handling bot removed event: ${String(err)}`);
			}
		},
		"drive.notice.comment_add_v1": createFeishuDriveCommentNoticeHandler({
			cfg,
			accountId,
			runtime,
			fireAndForget
		}),
		"im.message.reaction.created_v1": async (data) => {
			await runFeishuHandler({
				errorMessage: `feishu[${accountId}]: error handling reaction event`,
				task: async () => {
					const event = data;
					const myBotId = botOpenIds.get(accountId);
					const syntheticEvent = await resolveReactionSyntheticEvent({
						cfg,
						accountId,
						event,
						botOpenId: myBotId,
						logger: log
					});
					if (!syntheticEvent) return;
					await handleFeishuMessage({
						cfg,
						event: syntheticEvent,
						botOpenId: myBotId,
						botName: botNames.get(accountId),
						runtime,
						channelRuntime,
						chatHistories,
						accountId
					});
				}
			});
		},
		"im.message.reaction.deleted_v1": async (data) => {
			await runFeishuHandler({
				errorMessage: `feishu[${accountId}]: error handling reaction removal event`,
				task: async () => {
					const event = data;
					const myBotId = botOpenIds.get(accountId);
					const syntheticEvent = await resolveReactionSyntheticEvent({
						cfg,
						accountId,
						event,
						botOpenId: myBotId,
						logger: log,
						action: "deleted"
					});
					if (!syntheticEvent) return;
					await handleFeishuMessage({
						cfg,
						event: syntheticEvent,
						botOpenId: myBotId,
						botName: botNames.get(accountId),
						runtime,
						channelRuntime,
						chatHistories,
						accountId
					});
				}
			});
		},
		"application.bot.menu_v6": createFeishuBotMenuHandler({
			cfg,
			accountId,
			runtime,
			chatHistories,
			fireAndForget,
			channelRuntime
		}),
		"card.action.trigger": async (data) => {
			try {
				const event = parseFeishuCardActionEventPayload(data);
				if (!event) {
					error(`feishu[${accountId}]: ignoring malformed card action payload`);
					return;
				}
				const promise = handleFeishuCardAction({
					cfg,
					event,
					botOpenId: botOpenIds.get(accountId),
					runtime,
					channelRuntime,
					accountId
				});
				if (fireAndForget) promise.catch((err) => {
					error(`feishu[${accountId}]: error handling card action: ${String(err)}`);
				});
				else await promise;
			} catch (err) {
				error(`feishu[${accountId}]: error handling card action: ${String(err)}`);
			}
		}
	});
}
async function monitorSingleAccount(params) {
	const { cfg, account, runtime, abortSignal } = params;
	const { accountId } = account;
	const log = runtime?.log ?? console.log;
	const botOpenIdSource = params.botOpenIdSource ?? { kind: "fetch" };
	const { botOpenId } = applyBotIdentityState(accountId, botOpenIdSource.kind === "prefetched" ? {
		botOpenId: botOpenIdSource.botOpenId,
		botName: botOpenIdSource.botName
	} : await fetchBotIdentityForMonitor(account, {
		runtime,
		abortSignal
	}));
	log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);
	if (!botOpenId && !abortSignal?.aborted) startBotIdentityRecovery({
		account,
		accountId,
		runtime,
		abortSignal
	});
	const connectionMode = account.config.connectionMode ?? "websocket";
	if (connectionMode === "webhook" && !account.verificationToken?.trim()) throw new Error(`Feishu account "${accountId}" webhook mode requires verificationToken`);
	if (connectionMode === "webhook" && !account.encryptKey?.trim()) throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
	const warmupCount = await warmupDedupFromPluginState(accountId, log);
	if (warmupCount > 0) log(`feishu[${accountId}]: dedup warmup loaded ${warmupCount} entries from plugin state`);
	let threadBindingManager;
	try {
		const eventDispatcher = createEventDispatcher(account);
		const chatHistories = /* @__PURE__ */ new Map();
		threadBindingManager = createFeishuThreadBindingManager({
			accountId,
			cfg
		});
		registerEventHandlers(eventDispatcher, {
			cfg,
			accountId,
			channelRuntime: params.channelRuntime ?? getFeishuRuntime().channel,
			runtime,
			chatHistories,
			fireAndForget: params.fireAndForget ?? true
		});
		if (connectionMode === "webhook") return await monitorWebhook({
			account,
			accountId,
			runtime,
			abortSignal,
			eventDispatcher
		});
		return await monitorWebSocket({
			account,
			accountId,
			runtime,
			abortSignal,
			eventDispatcher
		});
	} finally {
		threadBindingManager?.stop();
	}
}
//#endregion
export { FeishuRetryableSyntheticEventError, monitorSingleAccount, resolveReactionSyntheticEvent };
