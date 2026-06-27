import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { hasExplicitFeishuGroupConfig, normalizeFeishuAllowEntry, resolveFeishuDmIngressAccess, resolveFeishuGroupConfig, resolveFeishuGroupConversationIngressAccess, resolveFeishuGroupSenderActivationIngressAccess, resolveFeishuReplyPolicy } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import { createFeishuClient } from "./client.js";
import { getChatInfo } from "./chat.js";
import { evaluateSupplementalContextVisibility, normalizeAgentId as normalizeAgentId$1, resolveChannelContextVisibilityMode } from "../runtime-api.js";
import { isFeishuGroupChatType } from "./types.js";
import { extractMentionTargets, isMentionForwardRequest } from "./mention.js";
import { checkBotMentioned, isFeishuTopicSessionScope, normalizeFeishuCommandProbeBody, normalizeMentions, parseMergeForwardContent, parseMessageContent, resolveConfiguredFeishuGroupSessionScope, resolveFeishuGroupSession, resolveFeishuMediaList, toMessageResourceType } from "./bot-content.js";
import "./bot-runtime-api.js";
import { resolveFeishuSenderName } from "./bot-sender-name.js";
import { finalizeFeishuMessageProcessing, tryRecordMessagePersistent } from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";
import { getMessageFeishu, listFeishuThreadMessages, sendMessageFeishu } from "./send.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { ensureConfiguredBindingRouteReady, resolveConfiguredBindingRoute, resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { asDateTimestampMs, parseStrictNonNegativeInteger, resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { buildChannelInboundEventContext, toInboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { DEFAULT_GROUP_HISTORY_LIMIT, createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { resolveDefaultGroupPolicy, resolveOpenProviderRuntimeGroupPolicy, warnMissingProviderGroupPolicyFallbackOnce } from "openclaw/plugin-sdk/runtime-group-policy";
//#region src/bot.ts
const permissionErrorNotifiedAt = /* @__PURE__ */ new Map();
const PERMISSION_ERROR_COOLDOWN_MS = 300 * 1e3;
const groupNameCache = /* @__PURE__ */ new Map();
const GROUP_NAME_CACHE_TTL_MS = 1800 * 1e3;
const GROUP_NAME_CACHE_MAX_SIZE = 500;
function shouldSendNoVisibleReplyFallback(dispatchResult) {
	const finalCount = dispatchResult.counts.final ?? 0;
	const failedFinalCount = dispatchResult.failedCounts?.final ?? 0;
	const emptyEligibleDispatch = dispatchResult.noVisibleReplyFallbackEligible === true && dispatchResult.queuedFinal !== true && finalCount === 0;
	const queuedFinalFailed = dispatchResult.queuedFinal === true && failedFinalCount > 0;
	return dispatchResult.sendPolicyDenied !== true && dispatchResult.sourceReplyDeliveryMode !== "message_tool_only" && (emptyEligibleDispatch || queuedFinalFailed);
}
function evictGroupNameCache() {
	const now = asDateTimestampMs(Date.now());
	if (now === void 0) {
		groupNameCache.clear();
		return;
	}
	for (const [key, val] of groupNameCache) {
		const expiresAt = asDateTimestampMs(val.expiresAt);
		if (expiresAt === void 0 || expiresAt <= now) groupNameCache.delete(key);
	}
	if (groupNameCache.size > GROUP_NAME_CACHE_MAX_SIZE) {
		const excess = groupNameCache.size - GROUP_NAME_CACHE_MAX_SIZE;
		let removed = 0;
		for (const key of groupNameCache.keys()) {
			if (removed >= excess) break;
			groupNameCache.delete(key);
			removed++;
		}
	}
}
function setCacheEntry(key, name) {
	const expiresAt = resolveExpiresAtMsFromDurationMs(GROUP_NAME_CACHE_TTL_MS);
	groupNameCache.delete(key);
	if (expiresAt !== void 0) groupNameCache.set(key, {
		name,
		expiresAt
	});
}
function clearGroupNameCache() {
	groupNameCache.clear();
}
async function resolveGroupName(params) {
	const { account, chatId, log } = params;
	if (!account.configured) return;
	const cacheKey = `${account.accountId}:${chatId}`;
	const cached = groupNameCache.get(cacheKey);
	if (cached) {
		const now = asDateTimestampMs(Date.now());
		const expiresAt = asDateTimestampMs(cached.expiresAt);
		if (now !== void 0 && expiresAt !== void 0 && expiresAt > now) return cached.name || void 0;
		groupNameCache.delete(cacheKey);
	}
	let resolvedName;
	try {
		const name = (await getChatInfo(createFeishuClient(account), chatId))?.name?.trim();
		if (name) {
			setCacheEntry(cacheKey, name);
			resolvedName = name;
		} else setCacheEntry(cacheKey, "");
	} catch (err) {
		log(`feishu[${account.accountId}]: getChatInfo failed for ${chatId}: ${String(err)}`);
		setCacheEntry(cacheKey, "");
	}
	evictGroupNameCache();
	return resolvedName;
}
async function resolveFeishuAudioPreflightTranscript(params) {
	if (params.content.trim() !== "<media:audio>") return;
	const audioMedia = params.mediaList.filter((media) => media.contentType?.startsWith("audio/"));
	if (audioMedia.length === 0) return;
	try {
		const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
		return await transcribeFirstAudio({
			ctx: {
				MediaPaths: audioMedia.map((media) => media.path),
				MediaTypes: audioMedia.map((media) => media.contentType).filter(Boolean),
				ChatType: params.chatType
			},
			cfg: params.cfg
		});
	} catch (err) {
		params.log(`feishu: audio preflight transcription failed: ${String(err)}`);
		return;
	}
}
function resolveBroadcastAgents(cfg, peerId) {
	const broadcast = cfg.broadcast;
	if (!broadcast || typeof broadcast !== "object") return null;
	const agents = broadcast[peerId];
	if (!Array.isArray(agents) || agents.length === 0) return null;
	return agents;
}
function buildBroadcastSessionKey(baseSessionKey, originalAgentId, targetAgentId) {
	const prefix = `agent:${originalAgentId}:`;
	if (baseSessionKey.startsWith(prefix)) return `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`;
	return baseSessionKey;
}
/**
* Build media payload for inbound context.
* Similar to Discord's buildDiscordMediaPayload().
*/
function parseFeishuMessageEvent(event, botOpenId, _botName) {
	const rawContent = parseMessageContent(event.message.content, event.message.message_type);
	const mentionedBot = checkBotMentioned(event, botOpenId);
	const hasAnyMention = (event.message.mentions?.length ?? 0) > 0;
	const content = normalizeMentions(rawContent, event.message.mentions, botOpenId);
	const senderOpenId = event.sender.sender_id.open_id?.trim();
	const senderUserId = event.sender.sender_id.user_id?.trim();
	const senderFallbackId = senderOpenId || senderUserId || "";
	const ctx = {
		chatId: event.message.chat_id,
		messageId: event.message.message_id,
		replyTargetMessageId: event.message.reply_target_message_id?.trim() || void 0,
		typingTargetMessageId: event.message.typing_target_message_id?.trim() || void 0,
		suppressReplyTarget: event.message.suppress_reply_target === true,
		senderId: senderUserId || senderOpenId || "",
		senderOpenId: senderFallbackId,
		chatType: event.message.chat_type,
		mentionedBot,
		hasAnyMention,
		rootId: event.message.root_id || void 0,
		parentId: event.message.parent_id || void 0,
		threadId: event.message.thread_id || void 0,
		content,
		contentType: event.message.message_type
	};
	if (isMentionForwardRequest(event, botOpenId)) {
		const mentionTargets = extractMentionTargets(event, botOpenId);
		if (mentionTargets.length > 0) ctx.mentionTargets = mentionTargets;
	}
	return ctx;
}
const MAX_MENTION_CONTEXT_NAME_LENGTH = 80;
function formatMentionNameForAgentContext(name) {
	const normalized = Array.from(name, (char) => {
		return char.charCodeAt(0) < 32 || char === "[" || char === "]" ? " " : char;
	}).join("").replace(/\s+/g, " ").trim();
	const bounded = normalized.length > MAX_MENTION_CONTEXT_NAME_LENGTH ? `${normalized.slice(0, MAX_MENTION_CONTEXT_NAME_LENGTH - 3)}...` : normalized;
	return JSON.stringify(bounded || "unknown");
}
function buildFeishuAgentBody(params) {
	const { ctx, quotedContent, permissionErrorForAgent, botOpenId } = params;
	let messageBody = ctx.content;
	if (quotedContent) messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
	messageBody = `${ctx.senderName ?? ctx.senderOpenId}: ${messageBody}`;
	if (ctx.hasAnyMention) {
		const botIdHint = botOpenId?.trim();
		messageBody += "\n\n[System: The content may include mention tags in the form <at user_id=\"...\">name</at>. Treat these as real mentions of Feishu entities (users or bots).]";
		if (botIdHint) messageBody += `\n[System: If user_id is "${botIdHint}", that mention refers to you.]`;
	}
	if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
		const targetNames = ctx.mentionTargets.map((t) => formatMentionNameForAgentContext(t.name)).join(", ");
		messageBody += `\n\n[System: Feishu users mentioned in the incoming message, for context only: ${targetNames}. Do not notify or mention these users solely because they are listed here.]`;
	}
	messageBody = `[message_id: ${ctx.messageId}]\n${messageBody}`;
	if (permissionErrorForAgent) {
		const grantUrl = permissionErrorForAgent.grantUrl ?? "";
		messageBody += `\n\n[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;
	}
	return messageBody;
}
async function shouldIncludeFetchedGroupContextMessage(params) {
	let senderAllowed = !params.isGroup || params.allowFrom.length === 0 || params.senderType === "app";
	const senderId = params.senderId?.trim();
	if (!senderAllowed && senderId) senderAllowed = (await resolveFeishuGroupSenderActivationIngressAccess({
		cfg: params.cfg,
		accountId: params.accountId,
		chatId: params.chatId,
		allowFrom: params.allowFrom,
		senderOpenId: senderId,
		senderUserId: senderId,
		requireMention: false,
		mentionedBot: true
	})).senderAccess.decision === "allow";
	return evaluateSupplementalContextVisibility({
		mode: params.mode,
		kind: params.kind,
		senderAllowed
	}).include;
}
async function filterFetchedGroupContextMessages(messages, params) {
	return (await Promise.all(messages.map(async (message) => await shouldIncludeFetchedGroupContextMessage({
		cfg: params.cfg,
		accountId: params.accountId,
		chatId: params.chatId,
		isGroup: params.isGroup,
		allowFrom: params.allowFrom,
		mode: params.mode,
		kind: params.kind,
		senderId: message.senderId,
		senderType: message.senderType
	}) ? message : void 0))).filter((message) => message !== void 0);
}
async function handleFeishuMessage(params) {
	const { cfg, event, botOpenId, botName, runtime, channelRuntime, chatHistories, accountId, processingClaimHeld = false, messageDedupeKey: messageDedupeKeyOverride } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	const feishuCfg = account.config;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	const messageId = event.message.message_id;
	const messageDedupeKey = messageDedupeKeyOverride ?? resolveFeishuMessageDedupeKey(event);
	if (!await finalizeFeishuMessageProcessing({
		messageId: messageDedupeKey,
		namespace: account.accountId,
		log,
		claimHeld: processingClaimHeld
	})) {
		log(`feishu: skipping duplicate message ${messageId}`);
		return;
	}
	let ctx = parseFeishuMessageEvent(event, botOpenId, botName);
	const isGroup = isFeishuGroupChatType(ctx.chatType);
	const isDirect = !isGroup;
	const senderUserId = normalizeOptionalString(event.sender.sender_id.user_id);
	if (event.message.message_type === "merge_forward") {
		log(`feishu[${account.accountId}]: processing merge_forward message, fetching full content via API`);
		try {
			const response = await createFeishuClient(account).im.message.get({ path: { message_id: event.message.message_id } });
			if (response.code === 0 && response.data?.items && response.data.items.length > 0) {
				log(`feishu[${account.accountId}]: merge_forward API returned ${response.data.items.length} items`);
				const expandedContent = parseMergeForwardContent({
					content: JSON.stringify(response.data.items),
					log
				});
				ctx = {
					...ctx,
					content: expandedContent
				};
			} else {
				log(`feishu[${account.accountId}]: merge_forward API returned no items`);
				ctx = {
					...ctx,
					content: "[Merged and Forwarded Message - could not fetch]"
				};
			}
		} catch (err) {
			log(`feishu[${account.accountId}]: merge_forward fetch failed: ${String(err)}`);
			ctx = {
				...ctx,
				content: "[Merged and Forwarded Message - fetch error]"
			};
		}
	}
	let permissionErrorForAgent;
	if (feishuCfg?.resolveSenderNames ?? true) {
		const senderResult = await resolveFeishuSenderName({
			account,
			senderId: ctx.senderOpenId,
			log
		});
		if (senderResult.name) ctx = {
			...ctx,
			senderName: senderResult.name
		};
		if (senderResult.permissionError) {
			const appKey = account.appId ?? "default";
			const now = Date.now();
			if (now - (permissionErrorNotifiedAt.get(appKey) ?? 0) > PERMISSION_ERROR_COOLDOWN_MS) {
				permissionErrorNotifiedAt.set(appKey, now);
				permissionErrorForAgent = senderResult.permissionError;
			}
		}
	}
	log(`feishu[${account.accountId}]: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`);
	if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
		const names = ctx.mentionTargets.map((t) => t.name).join(", ");
		log(`feishu[${account.accountId}]: detected @ forward request, targets: [${names}]`);
	}
	const historyLimit = Math.max(0, feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT);
	const groupConfig = isGroup ? resolveFeishuGroupConfig({
		cfg: feishuCfg,
		groupId: ctx.chatId
	}) : void 0;
	const groupSessionScope = isGroup ? resolveConfiguredFeishuGroupSessionScope({
		groupConfig,
		feishuCfg,
		chatType: ctx.chatType
	}) : null;
	let effectiveThreadId = ctx.threadId;
	if (isGroup && ctx.chatType === "topic_group" && !effectiveThreadId && isFeishuTopicSessionScope(groupSessionScope ?? "group")) try {
		const hydratedThreadId = (await getMessageFeishu({
			cfg,
			accountId: account.accountId,
			messageId: ctx.messageId
		}))?.threadId?.trim();
		if (hydratedThreadId) {
			ctx = {
				...ctx,
				threadId: hydratedThreadId
			};
			effectiveThreadId = hydratedThreadId;
			log(`feishu[${account.accountId}]: hydrated topic thread_id=${hydratedThreadId} for message=${ctx.messageId}`);
		}
	} catch (err) {
		log(`feishu[${account.accountId}]: failed to hydrate topic thread_id for message=${ctx.messageId}: ${String(err)}`);
	}
	const effectiveGroupSenderAllowFrom = isGroup ? (groupConfig?.allowFrom?.length ?? 0) > 0 ? groupConfig?.allowFrom ?? [] : feishuCfg?.groupSenderAllowFrom ?? [] : [];
	const groupSession = isGroup ? resolveFeishuGroupSession({
		chatId: ctx.chatId,
		senderOpenId: ctx.senderOpenId,
		messageId: ctx.messageId,
		rootId: ctx.rootId,
		threadId: effectiveThreadId,
		chatType: ctx.chatType,
		groupConfig,
		feishuCfg
	}) : null;
	const groupHistoryKey = isGroup ? groupSession?.peerId ?? ctx.chatId : void 0;
	const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
	const configAllowFrom = feishuCfg?.allowFrom ?? [];
	const rawBroadcastAgents = isGroup ? resolveBroadcastAgents(cfg, ctx.chatId) : null;
	const broadcastAgents = rawBroadcastAgents ? uniqueStrings(rawBroadcastAgents.map((id) => normalizeAgentId$1(id))) : null;
	const messageCreateTimeMs = parseStrictNonNegativeInteger(event.message.create_time) ?? Date.now();
	let requireMention = false;
	if (isGroup) {
		if (groupConfig?.enabled === false) {
			log(`feishu[${account.accountId}]: group ${ctx.chatId} is disabled`);
			return;
		}
		const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
		const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
			providerConfigPresent: cfg.channels?.feishu !== void 0,
			groupPolicy: feishuCfg?.groupPolicy,
			defaultGroupPolicy
		});
		warnMissingProviderGroupPolicyFallbackOnce({
			providerMissingFallbackApplied,
			providerKey: "feishu",
			accountId: account.accountId,
			log
		});
		const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
		const groupExplicitlyConfigured = hasExplicitFeishuGroupConfig({
			cfg: feishuCfg,
			groupId: ctx.chatId
		});
		if ((await resolveFeishuGroupConversationIngressAccess({
			cfg,
			accountId: account.accountId,
			chatId: ctx.chatId,
			groupPolicy,
			groupAllowFrom,
			groupExplicitlyConfigured
		})).ingress.admission !== "dispatch") {
			log(`feishu[${account.accountId}]: group ${ctx.chatId} not in groupAllowFrom (groupPolicy=${groupPolicy})`);
			return;
		}
		({requireMention} = resolveFeishuReplyPolicy({
			isDirectMessage: false,
			cfg,
			accountId: account.accountId,
			groupId: ctx.chatId,
			groupPolicy
		}));
		const groupSenderActivationIngress = await resolveFeishuGroupSenderActivationIngressAccess({
			cfg,
			accountId: account.accountId,
			chatId: ctx.chatId,
			allowFrom: effectiveGroupSenderAllowFrom,
			senderOpenId: ctx.senderOpenId,
			senderUserId,
			requireMention,
			mentionedBot: ctx.mentionedBot
		});
		if (groupSenderActivationIngress.senderAccess.decision !== "allow") {
			log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
			return;
		}
		if (groupSenderActivationIngress.ingress.admission !== "dispatch") {
			log(`feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot`);
			if (!broadcastAgents && chatHistories && groupHistoryKey) createChannelHistoryWindow({ historyMap: chatHistories }).record({
				historyKey: groupHistoryKey,
				limit: historyLimit,
				entry: {
					sender: ctx.senderOpenId,
					body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
					timestamp: messageCreateTimeMs,
					messageId: ctx.messageId
				}
			});
			return;
		}
	}
	try {
		const core = { channel: channelRuntime?.inbound ? channelRuntime : getFeishuRuntime().channel };
		const pairing = createChannelPairingController({
			core,
			channel: "feishu",
			accountId: account.accountId
		});
		const commandProbeBody = isGroup ? normalizeFeishuCommandProbeBody(ctx.content) : ctx.content;
		const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(commandProbeBody, cfg);
		const resolveDirectAuthorization = async (candidateCfg, mayPair, shouldComputeCommand = core.channel.commands.shouldComputeCommandAuthorized(commandProbeBody, candidateCfg)) => {
			const candidateAccount = resolveFeishuRuntimeAccount({
				cfg: candidateCfg,
				accountId: account.accountId
			});
			const candidateDmPolicy = candidateAccount.config.dmPolicy ?? "pairing";
			const candidateConfigAllowFrom = candidateAccount.config.allowFrom ?? [];
			return {
				cfg: candidateCfg,
				dmPolicy: candidateDmPolicy,
				configAllowFrom: candidateConfigAllowFrom,
				ingress: await resolveFeishuDmIngressAccess({
					cfg: candidateCfg,
					accountId: candidateAccount.accountId,
					dmPolicy: candidateDmPolicy,
					allowFrom: candidateConfigAllowFrom,
					readAllowFromStore: pairing.readAllowFromStore,
					senderOpenId: ctx.senderOpenId,
					senderUserId,
					conversationId: ctx.senderOpenId,
					mayPair,
					...shouldComputeCommand ? { command: { hasControlCommand: true } } : {}
				}),
				shouldComputeCommandAuthorized: shouldComputeCommand
			};
		};
		const rejectDirectAuthorization = async (authorization) => {
			if (authorization.ingress.ingress.admission === "pairing-required") await pairing.issueChallenge({
				senderId: ctx.senderOpenId,
				senderIdLine: `Your Feishu user id: ${ctx.senderOpenId}`,
				meta: { name: ctx.senderName },
				onCreated: () => {
					log(`feishu[${account.accountId}]: pairing request sender=${ctx.senderOpenId}`);
				},
				sendPairingReply: async (text) => {
					await sendMessageFeishu({
						cfg: authorization.cfg,
						to: `chat:${ctx.chatId}`,
						text,
						accountId: account.accountId
					});
				},
				onReplyError: (err) => {
					log(`feishu[${account.accountId}]: pairing reply failed for ${ctx.senderOpenId}: ${String(err)}`);
				}
			});
			else log(`feishu[${account.accountId}]: blocked unauthorized sender ${ctx.senderOpenId} (dmPolicy=${authorization.dmPolicy})`);
		};
		const directAuthorization = isDirect ? await resolveDirectAuthorization(cfg, true, shouldComputeCommandAuthorized) : null;
		const dmIngress = directAuthorization?.ingress ?? null;
		if (isDirect && dmIngress?.ingress.admission !== "dispatch") {
			if (directAuthorization) await rejectDirectAuthorization(directAuthorization);
			return;
		}
		let effectiveDmPolicy = directAuthorization?.dmPolicy ?? dmPolicy;
		let effectiveConfigAllowFrom = directAuthorization?.configAllowFrom ?? configAllowFrom;
		let effectiveDmIngress = dmIngress;
		let effectiveShouldComputeCommandAuthorized = directAuthorization?.shouldComputeCommandAuthorized ?? shouldComputeCommandAuthorized;
		let effectiveCfg = cfg;
		if (isDirect) {
			const currentCfg = getFeishuRuntime().config.current();
			if (currentCfg !== effectiveCfg) {
				const currentAuthorization = await resolveDirectAuthorization(currentCfg, true);
				if (currentAuthorization.ingress.ingress.admission !== "dispatch") {
					await rejectDirectAuthorization(currentAuthorization);
					return;
				}
				effectiveCfg = currentCfg;
				effectiveDmPolicy = currentAuthorization.dmPolicy;
				effectiveConfigAllowFrom = currentAuthorization.configAllowFrom;
				effectiveDmIngress = currentAuthorization.ingress;
				effectiveShouldComputeCommandAuthorized = currentAuthorization.shouldComputeCommandAuthorized;
			}
		}
		const feishuFrom = `feishu:${ctx.senderOpenId}`;
		const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
		const peerId = isGroup ? groupSession?.peerId ?? ctx.chatId : ctx.senderOpenId;
		const parentPeer = isGroup ? groupSession?.parentPeer ?? null : null;
		const directThreadReply = !isGroup && Boolean(ctx.threadId?.trim());
		const defaultReplyTargetMessageId = ctx.replyTargetMessageId ?? (ctx.suppressReplyTarget ? void 0 : ctx.messageId);
		const directThreadRootId = directThreadReply ? ctx.rootId?.trim() || void 0 : void 0;
		const directThreadReplyTargetMessageId = directThreadReply ? directThreadRootId ?? defaultReplyTargetMessageId : void 0;
		const replyInThread = isGroup ? groupSession?.replyInThread ?? false : directThreadReply;
		const feishuAcpConversationSupported = !isGroup || groupSession?.groupSessionScope === "group_topic" || groupSession?.groupSessionScope === "group_topic_sender";
		if (isGroup && groupSession) log(`feishu[${account.accountId}]: group session scope=${groupSession.groupSessionScope}, peer=${peerId}`);
		let route = core.channel.routing.resolveAgentRoute({
			cfg: effectiveCfg,
			channel: "feishu",
			accountId: account.accountId,
			peer: {
				kind: isGroup ? "group" : "direct",
				id: peerId
			},
			parentPeer
		});
		if (!isGroup && route.matchedBy === "default") {
			const runtimeLocal = getFeishuRuntime();
			const result = await maybeCreateDynamicAgent({
				cfg: effectiveCfg,
				runtime: runtimeLocal,
				accountId: account.accountId,
				senderOpenId: ctx.senderOpenId,
				canCreateForConfig: async (candidateCfg) => {
					return (await resolveDirectAuthorization(candidateCfg, false)).ingress.ingress.admission === "dispatch";
				},
				log: (msg) => log(msg)
			});
			if (result.created || result.updatedCfg !== effectiveCfg) {
				const refreshedAuthorization = await resolveDirectAuthorization(result.updatedCfg, false);
				if (refreshedAuthorization.ingress.ingress.admission !== "dispatch") {
					log(`feishu[${account.accountId}]: current policy rejected stale DM from ${ctx.senderOpenId} before adopting refreshed dynamic route (dmPolicy=${refreshedAuthorization.dmPolicy})`);
					return;
				}
				effectiveCfg = result.updatedCfg;
				effectiveDmPolicy = refreshedAuthorization.dmPolicy;
				effectiveConfigAllowFrom = refreshedAuthorization.configAllowFrom;
				effectiveDmIngress = refreshedAuthorization.ingress;
				effectiveShouldComputeCommandAuthorized = refreshedAuthorization.shouldComputeCommandAuthorized;
				route = core.channel.routing.resolveAgentRoute({
					cfg: result.updatedCfg,
					channel: "feishu",
					accountId: account.accountId,
					peer: {
						kind: "direct",
						id: ctx.senderOpenId
					}
				});
				if (result.created) log(`feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`);
			}
		}
		const commandAllowFrom = isGroup ? groupConfig?.allowFrom ?? effectiveConfigAllowFrom : effectiveDmIngress?.senderAccess.effectiveAllowFrom ?? effectiveConfigAllowFrom;
		const currentConversationId = peerId;
		const parentConversationId = isGroup ? parentPeer?.id ?? ctx.chatId : void 0;
		let configuredBinding = null;
		if (feishuAcpConversationSupported) {
			const configuredRoute = resolveConfiguredBindingRoute({
				cfg: effectiveCfg,
				route,
				conversation: {
					channel: "feishu",
					accountId: account.accountId,
					conversationId: currentConversationId,
					parentConversationId
				}
			});
			configuredBinding = configuredRoute.bindingResolution;
			route = configuredRoute.route;
			const runtimeRoute = resolveRuntimeConversationBindingRoute({
				route,
				conversation: {
					channel: "feishu",
					accountId: account.accountId,
					conversationId: currentConversationId,
					...parentConversationId ? { parentConversationId } : {}
				}
			});
			route = runtimeRoute.route;
			if (runtimeRoute.bindingRecord) {
				configuredBinding = null;
				log(runtimeRoute.boundSessionKey ? `feishu[${account.accountId}]: routed via bound conversation ${currentConversationId} -> ${runtimeRoute.boundSessionKey}` : `feishu[${account.accountId}]: plugin-bound conversation ${currentConversationId}`);
			}
		}
		if (configuredBinding) {
			const ensured = await ensureConfiguredBindingRouteReady({
				cfg: effectiveCfg,
				bindingResolution: configuredBinding
			});
			if (!ensured.ok) {
				const acpTopicReply = isGroup && (groupSession?.groupSessionScope === "group_topic" || groupSession?.groupSessionScope === "group_topic_sender");
				const replyTargetMessageId = directThreadReply ? directThreadReplyTargetMessageId : acpTopicReply ? ctx.rootId ?? ctx.messageId : ctx.messageId;
				await sendMessageFeishu({
					cfg: effectiveCfg,
					to: `chat:${ctx.chatId}`,
					text: `⚠️ Failed to initialize the configured ACP session for this Feishu conversation: ${ensured.error}`,
					replyToMessageId: replyTargetMessageId,
					replyInThread,
					accountId: account.accountId
				}).catch((err) => {
					log(`feishu[${account.accountId}]: failed to send ACP init error reply: ${String(err)}`);
				});
				return;
			}
		}
		const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
		const inboundLabel = isGroup ? `Feishu[${account.accountId}] message in group ${ctx.chatId}` : `Feishu[${account.accountId}] DM from ${ctx.senderOpenId}`;
		const contextVisibilityMode = resolveChannelContextVisibilityMode({
			cfg: effectiveCfg,
			channel: "feishu",
			accountId: account.accountId
		});
		log(`feishu[${account.accountId}]: ${inboundLabel}: ${preview}`);
		const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024;
		const mediaList = await resolveFeishuMediaList({
			cfg,
			messageId: ctx.messageId,
			messageType: event.message.message_type,
			content: event.message.content,
			maxBytes: mediaMaxBytes,
			log,
			accountId: account.accountId
		});
		let quotedMessageInfo = null;
		let quotedContent;
		if (ctx.parentId) try {
			quotedMessageInfo = await getMessageFeishu({
				cfg,
				messageId: ctx.parentId,
				accountId: account.accountId
			});
			if (quotedMessageInfo && await shouldIncludeFetchedGroupContextMessage({
				cfg,
				accountId: account.accountId,
				chatId: ctx.chatId,
				isGroup,
				allowFrom: effectiveGroupSenderAllowFrom,
				mode: contextVisibilityMode,
				kind: "quote",
				senderId: quotedMessageInfo.senderId,
				senderType: quotedMessageInfo.senderType
			})) {
				quotedContent = quotedMessageInfo.content;
				log(`feishu[${account.accountId}]: fetched quoted message: ${quotedContent?.slice(0, 100)}`);
			} else if (quotedMessageInfo) log(`feishu[${account.accountId}]: skipped quoted message from sender ${quotedMessageInfo.senderId ?? "unknown"} (mode=${contextVisibilityMode})`);
		} catch (err) {
			log(`feishu[${account.accountId}]: failed to fetch quoted message: ${String(err)}`);
		}
		if (!ctx.content.trim() && mediaList.length === 0 && !quotedContent?.trim()) {
			log(`feishu[${account.accountId}]: skipping empty message (no text, no media, no quoted) from ${ctx.senderOpenId}`);
			return;
		}
		const audioTranscript = await resolveFeishuAudioPreflightTranscript({
			cfg: effectiveCfg,
			mediaList,
			content: ctx.content,
			chatType: isGroup ? "group" : "direct",
			log
		});
		const preflightAudioIndex = audioTranscript === void 0 ? -1 : mediaList.findIndex((media) => media.contentType?.startsWith("audio/"));
		const inboundMedia = toInboundMediaFacts(mediaList, { transcribed: (_media, index) => index === preflightAudioIndex });
		const agentFacingContent = audioTranscript ?? ctx.content;
		const agentFacingCtx = audioTranscript === void 0 ? ctx : {
			...ctx,
			content: audioTranscript
		};
		const effectiveCommandProbeBody = audioTranscript === void 0 ? commandProbeBody : isGroup ? normalizeFeishuCommandProbeBody(audioTranscript) : audioTranscript;
		const commandAuthorized = (audioTranscript === void 0 ? effectiveShouldComputeCommandAuthorized : core.channel.commands.shouldComputeCommandAuthorized(effectiveCommandProbeBody, effectiveCfg)) ? isDirect && audioTranscript === void 0 && effectiveDmIngress ? effectiveDmIngress.commandAccess.authorized : isGroup ? (await resolveFeishuGroupSenderActivationIngressAccess({
			cfg: effectiveCfg,
			accountId: account.accountId,
			chatId: ctx.chatId,
			allowFrom: commandAllowFrom,
			senderOpenId: ctx.senderOpenId,
			senderUserId,
			requireMention: false,
			mentionedBot: true,
			command: { hasControlCommand: true }
		})).commandAccess.authorized : (await resolveFeishuDmIngressAccess({
			cfg: effectiveCfg,
			accountId: account.accountId,
			dmPolicy: effectiveDmPolicy,
			allowFrom: effectiveConfigAllowFrom,
			readAllowFromStore: pairing.readAllowFromStore,
			senderOpenId: ctx.senderOpenId,
			senderUserId,
			conversationId: ctx.senderOpenId,
			mayPair: false,
			command: { hasControlCommand: true }
		})).commandAccess.authorized : void 0;
		const isTopicSessionForThread = isGroup && (groupSession?.groupSessionScope === "group_topic" || groupSession?.groupSessionScope === "group_topic_sender");
		const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
		const messageBody = buildFeishuAgentBody({
			ctx: agentFacingCtx,
			quotedContent,
			permissionErrorForAgent,
			botOpenId
		});
		const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;
		if (permissionErrorForAgent) log(`feishu[${account.accountId}]: appending permission error notice to message body`);
		let combinedBody = core.channel.reply.formatAgentEnvelope({
			channel: "Feishu",
			from: envelopeFrom,
			timestamp: /* @__PURE__ */ new Date(),
			envelope: envelopeOptions,
			body: messageBody
		});
		const historyKey = groupHistoryKey;
		if (isGroup && historyKey && chatHistories) combinedBody = createChannelHistoryWindow({ historyMap: chatHistories }).buildPendingContext({
			historyKey,
			limit: historyLimit,
			currentMessage: combinedBody,
			formatEntry: (entry) => core.channel.reply.formatAgentEnvelope({
				channel: "Feishu",
				from: `${ctx.chatId}:${entry.sender}`,
				timestamp: entry.timestamp,
				body: entry.body,
				envelope: envelopeOptions
			})
		});
		const inboundHistory = isGroup && historyKey && historyLimit > 0 && chatHistories ? createChannelHistoryWindow({ historyMap: chatHistories }).buildInboundHistory({
			historyKey,
			limit: historyLimit
		}) : void 0;
		const threadContextBySessionKey = /* @__PURE__ */ new Map();
		let rootMessageInfo;
		let rootMessageThreadId;
		let rootMessageFetched = false;
		const getRootMessageInfo = async () => {
			if (!ctx.rootId) return null;
			if (!rootMessageFetched) {
				rootMessageFetched = true;
				if (ctx.rootId === ctx.parentId && quotedMessageInfo) rootMessageInfo = quotedMessageInfo;
				else try {
					rootMessageInfo = await getMessageFeishu({
						cfg,
						messageId: ctx.rootId,
						accountId: account.accountId
					});
				} catch (err) {
					log(`feishu[${account.accountId}]: failed to fetch root message: ${String(err)}`);
					rootMessageInfo = null;
				}
				rootMessageThreadId = rootMessageInfo?.threadId;
				if (rootMessageInfo && !await shouldIncludeFetchedGroupContextMessage({
					cfg,
					accountId: account.accountId,
					chatId: ctx.chatId,
					isGroup,
					allowFrom: effectiveGroupSenderAllowFrom,
					mode: contextVisibilityMode,
					kind: "thread",
					senderId: rootMessageInfo.senderId,
					senderType: rootMessageInfo.senderType
				})) {
					log(`feishu[${account.accountId}]: skipped thread starter from sender ${rootMessageInfo.senderId ?? "unknown"} (mode=${contextVisibilityMode})`);
					rootMessageInfo = null;
				}
			}
			return rootMessageInfo ?? null;
		};
		let groupNamePromise;
		const resolveGroupNameForLabel = () => {
			if (!isGroup) return Promise.resolve(void 0);
			groupNamePromise ??= resolveGroupName({
				account,
				chatId: ctx.chatId,
				log
			});
			return groupNamePromise;
		};
		const resolveThreadContextForAgent = async (agentId, agentSessionKey, groupName) => {
			const cached = threadContextBySessionKey.get(agentSessionKey);
			if (cached) return cached;
			const threadContext = { threadLabel: (ctx.rootId || ctx.threadId) && isTopicSessionForThread ? `Feishu thread in ${groupName ?? ctx.chatId}` : void 0 };
			if (!(ctx.rootId || ctx.threadId) || !isTopicSessionForThread) {
				threadContextBySessionKey.set(agentSessionKey, threadContext);
				return threadContext;
			}
			const storePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId });
			if (core.channel.session.readSessionUpdatedAt({
				storePath,
				sessionKey: agentSessionKey
			})) {
				log(`feishu[${account.accountId}]: skipping thread bootstrap for existing session ${agentSessionKey}`);
				threadContextBySessionKey.set(agentSessionKey, threadContext);
				return threadContext;
			}
			const rootMsg = await getRootMessageInfo();
			const feishuThreadId = ctx.threadId ?? rootMessageThreadId ?? rootMsg?.threadId;
			if (feishuThreadId) log(`feishu[${account.accountId}]: resolved thread ID: ${feishuThreadId}`);
			if (!feishuThreadId) {
				log(`feishu[${account.accountId}]: no threadId found for root message ${ctx.rootId ?? "none"}, skipping thread history`);
				threadContextBySessionKey.set(agentSessionKey, threadContext);
				return threadContext;
			}
			try {
				const threadMessages = await listFeishuThreadMessages({
					cfg,
					threadId: feishuThreadId,
					currentMessageId: ctx.messageId,
					rootMessageId: ctx.rootId,
					limit: 20,
					accountId: account.accountId
				});
				const senderScoped = groupSession?.groupSessionScope === "group_topic_sender";
				const senderIds = new Set([ctx.senderOpenId, senderUserId].map((id) => id?.trim()).filter((id) => id !== void 0 && id.length > 0));
				const allowlistedMessages = await filterFetchedGroupContextMessages(threadMessages, {
					cfg,
					accountId: account.accountId,
					chatId: ctx.chatId,
					isGroup,
					allowFrom: effectiveGroupSenderAllowFrom,
					mode: contextVisibilityMode,
					kind: "history"
				});
				const relevantMessages = (senderScoped ? allowlistedMessages.filter((msg) => msg.senderType === "app" || msg.senderId !== void 0 && senderIds.has(msg.senderId.trim())) : allowlistedMessages) ?? [];
				const threadStarterBody = rootMsg?.content ?? relevantMessages[0]?.content;
				const historyMessages = Boolean(rootMsg?.content || ctx.rootId) ? relevantMessages : relevantMessages.slice(1);
				const historyParts = historyMessages.map((msg) => {
					const role = msg.senderType === "app" ? "assistant" : "user";
					return core.channel.reply.formatAgentEnvelope({
						channel: "Feishu",
						from: `${msg.senderId ?? "Unknown"} (${role})`,
						timestamp: msg.createTime,
						body: msg.content,
						envelope: envelopeOptions
					});
				});
				threadContext.threadStarterBody = threadStarterBody;
				threadContext.threadHistoryBody = historyParts.length > 0 ? historyParts.join("\n\n") : void 0;
				log(`feishu[${account.accountId}]: populated thread bootstrap with starter=${threadStarterBody ? "yes" : "no"} history=${historyMessages.length}`);
			} catch (err) {
				log(`feishu[${account.accountId}]: failed to fetch thread history: ${String(err)}`);
			}
			threadContextBySessionKey.set(agentSessionKey, threadContext);
			return threadContext;
		};
		const buildCtxPayloadForAgent = async (agentId, agentSessionKey, agentAccountId, wasMentioned) => {
			const groupName = await resolveGroupNameForLabel();
			const threadContext = await resolveThreadContextForAgent(agentId, agentSessionKey, groupName);
			return buildChannelInboundEventContext({
				channel: "feishu",
				finalize: core.channel.reply.finalizeInboundContext,
				supplemental: {
					quote: quotedContent ? {
						id: ctx.parentId,
						body: quotedContent
					} : void 0,
					thread: {
						starterBody: threadContext.threadStarterBody,
						historyBody: threadContext.threadHistoryBody,
						label: threadContext.threadLabel
					},
					groupSystemPrompt: isGroup ? normalizeOptionalString(groupConfig?.systemPrompt) : void 0
				},
				media: inboundMedia,
				messageId: ctx.messageId,
				timestamp: messageCreateTimeMs,
				from: feishuFrom,
				sender: {
					id: ctx.senderOpenId,
					name: ctx.senderName ?? ctx.senderOpenId
				},
				conversation: {
					kind: isGroup ? "group" : "direct",
					id: ctx.chatId,
					label: isGroup && groupName && !isTopicSessionForThread ? groupName : void 0,
					threadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : void 0
				},
				route: {
					agentId,
					accountId: agentAccountId,
					routeSessionKey: agentSessionKey
				},
				reply: {
					to: feishuTo,
					replyToId: ctx.parentId,
					messageThreadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : void 0
				},
				message: {
					body: combinedBody,
					bodyForAgent: messageBody,
					inboundHistory,
					rawBody: agentFacingContent,
					commandBody: agentFacingContent
				},
				access: {
					mentions: {
						canDetectMention: isGroup,
						wasMentioned
					},
					commands: { authorized: commandAuthorized }
				},
				extra: {
					RootMessageId: ctx.rootId,
					Transcript: audioTranscript,
					GroupSubject: isGroup ? groupName || ctx.chatId : void 0
				}
			});
		};
		const isTopicSession = isGroup && (groupSession?.groupSessionScope === "group_topic" || groupSession?.groupSessionScope === "group_topic_sender");
		const configReplyInThread = isGroup && (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled";
		const topicReplyTargetMessageId = ctx.rootId ?? defaultReplyTargetMessageId;
		const replyTargetMessageId = directThreadReply ? directThreadReplyTargetMessageId : isTopicSession || configReplyInThread ? topicReplyTargetMessageId : defaultReplyTargetMessageId;
		const typingTargetMessageId = ctx.typingTargetMessageId ?? (ctx.suppressReplyTarget ? void 0 : ctx.messageId);
		const threadReply = isGroup ? groupSession?.threadReply ?? false : directThreadReply;
		const lastRouteThreadId = isGroup && (isTopicSession || configReplyInThread || threadReply) ? replyTargetMessageId : void 0;
		const pinnedMainDmOwner = !isGroup ? resolvePinnedMainDmOwnerFromAllowlist({
			dmScope: effectiveCfg.session?.dmScope,
			allowFrom: effectiveConfigAllowFrom,
			normalizeEntry: normalizeFeishuAllowEntry
		}) : null;
		const pinnedMainDmSenderRecipient = pinnedMainDmOwner ? [ctx.senderOpenId, senderUserId].map((id) => id ? normalizeFeishuAllowEntry(id) : "").find((recipient) => recipient === pinnedMainDmOwner) : void 0;
		const buildFeishuInboundLastRouteUpdate = (paramsLocal) => {
			const inboundLastRouteSessionKey = paramsLocal.sessionKey === route.sessionKey ? resolveInboundLastRouteSessionKey({
				route,
				sessionKey: paramsLocal.sessionKey
			}) : paramsLocal.sessionKey;
			return {
				sessionKey: inboundLastRouteSessionKey,
				channel: "feishu",
				to: feishuTo,
				accountId: paramsLocal.accountId,
				...lastRouteThreadId ? { threadId: lastRouteThreadId } : {},
				mainDmOwnerPin: !isGroup && inboundLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner ? {
					ownerRecipient: pinnedMainDmOwner,
					senderRecipient: pinnedMainDmSenderRecipient ?? feishuTo,
					onSkip: (skipParams) => {
						log(`feishu[${account.accountId}]: skip main-session last route for ${skipParams.senderRecipient} (pinned owner ${skipParams.ownerRecipient})`);
					}
				} : void 0
			};
		};
		if (broadcastAgents) {
			if (!await tryRecordMessagePersistent(messageDedupeKey ?? ctx.messageId, "broadcast", log)) {
				log(`feishu[${account.accountId}]: broadcast already claimed by another account for message ${ctx.messageId}; skipping`);
				return;
			}
			const strategy = cfg.broadcast?.strategy === "sequential" ? "sequential" : "parallel";
			const activeAgentId = ctx.mentionedBot || !requireMention ? normalizeAgentId$1(route.agentId) : null;
			const agentIds = (cfg.agents?.list ?? []).map((a) => normalizeAgentId$1(a.id));
			const hasKnownAgents = agentIds.length > 0;
			log(`feishu[${account.accountId}]: broadcasting to ${broadcastAgents.length} agents (strategy=${strategy}, active=${activeAgentId ?? "none"})`);
			const dispatchForAgent = async (agentId) => {
				if (hasKnownAgents && !agentIds.includes(normalizeAgentId$1(agentId))) {
					log(`feishu[${account.accountId}]: broadcast agent ${agentId} not found in agents.list; skipping`);
					return;
				}
				const agentSessionKey = buildBroadcastSessionKey(route.sessionKey, route.agentId, agentId);
				const agentStorePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId });
				const agentRecord = {
					updateLastRoute: buildFeishuInboundLastRouteUpdate({
						sessionKey: agentSessionKey,
						accountId: route.accountId
					}),
					onRecordError: (err) => {
						log(`feishu[${account.accountId}]: failed to record broadcast inbound session ${agentSessionKey}: ${String(err)}`);
					}
				};
				const allowReasoningPreview = resolveFeishuReasoningPreviewEnabled({
					cfg,
					agentId,
					storePath: agentStorePath,
					sessionKey: agentSessionKey
				});
				const agentCtx = await buildCtxPayloadForAgent(agentId, agentSessionKey, route.accountId, ctx.mentionedBot && agentId === activeAgentId);
				if (agentId === activeAgentId) {
					const identity = resolveAgentOutboundIdentity(cfg, agentId);
					const { dispatcher, replyOptions, markDispatchIdle, ensureNoVisibleReplyFallback } = createFeishuReplyDispatcher({
						cfg,
						agentId,
						runtime,
						chatId: ctx.chatId,
						allowReasoningPreview,
						replyToMessageId: replyTargetMessageId,
						typingTargetMessageId,
						skipReplyToInMessages: !isGroup && !directThreadReply,
						replyInThread,
						rootId: ctx.rootId,
						threadReply,
						accountId: account.accountId,
						identity,
						mentionTargets: ctx.mentionTargets,
						messageCreateTimeMs,
						sessionKey: agentSessionKey
					});
					log(`feishu[${account.accountId}]: broadcast active dispatch agent=${agentId} (session=${agentSessionKey})`);
					const turnResult = await core.channel.inbound.run({
						channel: "feishu",
						accountId: route.accountId,
						raw: ctx,
						adapter: {
							ingest: () => ({
								id: ctx.messageId,
								timestamp: messageCreateTimeMs,
								rawText: ctx.content,
								textForAgent: agentCtx.BodyForAgent,
								textForCommands: agentCtx.CommandBody,
								raw: ctx
							}),
							resolveTurn: () => ({
								channel: "feishu",
								accountId: route.accountId,
								routeSessionKey: agentSessionKey,
								storePath: agentStorePath,
								ctxPayload: agentCtx,
								recordInboundSession: core.channel.session.recordInboundSession,
								record: agentRecord,
								onPreDispatchFailure: () => core.channel.reply.settleReplyDispatcher({
									dispatcher,
									onSettled: () => markDispatchIdle()
								}),
								runDispatch: () => core.channel.reply.withReplyDispatcher({
									dispatcher,
									onSettled: () => markDispatchIdle(),
									run: () => core.channel.reply.dispatchReplyFromConfig({
										ctx: agentCtx,
										cfg,
										dispatcher,
										replyOptions
									})
								})
							})
						}
					});
					if (turnResult.dispatched && shouldSendNoVisibleReplyFallback({
						...turnResult.dispatchResult,
						failedCounts: dispatcher.getFailedCounts?.() ?? {
							tool: 0,
							block: 0,
							final: 0
						}
					})) await ensureNoVisibleReplyFallback("broadcast-dispatch-complete-no-visible-reply");
				} else {
					delete agentCtx.CommandAuthorized;
					const noopDispatcher = {
						sendToolResult: () => false,
						sendBlockReply: () => false,
						sendFinalReply: () => false,
						waitForIdle: async () => {},
						getQueuedCounts: () => ({
							tool: 0,
							block: 0,
							final: 0
						}),
						getFailedCounts: () => ({
							tool: 0,
							block: 0,
							final: 0
						}),
						markComplete: () => {}
					};
					log(`feishu[${account.accountId}]: broadcast observer dispatch agent=${agentId} (session=${agentSessionKey})`);
					await core.channel.inbound.run({
						channel: "feishu",
						accountId: route.accountId,
						raw: ctx,
						adapter: {
							ingest: () => ({
								id: ctx.messageId,
								timestamp: messageCreateTimeMs,
								rawText: ctx.content,
								textForAgent: agentCtx.BodyForAgent,
								textForCommands: agentCtx.CommandBody,
								raw: ctx
							}),
							resolveTurn: () => ({
								channel: "feishu",
								accountId: route.accountId,
								routeSessionKey: agentSessionKey,
								storePath: agentStorePath,
								ctxPayload: agentCtx,
								recordInboundSession: core.channel.session.recordInboundSession,
								record: agentRecord,
								runDispatch: () => core.channel.reply.withReplyDispatcher({
									dispatcher: noopDispatcher,
									run: () => core.channel.reply.dispatchReplyFromConfig({
										ctx: agentCtx,
										cfg,
										dispatcher: noopDispatcher
									})
								})
							})
						}
					});
				}
			};
			if (strategy === "sequential") for (const agentId of broadcastAgents) try {
				await dispatchForAgent(agentId);
			} catch (err) {
				log(`feishu[${account.accountId}]: broadcast dispatch failed for agent=${agentId}: ${String(err)}`);
			}
			else {
				const results = await Promise.allSettled(broadcastAgents.map(dispatchForAgent));
				for (let i = 0; i < results.length; i++) if (results[i].status === "rejected") log(`feishu[${account.accountId}]: broadcast dispatch failed for agent=${broadcastAgents[i]}: ${String(results[i].reason)}`);
			}
			if (isGroup && historyKey && chatHistories) createChannelHistoryWindow({ historyMap: chatHistories }).clear({
				historyKey,
				limit: historyLimit
			});
			log(`feishu[${account.accountId}]: broadcast dispatch complete for ${broadcastAgents.length} agents`);
		} else {
			const ctxPayload = await buildCtxPayloadForAgent(route.agentId, route.sessionKey, route.accountId, ctx.mentionedBot);
			const identity = resolveAgentOutboundIdentity(effectiveCfg, route.agentId);
			const storePath = core.channel.session.resolveStorePath(effectiveCfg.session?.store, { agentId: route.agentId });
			const allowReasoningPreview = resolveFeishuReasoningPreviewEnabled({
				cfg: effectiveCfg,
				agentId: route.agentId,
				storePath,
				sessionKey: route.sessionKey
			});
			const { dispatcher, replyOptions, markDispatchIdle, ensureNoVisibleReplyFallback } = createFeishuReplyDispatcher({
				cfg: effectiveCfg,
				agentId: route.agentId,
				runtime,
				chatId: ctx.chatId,
				allowReasoningPreview,
				replyToMessageId: replyTargetMessageId,
				typingTargetMessageId,
				skipReplyToInMessages: !isGroup && !directThreadReply,
				replyInThread,
				rootId: ctx.rootId,
				threadReply,
				accountId: account.accountId,
				identity,
				mentionTargets: ctx.mentionTargets,
				messageCreateTimeMs,
				sessionKey: route.sessionKey
			});
			log(`feishu[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);
			const turnResult = await core.channel.inbound.run({
				channel: "feishu",
				accountId: route.accountId,
				raw: ctx,
				adapter: {
					ingest: () => ({
						id: ctx.messageId,
						timestamp: messageCreateTimeMs,
						rawText: ctx.content,
						textForAgent: ctxPayload.BodyForAgent,
						textForCommands: ctxPayload.CommandBody,
						raw: ctx
					}),
					resolveTurn: () => ({
						channel: "feishu",
						accountId: route.accountId,
						routeSessionKey: route.sessionKey,
						storePath,
						ctxPayload,
						recordInboundSession: core.channel.session.recordInboundSession,
						record: {
							updateLastRoute: buildFeishuInboundLastRouteUpdate({
								sessionKey: route.sessionKey,
								accountId: route.accountId
							}),
							onRecordError: (err) => {
								log(`feishu[${account.accountId}]: failed to record inbound session ${route.sessionKey}: ${String(err)}`);
							}
						},
						history: {
							isGroup,
							historyKey,
							historyMap: chatHistories,
							limit: historyLimit
						},
						onPreDispatchFailure: () => core.channel.reply.settleReplyDispatcher({
							dispatcher,
							onSettled: () => markDispatchIdle()
						}),
						runDispatch: () => core.channel.reply.withReplyDispatcher({
							dispatcher,
							onSettled: () => {
								markDispatchIdle();
							},
							run: () => core.channel.reply.dispatchReplyFromConfig({
								ctx: ctxPayload,
								cfg: effectiveCfg,
								dispatcher,
								replyOptions
							})
						})
					})
				}
			});
			if (!turnResult.dispatched) return;
			const { dispatchResult } = turnResult;
			const { queuedFinal, counts } = dispatchResult;
			if (shouldSendNoVisibleReplyFallback({
				...dispatchResult,
				failedCounts: dispatcher.getFailedCounts?.() ?? {
					tool: 0,
					block: 0,
					final: 0
				}
			})) await ensureNoVisibleReplyFallback("dispatch-complete-no-visible-reply");
			log(`feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`);
		}
	} catch (err) {
		error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
	}
}
//#endregion
export { buildBroadcastSessionKey, buildFeishuAgentBody, clearGroupNameCache, handleFeishuMessage, parseFeishuMessageEvent, resolveBroadcastAgents, resolveGroupName, toMessageResourceType };
