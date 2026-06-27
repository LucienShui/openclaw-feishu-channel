import { buildFeishuConversationId } from "./conversation-id.js";
import { getFeishuRuntime } from "./runtime.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { saveMessageResourceFeishu } from "./media.js";
import { isFeishuBroadcastMention } from "./mention.js";
import { parsePostContent } from "./post.js";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
//#region src/bot-content.ts
function isFeishuTopicSessionScope(scope) {
	return scope === "group_topic" || scope === "group_topic_sender";
}
function resolveConfiguredFeishuGroupSessionScope(params) {
	const legacyTopicSessionMode = params.groupConfig?.topicSessionMode ?? params.feishuCfg?.topicSessionMode;
	return params.groupConfig?.groupSessionScope ?? params.feishuCfg?.groupSessionScope ?? (legacyTopicSessionMode === "enabled" || (params.chatType === "topic_group" || params.hasThread === true) && legacyTopicSessionMode !== "disabled" ? "group_topic" : "group");
}
function resolveFeishuGroupSession(params) {
	const { chatId, senderOpenId, messageId, rootId, threadId, chatType, groupConfig, feishuCfg } = params;
	const normalizedThreadId = threadId?.trim();
	const normalizedRootId = rootId?.trim();
	const threadReply = Boolean(normalizedThreadId || normalizedRootId);
	const replyInThread = (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled" || threadReply;
	const groupSessionScope = resolveConfiguredFeishuGroupSessionScope({
		groupConfig,
		feishuCfg,
		chatType,
		hasThread: chatType === "topic_group" || Boolean(normalizedThreadId && !normalizedRootId)
	});
	const isTopicScope = isFeishuTopicSessionScope(groupSessionScope);
	const topicScope = isTopicScope ? (chatType === "topic_group" ? normalizedThreadId ?? normalizedRootId : normalizedRootId ?? (isTopicScope ? normalizedThreadId : void 0)) ?? (replyInThread ? messageId : null) : null;
	let peerId;
	switch (groupSessionScope) {
		case "group_sender":
			peerId = buildFeishuConversationId({
				chatId,
				scope: "group_sender",
				senderOpenId
			});
			break;
		case "group_topic":
			peerId = topicScope ? buildFeishuConversationId({
				chatId,
				scope: "group_topic",
				topicId: topicScope
			}) : chatId;
			break;
		case "group_topic_sender":
			peerId = topicScope ? buildFeishuConversationId({
				chatId,
				scope: "group_topic_sender",
				topicId: topicScope,
				senderOpenId
			}) : buildFeishuConversationId({
				chatId,
				scope: "group_sender",
				senderOpenId
			});
			break;
		default:
			peerId = chatId;
			break;
	}
	return {
		peerId,
		parentPeer: topicScope && isTopicScope ? {
			kind: "group",
			id: chatId
		} : null,
		groupSessionScope,
		replyInThread,
		threadReply
	};
}
function parseMessageContent(content, messageType) {
	if (messageType === "post") return parsePostContent(content).textContent;
	try {
		const parsed = JSON.parse(content);
		if (messageType === "text") return parsed.text || "";
		if ([
			"image",
			"file",
			"audio",
			"video",
			"media",
			"sticker"
		].includes(messageType)) {
			if (messageType === "audio") {
				const speechToText = typeof parsed.speech_to_text === "string" ? parsed.speech_to_text.trim() : "";
				if (speechToText) return speechToText;
			}
			const placeholder = inferPlaceholder(messageType);
			const fileName = typeof parsed.file_name === "string" ? parsed.file_name.trim() : "";
			return fileName ? `${placeholder} (${fileName})` : placeholder;
		}
		if (messageType === "share_chat") {
			if (parsed && typeof parsed === "object") {
				const share = parsed;
				if (typeof share.body === "string" && share.body.trim()) return share.body.trim();
				if (typeof share.summary === "string" && share.summary.trim()) return share.summary.trim();
				if (typeof share.share_chat_id === "string" && share.share_chat_id.trim()) return `[Forwarded message: ${share.share_chat_id.trim()}]`;
			}
			return "[Forwarded message]";
		}
		if (messageType === "merge_forward") return "[Merged and Forwarded Message - loading...]";
		return content;
	} catch {
		return content;
	}
}
function formatSubMessageContent(content, contentType) {
	try {
		const parsed = JSON.parse(content);
		switch (contentType) {
			case "text": return parsed.text || content;
			case "post": return parsePostContent(content).textContent;
			case "image": return "[Image]";
			case "file": return `[File: ${parsed.file_name || "unknown"}]`;
			case "audio": return "[Audio]";
			case "video": return "[Video]";
			case "sticker": return "[Sticker]";
			case "merge_forward": return "[Nested Merged Forward]";
			default: return `[${contentType}]`;
		}
	} catch {
		return content;
	}
}
function parseMergeForwardContent(params) {
	const { content, log } = params;
	const maxMessages = 50;
	log?.("feishu: parsing merge_forward sub-messages from API response");
	let items;
	try {
		items = JSON.parse(content);
	} catch {
		log?.("feishu: merge_forward items parse failed");
		return "[Merged and Forwarded Message - parse error]";
	}
	if (!Array.isArray(items) || items.length === 0) return "[Merged and Forwarded Message - no sub-messages]";
	const subMessages = items.filter((item) => item.upper_message_id);
	if (subMessages.length === 0) return "[Merged and Forwarded Message - no sub-messages found]";
	log?.(`feishu: merge_forward contains ${subMessages.length} sub-messages`);
	subMessages.sort((a, b) => (parseStrictNonNegativeInteger(a.create_time) ?? 0) - (parseStrictNonNegativeInteger(b.create_time) ?? 0));
	const lines = ["[Merged and Forwarded Messages]"];
	for (const item of subMessages.slice(0, maxMessages)) lines.push(`- ${formatSubMessageContent(item.body?.content || "", item.msg_type || "text")}`);
	if (subMessages.length > maxMessages) lines.push(`... and ${subMessages.length - maxMessages} more messages`);
	return lines.join("\n");
}
function checkBotMentioned(event, botOpenId) {
	if (!botOpenId) return false;
	const mentions = event.message.mentions ?? [];
	if (mentions.length > 0) return mentions.some((mention) => !isFeishuBroadcastMention(mention) && mention.id.open_id === botOpenId);
	if (event.message.message_type === "post") return parsePostContent(event.message.content).mentionedOpenIds.some((id) => id.trim().toLowerCase() !== "all" && id === botOpenId);
	return false;
}
function normalizeMentions(text, mentions, botStripId) {
	if (!mentions || mentions.length === 0) return text;
	const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapeName = (value) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
	let result = text;
	for (const mention of mentions) {
		const mentionId = mention.id.open_id;
		const replacement = botStripId && mentionId === botStripId ? "" : mentionId ? `<at user_id="${mentionId}">${escapeName(mention.name)}</at>` : `@${mention.name}`;
		result = result.replace(new RegExp(escaped(mention.key), "g"), () => replacement).trim();
	}
	return result;
}
function normalizeFeishuCommandProbeBody(text) {
	if (!text) return "";
	return text.replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ").replace(/(^|\s)@[^/\s]+(?=\s|$|\/)/gu, "$1").replace(/\s+/g, " ").trim();
}
function parseMediaKeys(content, messageType) {
	try {
		const parsed = JSON.parse(content);
		const imageKey = normalizeFeishuExternalKey(parsed.image_key);
		const fileKey = normalizeFeishuExternalKey(parsed.file_key);
		switch (messageType) {
			case "image": return {
				imageKey,
				fileName: parsed.file_name
			};
			case "file":
			case "audio":
			case "sticker": return {
				fileKey,
				fileName: parsed.file_name
			};
			case "video":
			case "media": return {
				fileKey,
				imageKey,
				fileName: parsed.file_name
			};
			default: return {};
		}
	} catch {
		return {};
	}
}
function toMessageResourceType(messageType) {
	return messageType === "image" ? "image" : "file";
}
async function resolveSavedFeishuMedia(params) {
	if ("saved" in params.result) return params.result.saved;
	const core = getFeishuRuntime();
	const contentType = params.result.contentType ?? await core.media.detectMime({ buffer: params.result.buffer });
	return await core.channel.media.saveMediaBuffer(params.result.buffer, contentType, "inbound", params.maxBytes, params.result.fileName ?? params.originalFilename);
}
function inferPlaceholder(messageType) {
	switch (messageType) {
		case "image": return "<media:image>";
		case "file": return "<media:document>";
		case "audio": return "<media:audio>";
		case "video":
		case "media": return "<media:video>";
		case "sticker": return "<media:sticker>";
		default: return "<media:document>";
	}
}
async function resolveFeishuMediaList(params) {
	const { cfg, messageId, messageType, content, maxBytes, log, accountId } = params;
	if (![
		"image",
		"file",
		"audio",
		"video",
		"media",
		"sticker",
		"post"
	].includes(messageType)) return [];
	const out = [];
	if (messageType === "post") {
		const { imageKeys, mediaKeys } = parsePostContent(content);
		if (imageKeys.length === 0 && mediaKeys.length === 0) return [];
		if (imageKeys.length > 0) log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);
		if (mediaKeys.length > 0) log?.(`feishu: post message contains ${mediaKeys.length} embedded media file(s)`);
		for (const imageKey of imageKeys) try {
			const saved = await resolveSavedFeishuMedia({
				result: await saveMessageResourceFeishu({
					cfg,
					messageId,
					fileKey: imageKey,
					type: "image",
					accountId,
					maxBytes
				}),
				maxBytes
			});
			out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: "<media:image>"
			});
			log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}`);
		} catch (err) {
			log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
		}
		for (const media of mediaKeys) try {
			const saved = await resolveSavedFeishuMedia({
				result: await saveMessageResourceFeishu({
					cfg,
					messageId,
					fileKey: media.fileKey,
					type: "file",
					accountId,
					maxBytes,
					originalFilename: media.fileName
				}),
				maxBytes,
				originalFilename: media.fileName
			});
			out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: "<media:video>"
			});
			log?.(`feishu: downloaded embedded media ${media.fileKey}, saved to ${saved.path}`);
		} catch (err) {
			log?.(`feishu: failed to download embedded media ${media.fileKey}: ${String(err)}`);
		}
		return out;
	}
	const mediaKeys = parseMediaKeys(content, messageType);
	if (!mediaKeys.imageKey && !mediaKeys.fileKey) return [];
	try {
		const fileKey = mediaKeys.fileKey || mediaKeys.imageKey;
		if (!fileKey) return [];
		const saved = await resolveSavedFeishuMedia({
			result: await saveMessageResourceFeishu({
				cfg,
				messageId,
				fileKey,
				type: toMessageResourceType(messageType),
				accountId,
				maxBytes,
				originalFilename: mediaKeys.fileName
			}),
			maxBytes,
			originalFilename: mediaKeys.fileName
		});
		out.push({
			path: saved.path,
			contentType: saved.contentType,
			placeholder: inferPlaceholder(messageType)
		});
		log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}`);
	} catch (err) {
		log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
	}
	return out;
}
//#endregion
export { checkBotMentioned, isFeishuTopicSessionScope, normalizeFeishuCommandProbeBody, normalizeMentions, parseMergeForwardContent, parseMessageContent, resolveConfiguredFeishuGroupSessionScope, resolveFeishuGroupSession, resolveFeishuMediaList, toMessageResourceType };
