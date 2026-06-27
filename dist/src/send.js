import { requestFeishuApi } from "./comment-shared.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { assertFeishuMessageApiSuccess, resolveFeishuReceiptKind, toFeishuSendResult } from "./send-result.js";
import { createFeishuClient } from "./client.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import { buildMentionedCardContent } from "./mention.js";
import { parsePostContent } from "./post.js";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { isRecord, normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
//#region src/send.ts
const WITHDRAWN_REPLY_ERROR_CODES = /* @__PURE__ */ new Set([230011, 231003]);
const INTERACTIVE_CARD_FALLBACK_TEXT = "[Interactive Card]";
const POST_FALLBACK_TEXT = "[Rich text message]";
const FEISHU_CARD_TEMPLATES = /* @__PURE__ */ new Set([
	"blue",
	"green",
	"red",
	"orange",
	"purple",
	"indigo",
	"wathet",
	"turquoise",
	"yellow",
	"grey",
	"carmine",
	"violet",
	"lime"
]);
function shouldFallbackFromReplyTarget(response) {
	if (response.code !== void 0 && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) return true;
	const msg = normalizeLowercaseStringOrEmpty(response.msg);
	return msg.includes("withdrawn") || msg.includes("not found");
}
/** Check whether a thrown error indicates a withdrawn/not-found reply target. */
function isWithdrawnReplyError(err) {
	if (typeof err !== "object" || err === null) return false;
	const code = err.code;
	if (typeof code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(code)) return true;
	const response = err.response;
	if (typeof response?.data?.code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code)) return true;
	const cause = err.cause;
	if (cause && cause !== err) return isWithdrawnReplyError(cause);
	return false;
}
/** Send a direct message as a fallback when a reply target is unavailable. */
async function sendFallbackDirect(client, params, errorPrefix) {
	const response = await requestFeishuApi(() => client.im.message.create({
		params: { receive_id_type: params.receiveIdType },
		data: {
			receive_id: params.receiveId,
			content: params.content,
			msg_type: params.msgType
		}
	}), errorPrefix, { includeNestedErrorLogId: true });
	assertFeishuMessageApiSuccess(response, errorPrefix);
	return toFeishuSendResult(response, params.receiveId, resolveFeishuReceiptKind(params.msgType));
}
async function sendReplyOrFallbackDirect(client, params) {
	if (!params.replyToMessageId) return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
	const replyTargetFallbackError = params.replyInThread && params.allowTopLevelReplyFallback !== true ? /* @__PURE__ */ new Error("Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.") : null;
	let response;
	try {
		response = await requestFeishuApi(() => client.im.message.reply({
			path: { message_id: params.replyToMessageId },
			data: {
				content: params.content,
				msg_type: params.msgType,
				...params.replyInThread ? { reply_in_thread: true } : {}
			}
		}), params.replyErrorPrefix, { includeNestedErrorLogId: true });
	} catch (err) {
		if (!isWithdrawnReplyError(err)) throw err;
		if (replyTargetFallbackError) throw replyTargetFallbackError;
		return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
	}
	if (shouldFallbackFromReplyTarget(response)) {
		if (replyTargetFallbackError) throw replyTargetFallbackError;
		return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
	}
	assertFeishuMessageApiSuccess(response, params.replyErrorPrefix);
	return toFeishuSendResult(response, params.directParams.receiveId, resolveFeishuReceiptKind(params.msgType));
}
function normalizeCardTemplateVariable(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
}
function readCardTemplateVariables(parsed) {
	const variables = /* @__PURE__ */ new Map();
	for (const source of [parsed.template_variable, parsed.template_variables]) {
		if (!isRecord(source)) continue;
		for (const [key, value] of Object.entries(source)) {
			const normalized = normalizeCardTemplateVariable(value);
			if (normalized !== void 0) variables.set(key, normalized);
		}
	}
	return variables;
}
function applyCardTemplateVariables(text, variables) {
	if (variables.size === 0) return text;
	return text.replace(/\$\{([A-Za-z0-9_.-]+)\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, a, b) => {
		const variableName = typeof a === "string" ? a : b;
		return variables.get(variableName) ?? match;
	});
}
function extractInteractiveElementText(element, variables) {
	if (!isRecord(element)) return;
	const tag = typeof element.tag === "string" ? element.tag : "";
	const text = isRecord(element.text) ? element.text : void 0;
	if (tag === "div" && typeof text?.content === "string") return applyCardTemplateVariables(text.content, variables);
	if ((tag === "markdown" || tag === "lark_md") && typeof element.content === "string") return applyCardTemplateVariables(element.content, variables);
	if (tag === "plain_text" && typeof element.content === "string") return applyCardTemplateVariables(element.content, variables);
}
function extractInteractiveElementsText(elements, variables) {
	const texts = [];
	for (const element of elements) {
		const text = extractInteractiveElementText(element, variables);
		if (text !== void 0) texts.push(text);
	}
	return texts.join("\n").trim();
}
function readInteractiveElementArrays(parsed) {
	const body = isRecord(parsed.body) ? parsed.body : void 0;
	const elementArrays = [];
	for (const candidate of [parsed.elements, body?.elements]) if (Array.isArray(candidate)) elementArrays.push(candidate);
	for (const candidate of [parsed.i18n_elements, body?.i18n_elements]) {
		if (!isRecord(candidate)) continue;
		for (const localeElements of Object.values(candidate)) if (Array.isArray(localeElements)) elementArrays.push(localeElements);
	}
	return elementArrays;
}
function parseInteractivePostFallback(parsed) {
	const textContent = parsePostContent(JSON.stringify(parsed)).textContent.trim();
	return textContent && textContent !== POST_FALLBACK_TEXT ? textContent : void 0;
}
function parseInteractiveCardContent(parsed) {
	if (!isRecord(parsed)) return INTERACTIVE_CARD_FALLBACK_TEXT;
	const variables = readCardTemplateVariables(parsed);
	for (const elements of readInteractiveElementArrays(parsed)) {
		const text = extractInteractiveElementsText(elements, variables);
		if (text) return text;
	}
	return parseInteractivePostFallback(parsed) ?? INTERACTIVE_CARD_FALLBACK_TEXT;
}
function parseFeishuMessageContent(rawContent, msgType) {
	if (!rawContent) return "";
	let parsed;
	try {
		parsed = JSON.parse(rawContent);
	} catch {
		return rawContent;
	}
	if (msgType === "text") {
		const text = parsed?.text;
		return typeof text === "string" ? text : "[Text message]";
	}
	if (msgType === "post") return parsePostContent(rawContent).textContent;
	if (msgType === "interactive") return parseInteractiveCardContent(parsed);
	if (typeof parsed === "string") return parsed;
	const genericText = parsed?.text;
	if (typeof genericText === "string" && genericText.trim()) return genericText;
	const genericTitle = parsed?.title;
	if (typeof genericTitle === "string" && genericTitle.trim()) return genericTitle;
	return `[${msgType || "unknown"} message]`;
}
function parseFeishuMessageItem(item, fallbackMessageId) {
	const msgType = item.msg_type ?? "text";
	const rawContent = item.body?.content ?? "";
	return {
		messageId: item.message_id ?? fallbackMessageId ?? "",
		chatId: item.chat_id ?? "",
		chatType: item.chat_type === "group" || item.chat_type === "topic_group" || item.chat_type === "private" || item.chat_type === "p2p" ? item.chat_type : void 0,
		senderId: item.sender?.id,
		senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : void 0,
		senderType: item.sender?.sender_type,
		content: parseFeishuMessageContent(rawContent, msgType),
		contentType: msgType,
		createTime: parseStrictNonNegativeInteger(item.create_time),
		threadId: item.thread_id || void 0
	};
}
/**
* Get a message by its ID.
* Useful for fetching quoted/replied message content.
*/
async function getMessageFeishu(params) {
	const { cfg, messageId, accountId } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const client = createFeishuClient(account);
	try {
		const response = await client.im.message.get({
			params: { card_msg_content_type: "user_card_content" },
			path: { message_id: messageId }
		});
		if (response.code !== 0) return null;
		const rawItem = response.data?.items?.[0] ?? response.data;
		const item = rawItem && (rawItem.body !== void 0 || rawItem.message_id !== void 0) ? rawItem : null;
		if (!item) return null;
		return parseFeishuMessageItem(item, messageId);
	} catch {
		return null;
	}
}
/**
* List messages in a Feishu thread (topic).
* Uses container_id_type=thread to directly query thread messages,
* which includes both the root message and all replies (including bot replies).
*/
async function listFeishuThreadMessages(params) {
	const { cfg, threadId, currentMessageId, rootMessageId, limit = 20, accountId } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const response = await createFeishuClient(account).im.message.list({ params: {
		container_id_type: "thread",
		container_id: threadId,
		sort_type: "ByCreateTimeDesc",
		page_size: Math.min(limit + 1, 50),
		card_msg_content_type: "user_card_content"
	} });
	if (response.code !== 0) throw new Error(`Feishu thread list failed: code=${response.code} msg=${response.msg ?? "unknown"}`);
	const items = response.data?.items ?? [];
	const results = [];
	for (const item of items) {
		if (currentMessageId && item.message_id === currentMessageId) continue;
		if (rootMessageId && item.message_id === rootMessageId) continue;
		const parsed = parseFeishuMessageItem(item);
		results.push({
			messageId: parsed.messageId,
			senderId: parsed.senderId,
			senderType: parsed.senderType,
			content: parsed.content,
			contentType: parsed.contentType,
			createTime: parsed.createTime
		});
		if (results.length >= limit) break;
	}
	results.reverse();
	return results;
}
function buildFeishuPostMentionElements(mentions) {
	if (!mentions?.length) return [];
	const elements = [];
	for (const mention of mentions) {
		const userId = mention.openId.trim();
		if (!userId) continue;
		const userName = mention.name.trim();
		elements.push({
			tag: "at",
			user_id: userId,
			...userName ? { user_name: userName } : {}
		});
	}
	return elements;
}
function buildFeishuPostMessagePayload(params) {
	const { messageText, mentions } = params;
	const content = [...buildFeishuPostMentionElements(mentions), {
		tag: "md",
		text: messageText
	}];
	return {
		content: JSON.stringify({ zh_cn: { content: [content] } }),
		msgType: "post"
	};
}
async function sendMessageFeishu(params) {
	const { cfg, to, text, replyToMessageId, replyInThread, allowTopLevelReplyFallback, mentions, accountId } = params;
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "feishu"
	});
	const { content, msgType } = buildFeishuPostMessagePayload({
		messageText: convertMarkdownTables(text ?? "", tableMode),
		mentions
	});
	return sendReplyOrFallbackDirect(client, {
		replyToMessageId,
		replyInThread,
		allowTopLevelReplyFallback,
		content,
		msgType,
		directParams: {
			receiveId,
			receiveIdType,
			content,
			msgType
		},
		directErrorPrefix: "Feishu send failed",
		replyErrorPrefix: "Feishu reply failed"
	});
}
async function sendCardFeishu(params) {
	const { cfg, to, card, replyToMessageId, replyInThread, allowTopLevelReplyFallback, accountId } = params;
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const content = JSON.stringify(card);
	return sendReplyOrFallbackDirect(client, {
		replyToMessageId,
		replyInThread,
		allowTopLevelReplyFallback,
		content,
		msgType: "interactive",
		directParams: {
			receiveId,
			receiveIdType,
			content,
			msgType: "interactive"
		},
		directErrorPrefix: "Feishu card send failed",
		replyErrorPrefix: "Feishu card reply failed"
	});
}
async function editMessageFeishu(params) {
	const { cfg, messageId, text, card, accountId } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	if ((typeof text === "string" && text.trim().length > 0) === Boolean(card)) throw new Error("Feishu edit requires exactly one of text or card.");
	const client = createFeishuClient(account);
	if (card) {
		const content = JSON.stringify(card);
		const response = await client.im.message.patch({
			path: { message_id: messageId },
			data: { content }
		});
		if (response.code !== 0) throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
		return {
			messageId,
			contentType: "interactive"
		};
	}
	const payload = buildFeishuPostMessagePayload({ messageText: convertMarkdownTables(text, resolveMarkdownTableMode({
		cfg,
		channel: "feishu"
	})) });
	const response = await client.im.message.patch({
		path: { message_id: messageId },
		data: { content: payload.content }
	});
	if (response.code !== 0) throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
	return {
		messageId,
		contentType: "post"
	};
}
/**
* Build a Feishu interactive card with markdown content.
* Cards render markdown properly (code blocks, tables, links, etc.)
* Uses schema 2.0 format for proper markdown rendering.
*/
function buildMarkdownCard(text) {
	return {
		schema: "2.0",
		config: { width_mode: "fill" },
		body: { elements: [{
			tag: "markdown",
			content: text
		}] }
	};
}
function resolveFeishuCardTemplate(template) {
	const normalized = normalizeOptionalLowercaseString(template);
	if (!normalized || !FEISHU_CARD_TEMPLATES.has(normalized)) return;
	return normalized;
}
/**
* Build a Feishu interactive card with optional header and note footer.
* When header/note are omitted, behaves identically to buildMarkdownCard.
*/
function buildStructuredCard(text, options) {
	const elements = [{
		tag: "markdown",
		content: text
	}];
	if (options?.note) {
		elements.push({ tag: "hr" });
		elements.push({
			tag: "markdown",
			content: `<font color='grey'>${options.note}</font>`
		});
	}
	const card = {
		schema: "2.0",
		config: { width_mode: "fill" },
		body: { elements }
	};
	if (options?.header) card.header = {
		title: {
			tag: "plain_text",
			content: options.header.title
		},
		template: resolveFeishuCardTemplate(options.header.template) ?? "blue"
	};
	return card;
}
/**
* Send a message as a structured card with optional header and note.
*/
async function sendStructuredCardFeishu(params) {
	const { cfg, to, text, replyToMessageId, replyInThread, allowTopLevelReplyFallback, mentions, accountId, header, note } = params;
	let cardText = text;
	if (mentions && mentions.length > 0) cardText = buildMentionedCardContent(mentions, text);
	return sendCardFeishu({
		cfg,
		to,
		card: buildStructuredCard(cardText, {
			header,
			note
		}),
		replyToMessageId,
		replyInThread,
		allowTopLevelReplyFallback,
		accountId
	});
}
/**
* Send a message as a markdown card (interactive message).
* This renders markdown properly in Feishu (code blocks, tables, bold/italic, etc.)
*/
async function sendMarkdownCardFeishu(params) {
	const { cfg, to, text, replyToMessageId, replyInThread, allowTopLevelReplyFallback, mentions, accountId } = params;
	let cardText = text;
	if (mentions && mentions.length > 0) cardText = buildMentionedCardContent(mentions, text);
	return sendCardFeishu({
		cfg,
		to,
		card: buildMarkdownCard(cardText),
		replyToMessageId,
		replyInThread,
		allowTopLevelReplyFallback,
		accountId
	});
}
//#endregion
export { buildFeishuPostMessagePayload, buildMarkdownCard, buildStructuredCard, editMessageFeishu, getMessageFeishu, listFeishuThreadMessages, resolveFeishuCardTemplate, sendCardFeishu, sendMarkdownCardFeishu, sendMessageFeishu, sendStructuredCardFeishu };
