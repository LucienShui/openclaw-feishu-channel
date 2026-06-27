import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { isMentionForwardRequest } from "./mention.js";
import { isFeishuTopicSessionScope, resolveConfiguredFeishuGroupSessionScope } from "./bot-content.js";
import { releaseFeishuMessageProcessing, tryBeginFeishuMessageProcessing } from "./processing-claims.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import { createSequentialQueue } from "./sequential-queue.js";
import { isRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/monitor.message-handler.ts
function normalizeFeishuChatType(value) {
	return value === "group" || value === "topic_group" || value === "private" || value === "p2p" ? value : void 0;
}
function resolveFeishuProcessingClaimKey(params) {
	const messageId = params.event.message.message_id?.trim();
	return params.messageDedupeKey && params.messageDedupeKey !== messageId ? params.messageDedupeKey : messageId;
}
function shouldHydrateFeishuTopicThreadIdForQueue(params) {
	if (params.event.message.chat_type !== "topic_group" || params.event.message.thread_id?.trim()) return false;
	const chatId = params.event.message.chat_id?.trim();
	if (!chatId) return false;
	const feishuCfg = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config;
	return isFeishuTopicSessionScope(resolveConfiguredFeishuGroupSessionScope({
		groupConfig: resolveFeishuGroupConfig({
			cfg: feishuCfg,
			groupId: chatId
		}),
		feishuCfg,
		chatType: params.event.message.chat_type
	}));
}
function buildPendingTopicChatKey(event) {
	if (event.message.chat_type !== "topic_group") return null;
	return event.message.chat_id?.trim() || null;
}
async function hydrateFeishuTopicThreadIdForQueue(params) {
	if (!params.fetchMessage || !shouldHydrateFeishuTopicThreadIdForQueue({
		cfg: params.cfg,
		accountId: params.accountId,
		event: params.event
	})) return params.event;
	try {
		const threadId = (await params.fetchMessage({
			cfg: params.cfg,
			accountId: params.accountId,
			messageId: params.event.message.message_id
		}))?.threadId?.trim();
		if (threadId) return {
			...params.event,
			message: {
				...params.event.message,
				thread_id: threadId
			}
		};
	} catch (err) {
		params.log(`feishu[${params.accountId}]: failed to hydrate topic thread_id before queueing message=${params.event.message.message_id}: ${String(err)}`);
	}
	return params.event;
}
function parseFeishuMessageEventPayload(value) {
	if (!isRecord(value)) return null;
	const sender = value.sender;
	const message = value.message;
	if (!isRecord(sender) || !isRecord(message)) return null;
	const senderId = sender.sender_id;
	if (!isRecord(senderId)) return null;
	const messageId = readStringValue(message.message_id);
	const chatId = readStringValue(message.chat_id);
	const chatType = normalizeFeishuChatType(message.chat_type);
	const messageType = readStringValue(message.message_type);
	const content = readStringValue(message.content);
	if (!messageId || !chatId || !chatType || !messageType || !content) return null;
	return value;
}
function mergeFeishuDebounceMentions(entries) {
	const merged = /* @__PURE__ */ new Map();
	for (const entry of entries) for (const mention of entry.message.mentions ?? []) {
		const stableId = mention.id.open_id?.trim() || mention.id.user_id?.trim() || mention.id.union_id?.trim();
		const mentionName = mention.name?.trim();
		const mentionKey = mention.key?.trim();
		const fallback = mentionName && mentionKey ? `${mentionName}|${mentionKey}` : mentionName || mentionKey;
		const key = stableId || fallback;
		if (!key || merged.has(key)) continue;
		merged.set(key, mention);
	}
	return merged.size > 0 ? Array.from(merged.values()) : void 0;
}
function dedupeFeishuDebounceEntriesByDedupeKey(entries) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of entries) {
		const dedupeKey = resolveFeishuMessageDedupeKey(entry);
		if (!dedupeKey) {
			deduped.push(entry);
			continue;
		}
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		deduped.push(entry);
	}
	return deduped;
}
function resolveFeishuDebounceMentions(params) {
	const { entries, botOpenId } = params;
	if (entries.length === 0) return;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (isMentionForwardRequest(entry, botOpenId)) return mergeFeishuDebounceMentions([entry]);
	}
	const merged = mergeFeishuDebounceMentions(entries);
	if (!merged) return;
	const normalizedBotOpenId = botOpenId?.trim();
	if (!normalizedBotOpenId) return;
	const botMentions = merged.filter((mention) => mention.id.open_id?.trim() === normalizedBotOpenId);
	return botMentions.length > 0 ? botMentions : void 0;
}
function createFeishuMessageReceiveHandler({ cfg, channelRuntime, accountId, runtime, chatHistories, fireAndForget, handleMessage, resolveDebounceText: resolveText, hasProcessedMessage, recordProcessedMessage, getBotOpenId = () => void 0, getBotName = () => void 0, fetchMessage, resolveSequentialKey = ({ accountId: accountIdLocal, event }) => `feishu:${accountIdLocal}:${event.message.chat_id?.trim() || "unknown"}` }) {
	const inboundDebounceMs = channelRuntime.debounce.resolveInboundDebounceMs({
		cfg,
		channel: "feishu"
	});
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	const enqueue = createSequentialQueue({ onTaskTimeout: (key, timeoutMs) => {
		log(`feishu[${accountId}]: per-conversation task exceeded ${timeoutMs}ms cap (key=${key}); evicting from queue so later same-key messages can proceed (#70133)`);
	} });
	const pendingTopicQueueingByChat = /* @__PURE__ */ new Map();
	const startFeishuMessageQueueTask = (queueEvent, messageDedupeKey) => {
		const sequentialKey = resolveSequentialKey({
			cfg,
			accountId,
			event: queueEvent,
			botOpenId: getBotOpenId(accountId),
			botName: getBotName(accountId)
		});
		const task = () => handleMessage({
			cfg,
			event: queueEvent,
			botOpenId: getBotOpenId(accountId),
			botName: getBotName(accountId),
			runtime,
			channelRuntime,
			chatHistories,
			accountId,
			processingClaimHeld: true,
			messageDedupeKey
		});
		return enqueue(sequentialKey, task);
	};
	const hydrateAndStartFeishuMessageQueueTask = async (event, messageDedupeKey) => {
		await startFeishuMessageQueueTask(await hydrateFeishuTopicThreadIdForQueue({
			cfg,
			accountId,
			event,
			fetchMessage,
			log
		}), messageDedupeKey);
	};
	const waitForPendingTopicQueueing = async (event) => {
		const chatKey = buildPendingTopicChatKey(event);
		const pendingQueueing = chatKey ? pendingTopicQueueingByChat.get(chatKey) : void 0;
		if (!pendingQueueing) return;
		await pendingQueueing.catch(() => void 0);
	};
	const dispatchFeishuMessage = async (event, messageDedupeKey) => {
		if (event.message.chat_type === "topic_group" && !event.message.thread_id?.trim()) {
			const chatKey = buildPendingTopicChatKey(event);
			const previousQueueing = (chatKey ? pendingTopicQueueingByChat.get(chatKey) : void 0) ?? Promise.resolve();
			let taskPromise;
			const queueingPromise = previousQueueing.catch(() => void 0).then(async () => {
				taskPromise = startFeishuMessageQueueTask(await hydrateFeishuTopicThreadIdForQueue({
					cfg,
					accountId,
					event,
					fetchMessage,
					log
				}), messageDedupeKey);
			});
			if (chatKey) pendingTopicQueueingByChat.set(chatKey, queueingPromise);
			try {
				await queueingPromise;
			} finally {
				if (chatKey && pendingTopicQueueingByChat.get(chatKey) === queueingPromise) pendingTopicQueueingByChat.delete(chatKey);
			}
			try {
				await taskPromise;
			} finally {
				taskPromise = void 0;
			}
			return;
		}
		await waitForPendingTopicQueueing(event);
		await hydrateAndStartFeishuMessageQueueTask(event, messageDedupeKey);
	};
	const resolveSenderDebounceId = (event) => {
		return event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim() || void 0;
	};
	const resolveDebounceText = (event) => {
		return resolveText({
			event,
			botOpenId: getBotOpenId(accountId),
			botName: getBotName(accountId)
		}).trim();
	};
	const recordSuppressedMessageIds = async (entries, dispatchDedupeKey) => {
		const keepDedupeKey = dispatchDedupeKey?.trim();
		const suppressedIds = new Set(entries.map((entry) => resolveFeishuMessageDedupeKey(entry)).filter((id) => Boolean(id) && (!keepDedupeKey || id !== keepDedupeKey)));
		for (const messageId of suppressedIds) try {
			await recordProcessedMessage(messageId, accountId, log);
		} catch (err) {
			error(`feishu[${accountId}]: failed to record merged dedupe id ${messageId}: ${String(err)}`);
		}
	};
	const inboundDebouncer = channelRuntime.debounce.createInboundDebouncer({
		debounceMs: inboundDebounceMs,
		buildKey: (event) => {
			const chatId = event.message.chat_id?.trim();
			const senderId = resolveSenderDebounceId(event);
			if (!chatId || !senderId) return null;
			const rootId = event.message.root_id?.trim();
			const threadId = event.message.thread_id?.trim();
			return `feishu:${accountId}:${chatId}:${threadId || rootId ? `thread:${threadId ?? rootId}` : "chat"}:${senderId}`;
		},
		shouldDebounce: (event) => {
			if (event.message.message_type !== "text") return false;
			const text = resolveDebounceText(event);
			return Boolean(text) && !channelRuntime.commands.isControlCommandMessage(text, cfg);
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			if (entries.length === 1) {
				await dispatchFeishuMessage(last, resolveFeishuMessageDedupeKey(last));
				return;
			}
			const dedupedEntries = dedupeFeishuDebounceEntriesByDedupeKey(entries);
			const freshEntries = [];
			for (const entry of dedupedEntries) if (!await hasProcessedMessage(resolveFeishuMessageDedupeKey(entry), accountId, log)) freshEntries.push(entry);
			const dispatchEntry = freshEntries.at(-1);
			if (!dispatchEntry) return;
			const dispatchDedupeKey = resolveFeishuMessageDedupeKey(dispatchEntry);
			await recordSuppressedMessageIds(dedupedEntries, dispatchDedupeKey);
			const combinedText = freshEntries.map((entry) => resolveDebounceText(entry)).filter(Boolean).join("\n");
			const mergedMentions = resolveFeishuDebounceMentions({
				entries: freshEntries,
				botOpenId: getBotOpenId(accountId)
			});
			await dispatchFeishuMessage({
				...dispatchEntry,
				message: {
					...dispatchEntry.message,
					...combinedText.trim() ? {
						message_type: "text",
						content: JSON.stringify({ text: combinedText })
					} : {},
					mentions: mergedMentions ?? dispatchEntry.message.mentions
				}
			}, dispatchDedupeKey);
		},
		onError: (err, entries) => {
			for (const entry of entries) releaseFeishuMessageProcessing(resolveFeishuMessageDedupeKey(entry), accountId);
			error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
		}
	});
	return (data) => {
		const event = parseFeishuMessageEventPayload(data);
		if (!event) {
			error(`feishu[${accountId}]: ignoring malformed message event payload`);
			return Promise.resolve();
		}
		const messageId = event.message?.message_id?.trim();
		const botOpenId = getBotOpenId(accountId)?.trim();
		const senderOpenId = event.sender.sender_id.open_id?.trim();
		if (botOpenId && senderOpenId === botOpenId) {
			log(`feishu[${accountId}]: dropping self-authored message ${messageId ?? "unknown"}`);
			return Promise.resolve();
		}
		const processingClaimKey = resolveFeishuProcessingClaimKey({
			event,
			messageDedupeKey: resolveFeishuMessageDedupeKey(event)
		});
		if (!tryBeginFeishuMessageProcessing(processingClaimKey, accountId)) {
			log(`feishu[${accountId}]: dropping duplicate event for message ${messageId}`);
			return Promise.resolve();
		}
		log(`feishu[${accountId}]: queued receive event message=${messageId ?? "unknown"} chat_type=${event.message.chat_type} thread=${event.message.thread_id?.trim() || "none"} root=${event.message.root_id?.trim() || "none"}`);
		const processMessage = async () => {
			await inboundDebouncer.enqueue(event);
		};
		if (fireAndForget) {
			setImmediate(() => {
				processMessage().catch((err) => {
					releaseFeishuMessageProcessing(processingClaimKey, accountId);
					error(`feishu[${accountId}]: error handling message: ${String(err)}`);
				});
			});
			return Promise.resolve();
		}
		return processMessage().catch((err) => {
			releaseFeishuMessageProcessing(processingClaimKey, accountId);
			error(`feishu[${accountId}]: error handling message: ${String(err)}`);
		});
	};
}
//#endregion
export { createFeishuMessageReceiveHandler };
