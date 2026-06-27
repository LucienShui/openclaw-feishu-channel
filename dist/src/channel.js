import { isRecord as isRecord$1 } from "./comment-shared.js";
import { inspectFeishuCredentials, listEnabledFeishuAccounts, listFeishuAccountIds, resolveDefaultFeishuAccountId, resolveFeishuAccount, resolveFeishuRuntimeAccount } from "./accounts.js";
import { looksLikeFeishuId, normalizeFeishuTarget } from "./targets.js";
import { feishuApprovalAuth } from "./approval-auth.js";
import "./card-interaction.js";
import { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, buildChannelConfigSchema, buildProbeChannelStatusSummary, chunkTextForOutbound, createActionGate, createDefaultChannelRuntimeState } from "./channel-runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { buildFeishuConversationId, buildFeishuModelOverrideParentCandidates, parseFeishuConversationId, parseFeishuDirectConversationId, parseFeishuTargetId } from "./conversation-id.js";
import { listFeishuDirectoryGroups, listFeishuDirectoryPeers } from "./directory.static.js";
import { feishuDoctor } from "./doctor.js";
import { messageActionTargetAliases } from "./message-action-contract.js";
import { resolveFeishuGroupToolPolicy } from "./policy.js";
import { buildFeishuPresentationCard } from "./presentation-card.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { collectFeishuSecurityAuditFindings } from "./security-audit-shared.js";
import "./security-audit.js";
import { createFeishuSendReceipt } from "./send-result.js";
import { resolveFeishuSessionConversation } from "./session-conversation.js";
import { resolveFeishuOutboundSessionRoute } from "./session-route.js";
import { feishuSetupAdapter } from "./setup-core.js";
import { feishuSetupWizard, runFeishuLogin } from "./setup-surface.js";
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { adaptScopedAccountAccessor, createHybridChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createRuntimeOutboundDelegates, defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderGroupPolicyWarningCollector, projectConfigAccountIdWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createChannelDirectoryAdapter, createRuntimeDirectoryLiveAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/channel.ts
function readFeishuMediaParam(params) {
	const media = params.media;
	if (typeof media !== "string") return;
	return media.trim() ? media : void 0;
}
function readBooleanParam(params, keys) {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "boolean") return value;
	}
}
function hasLegacyFeishuCardCommandValue(actionValue) {
	return isRecord$1(actionValue) && actionValue.oc !== "ocf1" && (Boolean(typeof actionValue.command === "string" && actionValue.command.trim()) || Boolean(typeof actionValue.text === "string" && actionValue.text.trim()));
}
function containsLegacyFeishuCardCommandValue(node) {
	if (Array.isArray(node)) return node.some((item) => containsLegacyFeishuCardCommandValue(item));
	if (!isRecord$1(node)) return false;
	if (node.tag === "button" && hasLegacyFeishuCardCommandValue(node.value)) return true;
	if (node.tag === "button" && Array.isArray(node.behaviors) && node.behaviors.some((behavior) => isRecord$1(behavior) && hasLegacyFeishuCardCommandValue(behavior.value))) return true;
	return Object.values(node).some((value) => containsLegacyFeishuCardCommandValue(value));
}
const meta = {
	id: "feishu",
	label: "Feishu",
	selectionLabel: "Feishu/Lark (飞书)",
	docsPath: "/channels/feishu",
	docsLabel: "feishu",
	blurb: "飞书/Lark enterprise messaging.",
	aliases: ["lark"],
	order: 70,
	preferSessionLookupForAnnounceTarget: true
};
const loadFeishuChannelRuntime = createLazyRuntimeNamedExport(() => import("./channel.runtime.js"), "feishuChannelRuntime");
function toFeishuMessageSendResult(result, kind) {
	const receipt = result.receipt ?? createFeishuSendReceipt({
		messageId: result.messageId,
		chatId: result.chatId ?? "",
		kind
	});
	return {
		messageId: result.messageId || receipt.primaryPlatformMessageId,
		receipt
	};
}
const feishuMessageAdapter = defineChannelMessageAdapter({
	id: "feishu",
	durableFinal: { capabilities: {
		text: true,
		media: true
	} },
	send: {
		text: async (ctx) => {
			const sendText = (await loadFeishuChannelRuntime()).feishuOutbound.sendText;
			if (!sendText) throw new Error("Feishu text sending is not available.");
			return toFeishuMessageSendResult(await sendText(ctx), "text");
		},
		media: async (ctx) => {
			const sendMedia = (await loadFeishuChannelRuntime()).feishuOutbound.sendMedia;
			if (!sendMedia) throw new Error("Feishu media sending is not available.");
			return toFeishuMessageSendResult(await sendMedia(ctx), "media");
		}
	}
});
async function createFeishuActionClient(account) {
	const { createFeishuClient } = await import("./client.js");
	return createFeishuClient(account);
}
const collectFeishuSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector({
	providerConfigPresent: (cfg) => cfg.channels?.feishu !== void 0,
	resolveGroupPolicy: ({ cfg, accountId }) => resolveFeishuAccount({
		cfg,
		accountId
	}).config?.groupPolicy,
	collect: ({ cfg, accountId, groupPolicy }) => {
		if (groupPolicy !== "open") return [];
		return [`- Feishu[${resolveFeishuAccount({
			cfg,
			accountId
		}).accountId}] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.feishu.groupPolicy="allowlist" + channels.feishu.groupAllowFrom to restrict senders.`];
	}
});
function describeFeishuMessageTool({ cfg, accountId }) {
	const enabledAccounts = accountId ? [resolveFeishuAccount({
		cfg,
		accountId
	})].filter((account) => account.enabled && account.configured) : listEnabledFeishuAccounts(cfg);
	const enabled = enabledAccounts.length > 0 || !accountId && cfg.channels?.feishu?.enabled !== false && Boolean(inspectFeishuCredentials(cfg.channels?.feishu));
	if (enabledAccounts.length === 0) return {
		actions: [],
		capabilities: enabled ? ["presentation"] : []
	};
	const actions = /* @__PURE__ */ new Set([
		"send",
		"read",
		"edit",
		"thread-reply",
		"pin",
		"list-pins",
		"unpin",
		"member-info",
		"channel-info",
		"channel-list"
	]);
	if (accountId ? enabledAccounts.some((account) => isFeishuReactionsActionEnabled({
		cfg,
		account
	})) : areAnyFeishuReactionActionsEnabled(cfg)) {
		actions.add("react");
		actions.add("reactions");
	}
	return {
		actions: Array.from(actions),
		capabilities: enabled ? ["presentation"] : []
	};
}
function setFeishuNamedAccountEnabled(cfg, accountId, enabled) {
	const feishuCfg = cfg.channels?.feishu;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			feishu: {
				...feishuCfg,
				accounts: {
					...feishuCfg?.accounts,
					[accountId]: {
						...feishuCfg?.accounts?.[accountId],
						enabled
					}
				}
			}
		}
	};
}
const feishuConfigAdapter = createHybridChannelConfigAdapter({
	sectionKey: "feishu",
	listAccountIds: listFeishuAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveFeishuAccount),
	defaultAccountId: resolveDefaultFeishuAccountId,
	clearBaseFields: [],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom })
});
function isFeishuReactionsActionEnabled(params) {
	if (!params.account.enabled || !params.account.configured) return false;
	return createActionGate(params.account.config.actions ?? (params.cfg.channels?.feishu)?.actions)("reactions");
}
function areAnyFeishuReactionActionsEnabled(cfg) {
	for (const account of listEnabledFeishuAccounts(cfg)) if (isFeishuReactionsActionEnabled({
		cfg,
		account
	})) return true;
	return false;
}
function isFeishuGroupTopicSessionKey(sessionKey) {
	if (typeof sessionKey !== "string" || !sessionKey) return false;
	const parsed = parseFeishuConversationId({ conversationId: sessionKey });
	return parsed?.scope === "group_topic" || parsed?.scope === "group_topic_sender";
}
function resolveFeishuTopicAutoThreadAnchor(ctx) {
	if (ctx.action !== "send") return;
	if (!isFeishuGroupTopicSessionKey(ctx.sessionKey)) return;
	const inbound = ctx.toolContext?.currentMessageId;
	return typeof inbound === "string" && inbound.length > 0 ? inbound : void 0;
}
function buildFeishuSendReplyAnchor(ctx) {
	if (ctx.action === "thread-reply") return {
		replyToMessageId: resolveFeishuMessageId(ctx.params),
		replyInThread: true
	};
	const autoThreadId = resolveFeishuTopicAutoThreadAnchor(ctx);
	return {
		replyToMessageId: autoThreadId,
		replyInThread: autoThreadId !== void 0
	};
}
function isSupportedFeishuDirectConversationId(conversationId) {
	const trimmed = conversationId.trim();
	if (!trimmed || trimmed.includes(":")) return false;
	if (trimmed.startsWith("oc_") || trimmed.startsWith("on_")) return false;
	return true;
}
function normalizeFeishuAcpConversationId(conversationId) {
	const parsed = parseFeishuConversationId({ conversationId });
	if (!parsed || parsed.scope !== "group_topic" && parsed.scope !== "group_topic_sender" && !isSupportedFeishuDirectConversationId(parsed.canonicalConversationId)) return null;
	return {
		conversationId: parsed.canonicalConversationId,
		parentConversationId: parsed.scope === "group_topic" || parsed.scope === "group_topic_sender" ? parsed.chatId : void 0
	};
}
function matchFeishuAcpConversation(params) {
	const binding = normalizeFeishuAcpConversationId(params.bindingConversationId);
	if (!binding) return null;
	const incoming = parseFeishuConversationId({
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (!incoming || incoming.scope !== "group_topic" && incoming.scope !== "group_topic_sender" && !isSupportedFeishuDirectConversationId(incoming.canonicalConversationId)) return null;
	const matchesCanonicalConversation = binding.conversationId === incoming.canonicalConversationId;
	const matchesParentTopicForSenderScopedConversation = incoming.scope === "group_topic_sender" && binding.parentConversationId === incoming.chatId && binding.conversationId === `${incoming.chatId}:topic:${incoming.topicId}`;
	if (!matchesCanonicalConversation && !matchesParentTopicForSenderScopedConversation) return null;
	return {
		conversationId: matchesParentTopicForSenderScopedConversation ? binding.conversationId : incoming.canonicalConversationId,
		parentConversationId: incoming.scope === "group_topic" || incoming.scope === "group_topic_sender" ? incoming.chatId : void 0,
		matchPriority: matchesCanonicalConversation ? 2 : 1
	};
}
function resolveFeishuSenderScopedCommandConversation(params) {
	const parentConversationId = params.parentConversationId?.trim();
	const threadId = params.threadId?.trim();
	const senderId = params.senderId?.trim();
	if (!parentConversationId || !threadId || !senderId) return;
	const expectedScopePrefix = `feishu:group:${normalizeLowercaseStringOrEmpty(parentConversationId)}:topic:${normalizeLowercaseStringOrEmpty(threadId)}:sender:`;
	const isSenderScopedSession = [params.sessionKey, params.parentSessionKey].some((candidate) => {
		const normalized = normalizeLowercaseStringOrEmpty(candidate ?? "");
		if (!normalized) return false;
		return normalized.replace(/^agent:[^:]+:/, "").startsWith(expectedScopePrefix);
	});
	const senderScopedConversationId = buildFeishuConversationId({
		chatId: parentConversationId,
		scope: "group_topic_sender",
		topicId: threadId,
		senderOpenId: senderId
	});
	if (isSenderScopedSession) return senderScopedConversationId;
	if (!params.sessionKey?.trim()) return;
	return getSessionBindingService().listBySession(params.sessionKey).find((binding) => {
		if (binding.conversation.channel !== "feishu" || binding.conversation.accountId !== params.accountId) return false;
		return binding.conversation.conversationId === senderScopedConversationId;
	})?.conversation.conversationId;
}
function resolveFeishuCommandConversation(params) {
	if (params.threadId) {
		const parentConversationId = parseFeishuTargetId(params.originatingTo) ?? parseFeishuTargetId(params.commandTo) ?? parseFeishuTargetId(params.fallbackTo);
		if (!parentConversationId) return null;
		return {
			conversationId: resolveFeishuSenderScopedCommandConversation({
				accountId: params.accountId,
				parentConversationId,
				threadId: params.threadId,
				senderId: params.senderId,
				sessionKey: params.sessionKey,
				parentSessionKey: params.parentSessionKey
			}) ?? buildFeishuConversationId({
				chatId: parentConversationId,
				scope: "group_topic",
				topicId: params.threadId
			}),
			parentConversationId
		};
	}
	const conversationId = parseFeishuDirectConversationId(params.originatingTo) ?? parseFeishuDirectConversationId(params.commandTo) ?? parseFeishuDirectConversationId(params.fallbackTo);
	return conversationId ? { conversationId } : null;
}
function jsonActionResult(details) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(details)
		}],
		details
	};
}
function readFirstString(params, keys, fallback) {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
}
function readOptionalPositiveInteger(params, keys) {
	for (const key of keys) {
		const parsed = parseStrictPositiveInteger(params[key]);
		if (parsed !== void 0) return parsed;
	}
}
function resolveFeishuActionTarget(ctx) {
	return readFirstString(ctx.params, ["to", "target"], ctx.toolContext?.currentChannelId);
}
function resolveFeishuChatId(ctx) {
	const raw = readFirstString(ctx.params, [
		"chatId",
		"chat_id",
		"channelId",
		"channel_id",
		"to",
		"target"
	], ctx.toolContext?.currentChannelId);
	if (!raw) return;
	if (/^(user|dm|open_id):/i.test(raw)) return;
	if (/^(chat|group|channel):/i.test(raw)) return normalizeFeishuTarget(raw) ?? void 0;
	return raw;
}
function resolveFeishuMessageId(params) {
	return readFirstString(params, [
		"messageId",
		"message_id",
		"replyTo",
		"reply_to"
	]);
}
function resolveFeishuMemberId(params) {
	return readFirstString(params, [
		"memberId",
		"member_id",
		"userId",
		"user_id",
		"openId",
		"open_id",
		"unionId",
		"union_id"
	]);
}
function resolveFeishuMemberIdType(params) {
	const raw = readFirstString(params, [
		"memberIdType",
		"member_id_type",
		"userIdType",
		"user_id_type"
	]);
	if (raw === "open_id" || raw === "user_id" || raw === "union_id") return raw;
	if (readFirstString(params, ["userId", "user_id"]) && !readFirstString(params, [
		"openId",
		"open_id",
		"unionId",
		"union_id"
	])) return "user_id";
	if (readFirstString(params, ["unionId", "union_id"]) && !readFirstString(params, ["openId", "open_id"])) return "union_id";
	return "open_id";
}
const feishuPlugin = createChatChannelPlugin({
	base: {
		id: "feishu",
		meta: { ...meta },
		capabilities: {
			chatTypes: ["direct", "channel"],
			polls: false,
			threads: true,
			media: true,
			tts: { voice: {
				synthesisTarget: "voice-note",
				transcodesAudio: true
			} },
			reactions: true,
			edit: true,
			reply: true
		},
		agentPrompt: { messageToolHints: () => [
			"- Feishu targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:open_id` or `chat:chat_id`.",
			"- Feishu supports interactive cards plus native image, file, audio, and video/media delivery.",
			"- Feishu supports `send`, `read`, `edit`, `thread-reply`, pins, and channel/member lookup, plus reactions when enabled."
		] },
		groups: { resolveToolPolicy: resolveFeishuGroupToolPolicy },
		conversationBindings: {
			defaultTopLevelPlacement: "current",
			buildModelOverrideParentCandidates: ({ parentConversationId }) => buildFeishuModelOverrideParentCandidates(parentConversationId)
		},
		mentions: { stripPatterns: () => ["<at user_id=\"[^\"]*\">[^<]*</at>"] },
		reload: { configPrefixes: ["channels.feishu"] },
		doctor: feishuDoctor,
		configSchema: buildChannelConfigSchema(FeishuConfigSchema),
		config: {
			...feishuConfigAdapter,
			setAccountEnabled: ({ cfg, accountId, enabled }) => {
				if (accountId === DEFAULT_ACCOUNT_ID) return {
					...cfg,
					channels: {
						...cfg.channels,
						feishu: {
							...cfg.channels?.feishu,
							enabled
						}
					}
				};
				return setFeishuNamedAccountEnabled(cfg, accountId, enabled);
			},
			deleteAccount: ({ cfg, accountId }) => {
				if (accountId === DEFAULT_ACCOUNT_ID) {
					const next = { ...cfg };
					const nextChannels = { ...cfg.channels };
					delete nextChannels.feishu;
					if (Object.keys(nextChannels).length > 0) next.channels = nextChannels;
					else delete next.channels;
					return next;
				}
				const feishuCfg = cfg.channels?.feishu;
				const accounts = { ...feishuCfg?.accounts };
				delete accounts[accountId];
				return {
					...cfg,
					channels: {
						...cfg.channels,
						feishu: {
							...feishuCfg,
							accounts: Object.keys(accounts).length > 0 ? accounts : void 0
						}
					}
				};
			},
			isConfigured: (account) => account.configured,
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: account.configured,
				extra: {
					appId: account.appId,
					domain: account.domain
				}
			})
		},
		approvalCapability: feishuApprovalAuth,
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		},
		actions: {
			messageActionTargetAliases,
			describeMessageTool: describeFeishuMessageTool,
			handleAction: async (ctx) => {
				const account = resolveFeishuAccount({
					cfg: ctx.cfg,
					accountId: ctx.accountId ?? void 0
				});
				if ((ctx.action === "react" || ctx.action === "reactions") && !isFeishuReactionsActionEnabled({
					cfg: ctx.cfg,
					account
				})) throw new Error("Feishu reactions are disabled via actions.reactions.");
				if (ctx.action === "send" || ctx.action === "thread-reply") {
					const to = resolveFeishuActionTarget(ctx);
					if (!to) throw new Error(`Feishu ${ctx.action} requires a target (to).`);
					const { replyToMessageId, replyInThread } = buildFeishuSendReplyAnchor(ctx);
					if (ctx.action === "thread-reply" && !replyToMessageId) throw new Error("Feishu thread-reply requires messageId.");
					const presentation = normalizeMessagePresentation(ctx.params.presentation);
					const text = readFirstString(ctx.params, ["text", "message"]);
					const mediaUrl = readFeishuMediaParam(ctx.params);
					const audioAsVoice = readBooleanParam(ctx.params, ["asVoice", "audioAsVoice"]);
					const card = presentation ? buildFeishuPresentationCard({
						presentation,
						fallbackText: text
					}) : void 0;
					if (card && mediaUrl) throw new Error(`Feishu ${ctx.action} does not support card with media.`);
					if (!card && !text && !mediaUrl) throw new Error(`Feishu ${ctx.action} requires text/message, media, or card.`);
					const runtime = await loadFeishuChannelRuntime();
					const maybeSendMedia = runtime.feishuOutbound.sendMedia;
					if (mediaUrl && !maybeSendMedia) throw new Error("Feishu media sending is not available.");
					const sendMedia = maybeSendMedia;
					let result;
					if (card) {
						if (containsLegacyFeishuCardCommandValue(card)) throw new Error("Feishu card buttons that trigger text or commands must use structured interaction envelopes.");
						result = await runtime.sendCardFeishu({
							cfg: ctx.cfg,
							to,
							card,
							accountId: ctx.accountId ?? void 0,
							replyToMessageId,
							replyInThread
						});
					} else if (mediaUrl) result = await sendMedia({
						cfg: ctx.cfg,
						to,
						text: text ?? "",
						mediaUrl,
						accountId: ctx.accountId ?? void 0,
						mediaLocalRoots: ctx.mediaLocalRoots,
						...replyInThread ? { threadId: replyToMessageId } : { replyToId: replyToMessageId },
						...audioAsVoice === true ? { audioAsVoice: true } : {}
					});
					else result = await runtime.sendMessageFeishu({
						cfg: ctx.cfg,
						to,
						text,
						accountId: ctx.accountId ?? void 0,
						replyToMessageId,
						replyInThread
					});
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: ctx.action,
						...result
					});
				}
				if (ctx.action === "read") {
					const messageId = resolveFeishuMessageId(ctx.params);
					if (!messageId) throw new Error("Feishu read requires messageId.");
					const { getMessageFeishu } = await loadFeishuChannelRuntime();
					const message = await getMessageFeishu({
						cfg: ctx.cfg,
						messageId,
						accountId: ctx.accountId ?? void 0
					});
					if (!message) return {
						isError: true,
						content: [{
							type: "text",
							text: JSON.stringify({ error: `Feishu read failed or message not found: ${messageId}` })
						}],
						details: { error: `Feishu read failed or message not found: ${messageId}` }
					};
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "read",
						message
					});
				}
				if (ctx.action === "edit") {
					const messageId = resolveFeishuMessageId(ctx.params);
					if (!messageId) throw new Error("Feishu edit requires messageId.");
					const text = readFirstString(ctx.params, ["text", "message"]);
					const card = ctx.params.card && typeof ctx.params.card === "object" ? ctx.params.card : void 0;
					const { editMessageFeishu } = await loadFeishuChannelRuntime();
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "edit",
						...await editMessageFeishu({
							cfg: ctx.cfg,
							messageId,
							text,
							card,
							accountId: ctx.accountId ?? void 0
						})
					});
				}
				if (ctx.action === "pin") {
					const messageId = resolveFeishuMessageId(ctx.params);
					if (!messageId) throw new Error("Feishu pin requires messageId.");
					const { createPinFeishu } = await loadFeishuChannelRuntime();
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "pin",
						pin: await createPinFeishu({
							cfg: ctx.cfg,
							messageId,
							accountId: ctx.accountId ?? void 0
						})
					});
				}
				if (ctx.action === "unpin") {
					const messageId = resolveFeishuMessageId(ctx.params);
					if (!messageId) throw new Error("Feishu unpin requires messageId.");
					const { removePinFeishu } = await loadFeishuChannelRuntime();
					await removePinFeishu({
						cfg: ctx.cfg,
						messageId,
						accountId: ctx.accountId ?? void 0
					});
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "unpin",
						messageId
					});
				}
				if (ctx.action === "list-pins") {
					const chatId = resolveFeishuChatId(ctx);
					if (!chatId) throw new Error("Feishu list-pins requires chatId or channelId.");
					const { listPinsFeishu } = await loadFeishuChannelRuntime();
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "list-pins",
						...await listPinsFeishu({
							cfg: ctx.cfg,
							chatId,
							startTime: readFirstString(ctx.params, ["startTime", "start_time"]),
							endTime: readFirstString(ctx.params, ["endTime", "end_time"]),
							pageSize: readOptionalPositiveInteger(ctx.params, ["pageSize", "page_size"]),
							pageToken: readFirstString(ctx.params, ["pageToken", "page_token"]),
							accountId: ctx.accountId ?? void 0
						})
					});
				}
				if (ctx.action === "channel-info") {
					const chatId = resolveFeishuChatId(ctx);
					if (!chatId) throw new Error("Feishu channel-info requires chatId or channelId.");
					const runtime = await loadFeishuChannelRuntime();
					const client = await createFeishuActionClient(account);
					const channel = await runtime.getChatInfo(client, chatId);
					if (!(ctx.params.includeMembers === true || ctx.params.members === true)) return jsonActionResult({
						ok: true,
						provider: "feishu",
						action: "channel-info",
						channel
					});
					return jsonActionResult({
						ok: true,
						provider: "feishu",
						action: "channel-info",
						channel,
						members: await runtime.getChatMembers(client, chatId, readOptionalPositiveInteger(ctx.params, ["pageSize", "page_size"]), readFirstString(ctx.params, ["pageToken", "page_token"]), resolveFeishuMemberIdType(ctx.params))
					});
				}
				if (ctx.action === "member-info") {
					const runtime = await loadFeishuChannelRuntime();
					const client = await createFeishuActionClient(account);
					const memberId = resolveFeishuMemberId(ctx.params);
					if (memberId) return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "member-info",
						member: await runtime.getFeishuMemberInfo(client, memberId, resolveFeishuMemberIdType(ctx.params))
					});
					const chatId = resolveFeishuChatId(ctx);
					if (!chatId) throw new Error("Feishu member-info requires memberId or chatId/channelId.");
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "member-info",
						...await runtime.getChatMembers(client, chatId, readOptionalPositiveInteger(ctx.params, ["pageSize", "page_size"]), readFirstString(ctx.params, ["pageToken", "page_token"]), resolveFeishuMemberIdType(ctx.params))
					});
				}
				if (ctx.action === "channel-list") {
					const runtime = await loadFeishuChannelRuntime();
					const query = readFirstString(ctx.params, ["query"]);
					const limit = readOptionalPositiveInteger(ctx.params, ["limit"]);
					const scope = readFirstString(ctx.params, ["scope", "kind"]) ?? "all";
					if (scope === "groups" || scope === "group" || scope === "channels" || scope === "channel") return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "channel-list",
						groups: await runtime.listFeishuDirectoryGroupsLive({
							cfg: ctx.cfg,
							query,
							limit,
							fallbackToStatic: false,
							accountId: ctx.accountId ?? void 0
						})
					});
					if (scope === "peers" || scope === "peer" || scope === "members" || scope === "member" || scope === "users" || scope === "user") return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "channel-list",
						peers: await runtime.listFeishuDirectoryPeersLive({
							cfg: ctx.cfg,
							query,
							limit,
							fallbackToStatic: false,
							accountId: ctx.accountId ?? void 0
						})
					});
					const [groups, peers] = await Promise.all([runtime.listFeishuDirectoryGroupsLive({
						cfg: ctx.cfg,
						query,
						limit,
						fallbackToStatic: false,
						accountId: ctx.accountId ?? void 0
					}), runtime.listFeishuDirectoryPeersLive({
						cfg: ctx.cfg,
						query,
						limit,
						fallbackToStatic: false,
						accountId: ctx.accountId ?? void 0
					})]);
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "channel-list",
						groups,
						peers
					});
				}
				if (ctx.action === "react") {
					const messageId = resolveFeishuMessageId(ctx.params);
					if (!messageId) throw new Error("Feishu reaction requires messageId.");
					const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
					const remove = ctx.params.remove === true;
					const clearAll = ctx.params.clearAll === true;
					if (remove) {
						if (!emoji) throw new Error("Emoji is required to remove a Feishu reaction.");
						const { listReactionsFeishu, removeReactionFeishu } = await loadFeishuChannelRuntime();
						const ownReaction = (await listReactionsFeishu({
							cfg: ctx.cfg,
							messageId,
							emojiType: emoji,
							accountId: ctx.accountId ?? void 0
						})).find((entry) => entry.operatorType === "app");
						if (!ownReaction) return jsonActionResult({
							ok: true,
							removed: null
						});
						await removeReactionFeishu({
							cfg: ctx.cfg,
							messageId,
							reactionId: ownReaction.reactionId,
							accountId: ctx.accountId ?? void 0
						});
						return jsonActionResult({
							ok: true,
							removed: emoji
						});
					}
					if (!emoji) {
						if (!clearAll) throw new Error("Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.");
						const { listReactionsFeishu, removeReactionFeishu } = await loadFeishuChannelRuntime();
						const reactions = await listReactionsFeishu({
							cfg: ctx.cfg,
							messageId,
							accountId: ctx.accountId ?? void 0
						});
						let removed = 0;
						for (const reaction of reactions.filter((entry) => entry.operatorType === "app")) {
							await removeReactionFeishu({
								cfg: ctx.cfg,
								messageId,
								reactionId: reaction.reactionId,
								accountId: ctx.accountId ?? void 0
							});
							removed += 1;
						}
						return jsonActionResult({
							ok: true,
							removed
						});
					}
					const { addReactionFeishu } = await loadFeishuChannelRuntime();
					await addReactionFeishu({
						cfg: ctx.cfg,
						messageId,
						emojiType: emoji,
						accountId: ctx.accountId ?? void 0
					});
					return jsonActionResult({
						ok: true,
						added: emoji
					});
				}
				if (ctx.action === "reactions") {
					const messageId = resolveFeishuMessageId(ctx.params);
					if (!messageId) throw new Error("Feishu reactions lookup requires messageId.");
					const { listReactionsFeishu } = await loadFeishuChannelRuntime();
					return jsonActionResult({
						ok: true,
						reactions: await listReactionsFeishu({
							cfg: ctx.cfg,
							messageId,
							accountId: ctx.accountId ?? void 0
						})
					});
				}
				throw new Error(`Unsupported Feishu action: "${ctx.action}"`);
			}
		},
		bindings: {
			compileConfiguredBinding: ({ conversationId }) => normalizeFeishuAcpConversationId(conversationId),
			matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => matchFeishuAcpConversation({
				bindingConversationId: compiledBinding.conversationId,
				conversationId,
				parentConversationId
			}),
			resolveCommandConversation: ({ accountId, threadId, senderId, sessionKey, parentSessionKey, originatingTo, commandTo, fallbackTo }) => resolveFeishuCommandConversation({
				accountId,
				threadId,
				senderId,
				sessionKey,
				parentSessionKey,
				originatingTo,
				commandTo,
				fallbackTo
			})
		},
		auth: { login: async ({ cfg }) => {
			const { createClackPrompter } = await import("openclaw/plugin-sdk/setup-runtime");
			const { replaceConfigFile } = await import("openclaw/plugin-sdk/config-mutation");
			const nextCfg = await runFeishuLogin({
				cfg,
				prompter: createClackPrompter()
			});
			if (nextCfg !== cfg) await replaceConfigFile({
				nextConfig: nextCfg,
				afterWrite: { mode: "auto" }
			});
		} },
		setup: feishuSetupAdapter,
		setupWizard: feishuSetupWizard,
		messaging: {
			targetPrefixes: ["feishu", "lark"],
			normalizeTarget: (raw) => normalizeFeishuTarget(raw) ?? void 0,
			resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {
				const directId = parseFeishuDirectConversationId(conversationId);
				if (directId) return { to: `user:${directId}` };
				const parsed = parseFeishuConversationId({
					conversationId,
					parentConversationId
				});
				if (parsed?.topicId) return {
					to: `chat:${parentConversationId?.trim() || parsed.chatId}`,
					threadId: parsed.topicId
				};
				return { to: `chat:${parsed?.chatId ?? conversationId.trim()}` };
			},
			resolveSessionConversation: ({ kind, rawId }) => resolveFeishuSessionConversation({
				kind,
				rawId
			}),
			resolveOutboundSessionRoute: (params) => resolveFeishuOutboundSessionRoute(params),
			targetResolver: {
				looksLikeId: looksLikeFeishuId,
				hint: "<chatId|user:openId|chat:chatId>"
			}
		},
		directory: createChannelDirectoryAdapter({
			listPeers: async ({ cfg, query, limit, accountId }) => listFeishuDirectoryPeers({
				cfg,
				query: query ?? void 0,
				limit: limit ?? void 0,
				accountId: accountId ?? void 0
			}),
			listGroups: async ({ cfg, query, limit, accountId }) => listFeishuDirectoryGroups({
				cfg,
				query: query ?? void 0,
				limit: limit ?? void 0,
				accountId: accountId ?? void 0
			}),
			...createRuntimeDirectoryLiveAdapter({
				getRuntime: loadFeishuChannelRuntime,
				listPeersLive: (runtime) => async ({ cfg, query, limit, accountId }) => await runtime.listFeishuDirectoryPeersLive({
					cfg,
					query: query ?? void 0,
					limit: limit ?? void 0,
					accountId: accountId ?? void 0
				}),
				listGroupsLive: (runtime) => async ({ cfg, query, limit, accountId }) => await runtime.listFeishuDirectoryGroupsLive({
					cfg,
					query: query ?? void 0,
					limit: limit ?? void 0,
					accountId: accountId ?? void 0
				})
			})
		}),
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
			buildChannelSummary: ({ snapshot }) => buildProbeChannelStatusSummary(snapshot, { port: snapshot.port ?? null }),
			probeAccount: async ({ account }) => await (await loadFeishuChannelRuntime()).probeFeishu(account),
			resolveAccountSnapshot: ({ account, runtime }) => ({
				accountId: account.accountId,
				enabled: account.enabled,
				configured: account.configured,
				name: account.name,
				extra: {
					appId: account.appId,
					domain: account.domain,
					port: runtime?.port ?? null
				}
			})
		}),
		gateway: { startAccount: async (ctx) => {
			const { monitorFeishuProvider } = await import("./monitor.js");
			const account = resolveFeishuRuntimeAccount({
				cfg: ctx.cfg,
				accountId: ctx.accountId
			}, { requireEventSecrets: true });
			const port = account.config?.webhookPort ?? null;
			ctx.setStatus({
				accountId: ctx.accountId,
				port
			});
			ctx.log?.info(`starting feishu[${ctx.accountId}] (mode: ${account.config?.connectionMode ?? "websocket"})`);
			return monitorFeishuProvider({
				config: ctx.cfg,
				runtime: ctx.runtime,
				channelRuntime: ctx.channelRuntime,
				abortSignal: ctx.abortSignal,
				accountId: ctx.accountId
			});
		} },
		message: feishuMessageAdapter
	},
	security: {
		collectWarnings: projectConfigAccountIdWarningCollector(collectFeishuSecurityWarnings),
		collectAuditFindings: ({ cfg }) => collectFeishuSecurityAuditFindings({ cfg })
	},
	pairing: { text: {
		idLabel: "feishuUserId",
		message: PAIRING_APPROVED_MESSAGE,
		normalizeAllowEntry: createPairingPrefixStripper(/^(feishu|user|open_id):/i),
		notify: async ({ cfg, id, message, accountId }) => {
			const { sendMessageFeishu } = await loadFeishuChannelRuntime();
			await sendMessageFeishu({
				cfg,
				to: id,
				text: message,
				accountId
			});
		}
	} },
	outbound: {
		deliveryMode: "direct",
		chunker: chunkTextForOutbound,
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		presentationCapabilities: {
			supported: true,
			buttons: true,
			selects: false,
			context: true,
			divider: true,
			limits: {
				actions: {
					maxActions: 20,
					maxActionsPerRow: 5,
					maxLabelLength: 40,
					maxValueBytes: 1024
				},
				text: {
					maxLength: 4e3,
					encoding: "characters",
					markdownDialect: "markdown"
				}
			}
		},
		renderPresentation: async (ctx) => {
			const renderPresentation = (await loadFeishuChannelRuntime()).feishuOutbound.renderPresentation;
			return renderPresentation ? await renderPresentation(ctx) : null;
		},
		sendPayload: async (ctx) => {
			const sendPayload = (await loadFeishuChannelRuntime()).feishuOutbound.sendPayload;
			if (!sendPayload) throw new Error("Feishu payload sending is not available.");
			return await sendPayload(ctx);
		},
		...createRuntimeOutboundDelegates({
			getRuntime: loadFeishuChannelRuntime,
			sendText: { resolve: (runtime) => runtime.feishuOutbound.sendText },
			sendMedia: { resolve: (runtime) => runtime.feishuOutbound.sendMedia }
		})
	}
});
//#endregion
export { feishuPlugin };
