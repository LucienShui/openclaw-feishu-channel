import { parseFeishuCommentTarget } from "./comment-target.js";
import { resolveFeishuAccount } from "./accounts.js";
import { buildFeishuPresentationCardElements } from "./presentation-card.js";
import { createFeishuClient } from "./client.js";
import { cleanupAmbientCommentTypingReaction } from "./comment-reaction.js";
import { deliverCommentThreadText } from "./drive.js";
import { chunkTextForOutbound } from "../runtime-api.js";
import { sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import { resolveFeishuCardTemplate, sendCardFeishu, sendMarkdownCardFeishu, sendMessageFeishu, sendStructuredCardFeishu } from "./send.js";
import "./outbound-runtime-api.js";
import { interactiveReplyToPresentation, normalizeInteractiveReply, normalizeMessagePresentation, renderMessagePresentationFallbackText, resolveInteractiveTextFallback } from "openclaw/plugin-sdk/interactive-runtime";
import { isRecord, normalizeLowercaseStringOrEmpty, normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import path from "node:path";
import { statRegularFileSync } from "openclaw/plugin-sdk/security-runtime";
import { resolvePayloadMediaUrls, sendPayloadMediaSequenceAndFinalize, sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { attachChannelToResult, createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
//#region src/outbound.ts
const RENDERED_FEISHU_CARD = Symbol("openclaw.renderedFeishuCard");
function normalizePossibleLocalImagePath(text) {
	const raw = text?.trim();
	if (!raw) return null;
	if (/\s/.test(raw)) return null;
	if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;
	const ext = normalizeLowercaseStringOrEmpty(path.extname(raw));
	if (![
		".jpg",
		".jpeg",
		".png",
		".gif",
		".webp",
		".bmp",
		".ico",
		".tiff"
	].includes(ext)) return null;
	if (!path.isAbsolute(raw)) return null;
	try {
		if (statRegularFileSync(raw).missing) return null;
	} catch {
		return null;
	}
	return raw;
}
function shouldUseCard(text) {
	return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}
function markRenderedFeishuCard(card) {
	Object.defineProperty(card, RENDERED_FEISHU_CARD, {
		value: true,
		enumerable: false
	});
	return card;
}
function escapeFeishuCardMarkdownText(text) {
	return text.replace(/[&<>]/g, (char) => {
		switch (char) {
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			default: return char;
		}
	});
}
function resolveSafeFeishuButtonUrl(url) {
	const trimmed = typeof url === "string" ? url.trim() : "";
	if (!trimmed) return;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? trimmed : void 0;
	} catch {
		return;
	}
}
function sanitizeNativeFeishuButtonBehavior(behavior) {
	if (!isRecord(behavior)) return;
	if (behavior.type === "open_url") {
		const safeUrl = resolveSafeFeishuButtonUrl(behavior.default_url) ?? resolveSafeFeishuButtonUrl(behavior.url);
		return safeUrl ? {
			type: "open_url",
			default_url: safeUrl
		} : void 0;
	}
	if (behavior.type === "callback" && isRecord(behavior.value) && behavior.value.oc === "ocf1") return {
		type: "callback",
		value: behavior.value
	};
}
function sanitizeNativeFeishuCardButton(button) {
	if (!isRecord(button)) return;
	const text = isRecord(button.text) && typeof button.text.content === "string" ? button.text.content : void 0;
	if (!text?.trim()) return;
	const style = button.type === "danger" ? "danger" : button.type === "primary" || button.type === "success" ? "primary" : void 0;
	const behaviors = Array.isArray(button.behaviors) ? button.behaviors.map((behavior) => sanitizeNativeFeishuButtonBehavior(behavior)).filter((behavior) => Boolean(behavior)) : [];
	const rootSafeUrl = resolveSafeFeishuButtonUrl(button.url);
	if (rootSafeUrl) behaviors.push({
		type: "open_url",
		default_url: rootSafeUrl
	});
	if (isRecord(button.value) && button.value.oc === "ocf1") behaviors.push({
		type: "callback",
		value: button.value
	});
	if (behaviors.length === 0) return;
	return {
		tag: "button",
		text: {
			tag: "plain_text",
			content: text
		},
		type: style === "danger" ? "danger" : style === "primary" || style === "success" ? "primary" : "default",
		behaviors
	};
}
function sanitizeNativeFeishuCardElements(element) {
	if (!isRecord(element) || typeof element.tag !== "string") return [];
	if (element.tag === "hr") return [{ tag: "hr" }];
	if (element.tag === "markdown" && typeof element.content === "string") return [{
		tag: "markdown",
		content: escapeFeishuCardMarkdownText(element.content)
	}];
	if (element.tag === "button") {
		const button = sanitizeNativeFeishuCardButton(element);
		return button ? [button] : [];
	}
	if (element.tag === "action" && Array.isArray(element.actions)) return element.actions.map((action) => sanitizeNativeFeishuCardButton(action)).filter((action) => Boolean(action));
	return [];
}
function sanitizeNativeFeishuCard(card) {
	const body = isRecord(card.body) ? card.body : void 0;
	const elements = (Array.isArray(body?.elements) ? body.elements : []).flatMap((element) => sanitizeNativeFeishuCardElements(element)).filter((element) => Boolean(element));
	if (elements.length === 0) return;
	const header = isRecord(card.header) ? card.header : void 0;
	const title = isRecord(header?.title) && typeof header.title.content === "string" ? header.title.content : void 0;
	return markRenderedFeishuCard({
		schema: "2.0",
		config: { width_mode: "fill" },
		...title?.trim() ? { header: {
			title: {
				tag: "plain_text",
				content: title
			},
			template: resolveFeishuCardTemplate(typeof header?.template === "string" ? header.template : void 0) ?? "blue"
		} } : {},
		body: { elements }
	});
}
function readNativeFeishuCard(payload) {
	const feishuData = payload.channelData?.feishu;
	if (!isRecord(feishuData)) return;
	const card = feishuData.card ?? feishuData.interactiveCard;
	if (!isRecord(card)) return;
	if (card[RENDERED_FEISHU_CARD] === true) return card;
	return sanitizeNativeFeishuCard(card);
}
function buildFeishuPayloadCard(params) {
	const nativeCard = readNativeFeishuCard(params.payload);
	if (nativeCard) return nativeCard;
	const interactive = normalizeInteractiveReply(params.payload.interactive);
	const presentation = normalizeMessagePresentation(params.payload.presentation) ?? (interactive ? interactiveReplyToPresentation(interactive) : void 0);
	if (!presentation && !interactive) return;
	const text = resolveInteractiveTextFallback({
		text: params.text ?? params.payload.text,
		interactive
	});
	const elements = presentation ? buildFeishuPresentationCardElements({
		presentation,
		fallbackText: text
	}) : [{
		tag: "markdown",
		content: renderMessagePresentationFallbackText({
			text,
			presentation
		})
	}];
	const identityTitle = params.identity ? params.identity.emoji ? `${params.identity.emoji} ${params.identity.name ?? ""}`.trim() : params.identity.name ?? "" : "";
	const title = presentation?.title ?? identityTitle;
	const template = resolveFeishuCardTemplate(presentation?.tone === "danger" ? "red" : presentation?.tone === "warning" ? "orange" : presentation?.tone === "success" ? "green" : "blue");
	return markRenderedFeishuCard({
		schema: "2.0",
		config: { width_mode: "fill" },
		...title ? { header: {
			title: {
				tag: "plain_text",
				content: title
			},
			template: template ?? "blue"
		} } : {},
		body: { elements }
	});
}
function renderFeishuPresentationPayload({ payload, presentation, ctx }) {
	const card = buildFeishuPayloadCard({
		payload,
		text: payload.text,
		identity: ctx.identity
	});
	if (!card) return null;
	const existingFeishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : void 0;
	return {
		...payload,
		text: renderMessagePresentationFallbackText({
			text: payload.text,
			presentation
		}),
		channelData: {
			...payload.channelData,
			feishu: {
				...existingFeishuData,
				card
			}
		}
	};
}
function resolveReplyToMessageId(params) {
	const replyToId = params.replyToId?.trim();
	if (replyToId) return replyToId;
	if (params.threadId == null) return;
	return String(params.threadId).trim() || void 0;
}
function resolveFeishuMediaReplyMode(params) {
	const trimmedReplyToId = params.replyToId?.trim() || void 0;
	return {
		replyToMessageId: resolveReplyToMessageId(params),
		replyInThread: params.threadId != null && !trimmedReplyToId
	};
}
async function sendCommentThreadReply(params) {
	const target = parseFeishuCommentTarget(params.to);
	if (!target) return null;
	const client = createFeishuClient(resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}));
	const replyId = params.replyId?.trim();
	try {
		const result = await deliverCommentThreadText(client, {
			file_token: target.fileToken,
			file_type: target.fileType,
			comment_id: target.commentId,
			content: params.text
		});
		return {
			messageId: typeof result.reply_id === "string" && result.reply_id || typeof result.comment_id === "string" && result.comment_id || "",
			chatId: target.commentId,
			result
		};
	} finally {
		if (replyId) cleanupAmbientCommentTypingReaction({
			client,
			deliveryContext: {
				channel: "feishu",
				to: params.to,
				threadId: replyId
			}
		});
	}
}
async function sendOutboundText(params) {
	const { cfg, to, text, accountId, replyToMessageId, replyInThread } = params;
	const commentResult = await sendCommentThreadReply({
		cfg,
		to,
		text,
		replyId: replyToMessageId,
		accountId
	});
	if (commentResult) return commentResult;
	const renderMode = resolveFeishuAccount({
		cfg,
		accountId
	}).config?.renderMode ?? "auto";
	if (renderMode === "card" || renderMode === "auto" && shouldUseCard(text)) return sendMarkdownCardFeishu({
		cfg,
		to,
		text,
		accountId,
		replyToMessageId,
		replyInThread
	});
	return sendMessageFeishu({
		cfg,
		to,
		text,
		accountId,
		replyToMessageId,
		replyInThread
	});
}
const feishuOutbound = {
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
	renderPresentation: renderFeishuPresentationPayload,
	sendPayload: async (ctx) => {
		const card = buildFeishuPayloadCard({
			payload: ctx.payload,
			text: ctx.text,
			identity: ctx.identity
		});
		if (!card) return await sendTextMediaPayload({
			channel: "feishu",
			ctx,
			adapter: feishuOutbound
		});
		const replyToMessageId = resolveReplyToMessageId({
			replyToId: ctx.replyToId,
			threadId: ctx.threadId
		});
		if (parseFeishuCommentTarget(ctx.to)) return await sendTextMediaPayload({
			channel: "feishu",
			ctx: {
				...ctx,
				payload: {
					...ctx.payload,
					text: renderMessagePresentationFallbackText({
						text: ctx.payload.text,
						presentation: normalizeMessagePresentation(ctx.payload.presentation) ?? (() => {
							const interactive = normalizeInteractiveReply(ctx.payload.interactive);
							return interactive ? interactiveReplyToPresentation(interactive) : void 0;
						})()
					}),
					interactive: void 0,
					presentation: void 0,
					channelData: void 0
				}
			},
			adapter: feishuOutbound
		});
		const mediaUrls = normalizeStringEntries(resolvePayloadMediaUrls(ctx.payload));
		return attachChannelToResult("feishu", await sendPayloadMediaSequenceAndFinalize({
			text: ctx.payload.text ?? "",
			mediaUrls,
			send: async ({ mediaUrl }) => await sendMediaFeishu({
				cfg: ctx.cfg,
				to: ctx.to,
				mediaUrl,
				accountId: ctx.accountId ?? void 0,
				mediaLocalRoots: ctx.mediaLocalRoots,
				replyToMessageId,
				...ctx.payload.audioAsVoice === true || ctx.audioAsVoice === true ? { audioAsVoice: true } : {}
			}),
			finalize: async () => await sendCardFeishu({
				cfg: ctx.cfg,
				to: ctx.to,
				card,
				replyToMessageId,
				replyInThread: ctx.threadId != null && !ctx.replyToId,
				accountId: ctx.accountId ?? void 0
			})
		}));
	},
	...createAttachedChannelResultAdapter({
		channel: "feishu",
		sendText: async ({ cfg, to, text, accountId, replyToId, threadId, mediaLocalRoots, identity }) => {
			const { replyToMessageId, replyInThread } = resolveFeishuMediaReplyMode({
				replyToId,
				threadId
			});
			const localImagePath = normalizePossibleLocalImagePath(text);
			if (localImagePath) try {
				return await sendMediaFeishu({
					cfg,
					to,
					mediaUrl: localImagePath,
					accountId: accountId ?? void 0,
					replyToMessageId,
					replyInThread,
					mediaLocalRoots
				});
			} catch (err) {
				console.error(`[feishu] local image path auto-send failed:`, err);
			}
			if (parseFeishuCommentTarget(to)) return await sendOutboundText({
				cfg,
				to,
				text,
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
			const renderMode = resolveFeishuAccount({
				cfg,
				accountId: accountId ?? void 0
			}).config?.renderMode ?? "auto";
			if (renderMode === "card" || renderMode === "auto" && shouldUseCard(text)) {
				const header = identity ? {
					title: identity.emoji ? `${identity.emoji} ${identity.name ?? ""}`.trim() : identity.name ?? "",
					template: "blue"
				} : void 0;
				return await sendStructuredCardFeishu({
					cfg,
					to,
					text,
					replyToMessageId,
					replyInThread,
					accountId: accountId ?? void 0,
					header: header?.title ? header : void 0
				});
			}
			return await sendOutboundText({
				cfg,
				to,
				text,
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, audioAsVoice, accountId, mediaLocalRoots, replyToId, threadId }) => {
			const { replyToMessageId, replyInThread } = resolveFeishuMediaReplyMode({
				replyToId,
				threadId
			});
			if (parseFeishuCommentTarget(to)) return await sendOutboundText({
				cfg,
				to,
				text: [text?.trim(), mediaUrl?.trim()].filter(Boolean).join("\n\n") || mediaUrl || text || "",
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
			const suppressTextForVoiceMedia = mediaUrl !== void 0 && shouldSuppressFeishuTextForVoiceMedia({
				mediaUrl,
				audioAsVoice
			});
			if (text?.trim() && !suppressTextForVoiceMedia) await sendOutboundText({
				cfg,
				to,
				text,
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
			if (mediaUrl) try {
				const result = await sendMediaFeishu({
					cfg,
					to,
					mediaUrl,
					accountId: accountId ?? void 0,
					mediaLocalRoots,
					replyToMessageId,
					replyInThread,
					...audioAsVoice === true ? { audioAsVoice: true } : {}
				});
				if (result.voiceIntentDegradedToFile && text?.trim()) await sendOutboundText({
					cfg,
					to,
					text,
					accountId: accountId ?? void 0,
					replyToMessageId,
					replyInThread
				});
				return result;
			} catch (err) {
				console.error(`[feishu] sendMediaFeishu failed:`, err);
				return await sendOutboundText({
					cfg,
					to,
					text: [text?.trim(), `📎 ${mediaUrl}`].filter(Boolean).join("\n\n"),
					accountId: accountId ?? void 0,
					replyToMessageId,
					replyInThread
				});
			}
			return await sendOutboundText({
				cfg,
				to,
				text: text ?? "",
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
		}
	})
};
//#endregion
export { feishuOutbound };
