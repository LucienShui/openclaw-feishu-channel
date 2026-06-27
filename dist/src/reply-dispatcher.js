import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { resolveReceiveIdType } from "./targets.js";
import { getFeishuRuntime } from "./runtime.js";
import { createFeishuClient } from "./client.js";
import { createReplyPrefixContext } from "../runtime-api.js";
import { sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import "./reply-dispatcher-runtime-api.js";
import { sendMessageFeishu, sendStructuredCardFeishu } from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { addTypingIndicator, removeTypingIndicator } from "./typing.js";
import { createChannelMessageReplyPipeline, formatChannelProgressDraftLineForEntry, isChannelProgressDraftWorkToolName } from "openclaw/plugin-sdk/channel-outbound";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import { formatReasoningMessage } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { resolveSendableOutboundReplyParts, resolveTextChunksWithFallback, sendMediaWithLeadingCaption } from "openclaw/plugin-sdk/reply-payload";
//#region src/reply-dispatcher.ts
/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text) {
	return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}
function mergeStreamingFinalText(previousText, nextText, appendError) {
	if (!appendError || !previousText) return nextText;
	if (nextText.startsWith(previousText)) return nextText;
	if (previousText.endsWith(`\n\n${nextText}`)) return previousText;
	return `${previousText}\n\n${nextText}`;
}
/** Maximum age (ms) for a message to receive a typing indicator reaction.
* Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 6e4;
const MS_EPOCH_MIN = 0xe8d4a51000;
const STREAMING_START_FAILURE_BACKOFF_MS = 6e4;
const NO_VISIBLE_REPLY_FALLBACK_TEXT = "⚠️ This reply completed without visible content. The turn may have been interrupted; please retry or ask me to recover from recent context.";
const streamingStartBackoffUntilByAccount = /* @__PURE__ */ new Map();
function isStreamingStartBackedOff(accountId, now = Date.now()) {
	const backoffUntil = streamingStartBackoffUntilByAccount.get(accountId);
	if (backoffUntil === void 0) return false;
	if (backoffUntil <= now) {
		streamingStartBackoffUntilByAccount.delete(accountId);
		return false;
	}
	return true;
}
function rememberStreamingStartFailure(accountId, now = Date.now()) {
	const backoffUntil = now + STREAMING_START_FAILURE_BACKOFF_MS;
	streamingStartBackoffUntilByAccount.set(accountId, backoffUntil);
	return backoffUntil;
}
function formatMediaFallbackText(text, mediaUrl) {
	const trimmedText = text?.trim() ?? "";
	const attachmentText = `📎 ${mediaUrl}`;
	return trimmedText ? `${trimmedText}\n\n${attachmentText}` : attachmentText;
}
function clearFeishuStreamingStartBackoffForTests() {
	streamingStartBackoffUntilByAccount.clear();
}
function normalizeEpochMs(timestamp) {
	if (!Number.isFinite(timestamp) || timestamp === void 0 || timestamp <= 0) return;
	return timestamp < MS_EPOCH_MIN ? timestamp * 1e3 : timestamp;
}
/** Build a card header from agent identity config. */
function resolveCardHeader(agentId, identity) {
	const name = identity?.name?.trim() || (agentId === "main" ? "" : agentId);
	const emoji = identity?.emoji?.trim();
	const title = (emoji ? `${emoji} ${name}` : name).trim();
	if (!title) return;
	return {
		title,
		template: identity?.theme ?? "blue"
	};
}
/** Build a card note footer from agent identity and model context. */
function resolveCardNote(agentId, identity, prefixCtx) {
	const parts = [`Agent: ${identity?.name?.trim() || agentId}`];
	if (prefixCtx.model) parts.push(`Model: ${prefixCtx.model}`);
	if (prefixCtx.provider) parts.push(`Provider: ${prefixCtx.provider}`);
	return parts.join(" | ");
}
function createFeishuReplyDispatcher(params) {
	const core = getFeishuRuntime();
	const { cfg, agentId, chatId, replyToMessageId, typingTargetMessageId: explicitTypingTargetMessageId, skipReplyToInMessages, replyInThread, threadReply, rootId, accountId, identity, mentionTargets } = params;
	const sendReplyToMessageId = skipReplyToInMessages ? void 0 : replyToMessageId;
	const typingTargetMessageId = explicitTypingTargetMessageId?.trim() || replyToMessageId;
	const threadReplyMode = threadReply === true;
	const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
	const allowTopLevelReplyFallback = effectiveReplyInThread === true && threadReplyMode && rootId !== void 0 && sendReplyToMessageId !== void 0 && sendReplyToMessageId !== rootId;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	const prefixContext = createReplyPrefixContext({
		cfg,
		agentId
	});
	let typingState = null;
	const { typingCallbacks } = createChannelMessageReplyPipeline({
		cfg,
		agentId,
		channel: "feishu",
		accountId,
		typing: {
			start: async () => {
				if (!(account.config.typingIndicator ?? true)) return;
				if (!typingTargetMessageId) return;
				const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
				if (messageCreateTimeMs !== void 0 && Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS) return;
				if (typingState?.reactionId) return;
				typingState = await addTypingIndicator({
					cfg,
					messageId: typingTargetMessageId,
					accountId,
					runtime: params.runtime
				});
			},
			stop: async () => {
				if (!typingState) return;
				await removeTypingIndicator({
					cfg,
					state: typingState,
					accountId,
					runtime: params.runtime
				});
				typingState = null;
			},
			onStartError: (err) => logTypingFailure({
				log: (message) => params.runtime.log?.(message),
				channel: "feishu",
				action: "start",
				error: err
			}),
			onStopError: (err) => logTypingFailure({
				log: (message) => params.runtime.log?.(message),
				channel: "feishu",
				action: "stop",
				error: err
			})
		}
	});
	const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, { fallbackLimit: 4e3 });
	const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
	const tableMode = core.channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "feishu"
	});
	const renderMode = account.config?.renderMode ?? "auto";
	const streamingEnabled = account.config?.streaming !== false && renderMode !== "raw";
	const coreBlockStreamingEnabled = account.config?.blockStreaming === true;
	const reasoningPreviewEnabled = streamingEnabled && params.allowReasoningPreview === true;
	let streaming = null;
	let streamText = "";
	let lastPartial = "";
	let reasoningText = "";
	let statusLine = "";
	let snapshotBaseText = "";
	let lastSnapshotTextLength = 0;
	let hasStreamingFinalText = false;
	const deliveredFinalTexts = /* @__PURE__ */ new Set();
	let partialUpdateQueue = Promise.resolve();
	let streamingStartPromise = null;
	let streamingClosedForReply = false;
	let streamingCloseErroredForReply = false;
	let visibleReplySent = false;
	let skippedFinalReason = null;
	let idleSideEffectsPromise = Promise.resolve();
	let replyLifecycleStateInitialized = false;
	const markVisibleReplySent = () => {
		visibleReplySent = true;
	};
	const formatReasoningPrefix = (thinking) => {
		if (!thinking) return "";
		return `> 💭 **Thinking**\n${thinking.replace(/^(?:Reasoning:|Thinking\.{0,3})\s*/u, "").replace(/^_(.*)_$/gm, "$1").split("\n").map((line) => `> ${line}`).join("\n")}`;
	};
	const buildCombinedStreamText = (thinking, answer) => {
		const parts = [];
		if (thinking) parts.push(formatReasoningPrefix(thinking));
		if (thinking && answer) parts.push("\n\n---\n\n");
		if (answer) parts.push(answer);
		if (statusLine) parts.push(parts.length > 0 ? `\n\n${statusLine}` : statusLine);
		return parts.join("");
	};
	const flushStreamingCardUpdate = (combined) => {
		partialUpdateQueue = partialUpdateQueue.then(async () => {
			if (streamingStartPromise) await streamingStartPromise;
			if (streaming?.isActive()) await streaming.update(combined);
		});
	};
	const queueStreamingUpdate = (nextText, options) => {
		if (!nextText) return;
		if (options?.dedupeWithLastPartial && nextText === lastPartial) return;
		if (options?.dedupeWithLastPartial) lastPartial = nextText;
		if ((options?.mode ?? "snapshot") === "delta") streamText = `${streamText}${nextText}`;
		else {
			const currentSnapshotText = snapshotBaseText ? streamText.slice(snapshotBaseText.length) : streamText;
			if (lastSnapshotTextLength >= 20 && nextText.length < lastSnapshotTextLength * .5 && !currentSnapshotText.includes(nextText)) {
				snapshotBaseText = streamText;
				streamText = `${snapshotBaseText}${nextText}`;
			} else streamText = `${snapshotBaseText}${mergeStreamingText(currentSnapshotText, nextText)}`;
			lastSnapshotTextLength = nextText.length;
		}
		flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
	};
	const queueReasoningUpdate = (nextThinking) => {
		if (!nextThinking) return;
		reasoningText = nextThinking;
		flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
	};
	const startStreaming = () => {
		if (!streamingEnabled || streamingStartPromise || streaming || isStreamingStartBackedOff(account.accountId)) return;
		streamingStartPromise = (async () => {
			const creds = account.appId && account.appSecret ? {
				appId: account.appId,
				appSecret: account.appSecret,
				domain: account.domain
			} : null;
			if (!creds) return;
			streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) => params.runtime.log?.(`feishu[${account.accountId}] ${message}`));
			try {
				const cardHeader = resolveCardHeader(agentId, identity);
				const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
				await streaming.start(chatId, resolveReceiveIdType(chatId), {
					replyToMessageId,
					replyInThread: effectiveReplyInThread,
					rootId,
					header: cardHeader,
					note: cardNote
				});
				streamingStartBackoffUntilByAccount.delete(account.accountId);
			} catch (error) {
				rememberStreamingStartFailure(account.accountId);
				params.runtime.error?.(`feishu[${account.accountId}]: streaming start failed; using non-streaming card fallback for ${STREAMING_START_FAILURE_BACKOFF_MS / 1e3}s: ${String(error)}`);
				streaming = null;
				streamingStartPromise = null;
			}
		})();
	};
	const resetStreamingState = () => {
		streaming = null;
		streamingStartPromise = null;
		partialUpdateQueue = Promise.resolve();
		streamText = "";
		lastPartial = "";
		reasoningText = "";
		statusLine = "";
		snapshotBaseText = "";
		lastSnapshotTextLength = 0;
		hasStreamingFinalText = false;
	};
	const closeStreaming = async (options) => {
		try {
			if (streamingStartPromise) await streamingStartPromise;
			await partialUpdateQueue;
			if (streaming?.isActive()) {
				statusLine = "";
				const text = buildCombinedStreamText(reasoningText, streamText);
				const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
				const contentVisible = await streaming.close(text, { note: finalNote });
				if (contentVisible) markVisibleReplySent();
				if (contentVisible && streamText) {
					deliveredFinalTexts.add(streamText);
					if (options?.markClosedForReply !== false && !streamingCloseErroredForReply) streamingClosedForReply = true;
				}
			}
		} finally {
			resetStreamingState();
		}
	};
	const discardStreamingPreview = async () => {
		try {
			if (streamingStartPromise) await streamingStartPromise;
			await partialUpdateQueue;
			if (streaming?.isActive()) await streaming.discard();
		} finally {
			resetStreamingState();
		}
	};
	const updateStreamingStatusLine = (nextStatusLine, options) => {
		statusLine = nextStatusLine;
		if (!Boolean(streaming?.isActive() || streamingStartPromise) && (options?.startIfNeeded === false || renderMode !== "card")) return;
		startStreaming();
		flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
	};
	const sendChunkedTextReply = async (paramsLocal) => {
		const chunkSource = paramsLocal.useCard ? paramsLocal.text : core.channel.text.convertMarkdownTables(paramsLocal.text, tableMode);
		const chunks = resolveTextChunksWithFallback(chunkSource, (paramsLocal.useCard ? core.channel.text.chunkMarkdownTextWithMode : core.channel.text.chunkTextWithMode)(chunkSource, textChunkLimit, chunkMode));
		for (const [index, chunk] of chunks.entries()) {
			await paramsLocal.sendChunk({
				chunk,
				isFirst: index === 0
			});
			markVisibleReplySent();
		}
		if (paramsLocal.infoKind === "final") deliveredFinalTexts.add(paramsLocal.text);
	};
	const sendMediaReplies = async (payload, options) => {
		const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
		let sentFallbackText = false;
		await sendMediaWithLeadingCaption({
			mediaUrls,
			caption: "",
			send: async ({ mediaUrl }) => {
				const result = await sendMediaFeishu({
					cfg,
					to: chatId,
					mediaUrl,
					replyToMessageId: sendReplyToMessageId,
					replyInThread: effectiveReplyInThread,
					accountId,
					...payload.audioAsVoice === true ? { audioAsVoice: true } : {}
				});
				markVisibleReplySent();
				if (result?.voiceIntentDegradedToFile && options?.fallbackText && !sentFallbackText) {
					sentFallbackText = true;
					await sendChunkedTextReply({
						text: options.fallbackText,
						useCard: false,
						infoKind: "final",
						sendChunk: async ({ chunk }) => {
							await sendMessageFeishu({
								cfg,
								to: chatId,
								text: chunk,
								replyToMessageId: sendReplyToMessageId,
								replyInThread: effectiveReplyInThread,
								allowTopLevelReplyFallback,
								accountId
							});
						}
					});
				}
			},
			onError: options?.fallbackText === void 0 ? void 0 : async ({ mediaUrl }) => {
				const fallbackText = formatMediaFallbackText(sentFallbackText ? void 0 : options.fallbackText, mediaUrl);
				sentFallbackText = true;
				await sendChunkedTextReply({
					text: fallbackText,
					useCard: false,
					infoKind: "final",
					sendChunk: async ({ chunk }) => {
						await sendMessageFeishu({
							cfg,
							to: chatId,
							text: chunk,
							replyToMessageId: sendReplyToMessageId,
							replyInThread: effectiveReplyInThread,
							allowTopLevelReplyFallback,
							accountId
						});
					}
				});
			}
		});
	};
	const ensureNoVisibleReplyFallback = async (reason) => {
		await idleSideEffectsPromise;
		if (visibleReplySent) return false;
		if (skippedFinalReason === "silent") {
			params.runtime.log?.(`feishu[${account.accountId}]: no-visible-reply fallback skipped for intentional silence (${reason})`);
			return false;
		}
		await sendMessageFeishu({
			cfg,
			to: chatId,
			text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
			replyToMessageId: sendReplyToMessageId,
			replyInThread: effectiveReplyInThread,
			allowTopLevelReplyFallback,
			accountId
		});
		markVisibleReplySent();
		params.runtime.error?.(`feishu[${account.accountId}]: sent no-visible-reply fallback (${reason})`);
		return true;
	};
	const queueIdleSideEffects = (options) => {
		const nextIdleSideEffects = idleSideEffectsPromise.then(async () => {
			await closeStreaming(options);
			typingCallbacks?.onIdle?.();
		});
		idleSideEffectsPromise = nextIdleSideEffects.catch(() => {});
		return nextIdleSideEffects;
	};
	const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
		responsePrefix: prefixContext.responsePrefix,
		responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
		humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
		silentReplyContext: {
			cfg,
			sessionKey: params.sessionKey,
			surface: "feishu",
			conversationType: chatId.startsWith("oc_") ? "group" : "direct"
		},
		onSkip: (_payload, info) => {
			if (info.kind === "final") skippedFinalReason = info.reason;
		},
		onReplyStart: async () => {
			if (!replyLifecycleStateInitialized) {
				replyLifecycleStateInitialized = true;
				deliveredFinalTexts.clear();
				streamingClosedForReply = false;
				streamingCloseErroredForReply = false;
				visibleReplySent = false;
				skippedFinalReason = null;
			}
			if (streamingEnabled && renderMode === "card") startStreaming();
			await Promise.resolve(typingCallbacks?.onReplyStart?.());
		},
		deliver: async (payload, info) => {
			if (info?.kind === "final") skippedFinalReason = null;
			const payloadText = payload.isReasoning && payload.text ? formatReasoningMessage(payload.text) : payload.text;
			const reply = resolveSendableOutboundReplyParts({
				...payload,
				text: payloadText
			});
			const text = info?.kind === "final" ? mergeStreamingFinalText(streamText, reply.text, payload.isError === true && hasStreamingFinalText) : reply.text;
			const hasText = reply.hasText;
			const hasMedia = reply.hasMedia;
			const hasVoiceMedia = hasMedia && reply.mediaUrls.some((mediaUrl) => shouldSuppressFeishuTextForVoiceMedia({
				mediaUrl,
				...payload.audioAsVoice === true ? { audioAsVoice: true } : {}
			}));
			const finalTextExceedsStreamingLimit = info?.kind === "final" && hasText && text.length > textChunkLimit;
			const useStaticCard = hasText && (renderMode === "card" || info?.kind === "block" && coreBlockStreamingEnabled && renderMode !== "raw" || renderMode === "auto" && shouldUseCard(text));
			const useStreamingCard = hasText && streamingEnabled && !finalTextExceedsStreamingLimit && (info?.kind === "final" || useStaticCard);
			const finalTextWouldUseStreamingCard = info?.kind === "final" && hasText && streamingEnabled;
			const useCard = useStaticCard || useStreamingCard;
			const skipTextForDuplicateFinal = info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
			const skipTextForClosedStreamingFinal = info?.kind === "final" && hasText && streamingClosedForReply && !streamingCloseErroredForReply && finalTextWouldUseStreamingCard;
			const shouldDeliverText = hasText && !hasVoiceMedia && !skipTextForDuplicateFinal && !skipTextForClosedStreamingFinal;
			const shouldDiscardStreamingPreview = info?.kind === "final" && (finalTextExceedsStreamingLimit || hasMedia && (hasVoiceMedia && !shouldDeliverText || skipTextForDuplicateFinal));
			if (!shouldDeliverText && !hasMedia) return;
			if (shouldDiscardStreamingPreview) await discardStreamingPreview();
			if (shouldDeliverText) {
				if (info?.kind === "block") {
					if (!useStreamingCard) return;
					startStreaming();
					if (streamingStartPromise) await streamingStartPromise;
				}
				if (info?.kind === "final" && useStreamingCard) {
					startStreaming();
					if (streamingStartPromise) await streamingStartPromise;
				}
				const shouldStreamText = info?.kind === "block" || info?.kind === "final";
				if (streaming?.isActive() && shouldStreamText) {
					if (info?.kind === "block") queueStreamingUpdate(text, {
						mode: "delta",
						dedupeWithLastPartial: true
					});
					if (info?.kind === "final") {
						streamText = text;
						hasStreamingFinalText = true;
						snapshotBaseText = "";
						lastSnapshotTextLength = text.length;
						flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
					}
					if (hasMedia) await sendMediaReplies(payload);
					return;
				}
				if (useCard) {
					const cardHeader = resolveCardHeader(agentId, identity);
					const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
					await sendChunkedTextReply({
						text,
						useCard: true,
						infoKind: info?.kind,
						sendChunk: async ({ chunk }) => {
							await sendStructuredCardFeishu({
								cfg,
								to: chatId,
								text: chunk,
								replyToMessageId: sendReplyToMessageId,
								replyInThread: effectiveReplyInThread,
								allowTopLevelReplyFallback,
								accountId,
								header: cardHeader,
								note: cardNote
							});
						}
					});
				} else await sendChunkedTextReply({
					text,
					useCard: false,
					infoKind: info?.kind,
					sendChunk: async ({ chunk, isFirst }) => {
						await sendMessageFeishu({
							cfg,
							to: chatId,
							text: chunk,
							replyToMessageId: sendReplyToMessageId,
							replyInThread: effectiveReplyInThread,
							allowTopLevelReplyFallback,
							accountId,
							...info?.kind === "final" && isFirst && mentionTargets?.length ? { mentions: mentionTargets } : {}
						});
					}
				});
			}
			if (hasMedia) await sendMediaReplies(payload, hasVoiceMedia && hasText ? { fallbackText: text } : void 0);
		},
		onError: async (error, info) => {
			streamingCloseErroredForReply = true;
			streamingClosedForReply = false;
			params.runtime.error?.(`feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`);
			await queueIdleSideEffects({ markClosedForReply: false });
		},
		onIdle: () => queueIdleSideEffects(),
		onCleanup: () => {
			typingCallbacks?.onCleanup?.();
		}
	});
	return {
		dispatcher,
		replyOptions: {
			...replyOptions,
			onModelSelected: prefixContext.onModelSelected,
			disableBlockStreaming: typeof account.config?.blockStreaming === "boolean" ? !account.config.blockStreaming : true,
			onPartialReply: streamingEnabled ? (payload) => {
				if (!payload.text) return;
				const cleaned = stripReasoningTagsFromText(payload.text, {
					mode: "strict",
					trim: "both"
				});
				if (!cleaned) return;
				startStreaming();
				queueStreamingUpdate(cleaned, {
					dedupeWithLastPartial: true,
					mode: "snapshot"
				});
			} : void 0,
			onReasoningStream: reasoningPreviewEnabled ? (payload) => {
				if (!payload.text) return;
				startStreaming();
				queueReasoningUpdate(formatReasoningMessage(payload.text));
			} : void 0,
			onReasoningEnd: reasoningPreviewEnabled ? () => {} : void 0,
			onToolStart: streamingEnabled ? (payload) => {
				if (!isChannelProgressDraftWorkToolName(payload.name)) return;
				const statusLineLocal = formatChannelProgressDraftLineForEntry(account.config, {
					event: "tool",
					name: payload.name,
					phase: payload.phase,
					args: payload.args
				}, { detailMode: payload.detailMode });
				if (statusLineLocal) updateStreamingStatusLine(statusLineLocal);
			} : void 0,
			onAssistantMessageStart: streamingEnabled ? () => {
				updateStreamingStatusLine("", { startIfNeeded: false });
			} : void 0,
			onCompactionStart: streamingEnabled ? () => {
				updateStreamingStatusLine("📦 **Compacting context...**");
			} : void 0,
			onCompactionEnd: streamingEnabled ? () => {
				updateStreamingStatusLine("");
			} : void 0
		},
		markDispatchIdle,
		ensureNoVisibleReplyFallback,
		getVisibleReplyState: () => ({
			visibleReplySent,
			skippedFinalReason
		})
	};
}
//#endregion
export { clearFeishuStreamingStartBackoffForTests, createFeishuReplyDispatcher };
