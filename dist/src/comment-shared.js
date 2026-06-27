import { FEISHU_COMMENT_FILE_TYPES } from "./comment-target.js";
import { isRecord as isRecord$1, normalizeOptionalString, normalizeStringEntries, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/comment-shared.ts
function encodeQuery(params) {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		const trimmed = value?.trim();
		if (trimmed) query.set(key, trimmed);
	}
	const queryString = query.toString();
	return queryString ? `?${queryString}` : "";
}
const readString = readStringValue;
const normalizeString = normalizeOptionalString;
const isRecord = isRecord$1;
function formatFeishuApiError(error, options = {}) {
	if (!isRecord(error)) return typeof error === "string" ? error : JSON.stringify(error);
	const config = isRecord(error.config) ? error.config : void 0;
	const response = isRecord(error.response) ? error.response : void 0;
	const responseData = isRecord(response?.data) ? response?.data : void 0;
	const feishuLogId = readString(responseData?.log_id) || (options.includeNestedErrorLogId ? readString(isRecord(responseData?.error) ? responseData.error.log_id : void 0) : void 0);
	const nestedError = isRecord(responseData?.error) ? responseData.error : void 0;
	return JSON.stringify({
		message: typeof error.message === "string" ? error.message : typeof error === "string" ? error : JSON.stringify(error),
		code: readString(error.code),
		method: readString(config?.method),
		url: readString(config?.url),
		...options.includeConfigParams ? { params: config?.params } : {},
		http_status: typeof response?.status === "number" ? response.status : void 0,
		feishu_code: typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
		feishu_msg: readString(responseData?.msg),
		feishu_log_id: feishuLogId,
		feishu_troubleshooter: readString(responseData?.troubleshooter) || readString(nestedError?.troubleshooter)
	});
}
function formatFeishuApiFailure(error, errorPrefix, options = {}) {
	return `${errorPrefix}: ${formatFeishuApiError(error, options) || "unknown error"}`;
}
function createFeishuApiError(error, errorPrefix, options = {}) {
	return new Error(formatFeishuApiFailure(error, errorPrefix, options), { cause: error });
}
const FEISHU_SEND_RATE_LIMIT_CODES = /* @__PURE__ */ new Set([230020, 11232]);
const FEISHU_SEND_MAX_RETRIES = 2;
const FEISHU_SEND_RETRY_BASE_MS = 500;
/**
* Returns a numeric rate-limit signal when an AxiosError indicates a retryable
* Feishu message-API rate limit. Sources, in priority order:
*   1. Gateway-level HTTP 429 (app-wide quota; `x-ogw-ratelimit-reset` header)
*   2. Business-level `code` in `error.response.data.code` matching
*      FEISHU_SEND_RATE_LIMIT_CODES (e.g. 230020 per-chat, 11232 tenant-level).
* Returns `undefined` for all other errors so they propagate without retry.
*/
function getFeishuSendRateLimitCode(error) {
	if (!isRecord(error)) return;
	const response = isRecord(error.response) ? error.response : void 0;
	if (typeof response?.status === "number" && response.status === 429) return 429;
	const code = (isRecord(response?.data) ? response.data : void 0)?.code;
	return typeof code === "number" && FEISHU_SEND_RATE_LIMIT_CODES.has(code) ? code : void 0;
}
/**
* Returns a retryable rate-limit code when a fulfilled (non-throwing) Feishu
* SDK response embeds it in the response body. The Feishu node SDK can resolve
* with `{ code: 11232, msg: "..." }` instead of throwing — see typing.ts
* (getBackoffCodeFromResponse) and issue #28157 for the same behavior on
* messageReaction.create. Without this classification, requestFeishuApi would
* `return` the rate-limited body and downstream `assertFeishuMessageApiSuccess`
* would fail once with no retry.
*/
function getFeishuSendRateLimitCodeFromResponse(response) {
	if (!isRecord(response)) return;
	const code = response.code;
	return typeof code === "number" && FEISHU_SEND_RATE_LIMIT_CODES.has(code) ? code : void 0;
}
async function requestFeishuApi(request, errorPrefix, options = {}) {
	const retryDelayMs = options.retryDelayMs ?? FEISHU_SEND_RETRY_BASE_MS;
	let lastFulfilledRateLimit;
	for (let attempt = 0; attempt <= FEISHU_SEND_MAX_RETRIES; attempt++) {
		if (attempt > 0) await new Promise((resolve) => {
			setTimeout(resolve, attempt * retryDelayMs);
		});
		try {
			const result = await request();
			const fulfilledRateLimit = getFeishuSendRateLimitCodeFromResponse(result);
			if (fulfilledRateLimit !== void 0) {
				lastFulfilledRateLimit = {
					response: result,
					code: fulfilledRateLimit
				};
				if (attempt < FEISHU_SEND_MAX_RETRIES) continue;
				break;
			}
			return result;
		} catch (error) {
			if (!(attempt < FEISHU_SEND_MAX_RETRIES && getFeishuSendRateLimitCode(error) !== void 0)) throw createFeishuApiError(error, errorPrefix, options);
		}
	}
	if (lastFulfilledRateLimit) throw createFeishuApiError(Object.assign(/* @__PURE__ */ new Error(`Request fulfilled with rate-limit code ${lastFulfilledRateLimit.code}`), { response: {
		status: 200,
		data: lastFulfilledRateLimit.response
	} }), errorPrefix, options);
	throw createFeishuApiError(/* @__PURE__ */ new Error("unreachable"), errorPrefix, options);
}
function readDocsLinkUrl(element) {
	const docsLink = isRecord(element.docs_link) ? element.docs_link : void 0;
	return normalizeString(docsLink?.url) || normalizeString(docsLink?.link) || normalizeString(element.url) || normalizeString(element.link) || void 0;
}
function readMentionUserId(element) {
	const mention = isRecord(element.mention) ? element.mention : void 0;
	return normalizeString((isRecord(element.person) ? element.person : void 0)?.user_id) || normalizeString(mention?.user_id) || normalizeString(mention?.open_id) || normalizeString(element.mention_user) || normalizeString(element.user_id) || void 0;
}
function readMentionDisplayText(element, userId) {
	const mention = isRecord(element.mention) ? element.mention : void 0;
	const mentionName = normalizeString(mention?.name) || normalizeString(mention?.display_name) || normalizeString(element.name);
	return mentionName ? `@${mentionName}` : `@${userId}`;
}
function normalizeCommentText(parts) {
	return parts.join("").trim() || void 0;
}
function normalizeCommentSemanticText(parts) {
	return parts.join("").replace(/\s+/g, " ").trim() || void 0;
}
function readElementTextPreservingWhitespace(element) {
	return (isRecord(element.text_run) ? readString(element.text_run.content) || readString(element.text_run.text) : void 0) || readString(element.text) || readString(element.content) || readString(element.name) || void 0;
}
const FEISHU_LINK_TOKEN_MIN_LENGTH = 22;
const FEISHU_LINK_TOKEN_MAX_LENGTH = 28;
const COMMENT_LINK_KIND_ALIASES = /* @__PURE__ */ new Map([
	["doc", "doc"],
	["docs", "doc"],
	["docx", "docx"],
	["sheet", "sheet"],
	["sheets", "sheet"],
	["slide", "slides"],
	["slides", "slides"],
	["file", "file"],
	["files", "file"],
	["wiki", "wiki"],
	["mindnote", "mindnote"],
	["mindnotes", "mindnote"],
	["bitable", "bitable"],
	["base", "base"]
]);
function isCommentFileType(value) {
	return typeof value === "string" && FEISHU_COMMENT_FILE_TYPES.includes(value);
}
function isReasonableFeishuLinkToken(token) {
	return typeof token === "string" && token.length >= FEISHU_LINK_TOKEN_MIN_LENGTH && token.length <= FEISHU_LINK_TOKEN_MAX_LENGTH;
}
function parseCommentLinkedDocumentPath(pathname) {
	const segments = normalizeStringEntries(pathname.split("/"));
	const offset = segments[0]?.toLowerCase() === "space" ? 1 : 0;
	const kind = COMMENT_LINK_KIND_ALIASES.get(segments[offset]?.toLowerCase() ?? "");
	const token = normalizeString(segments[offset + 1]);
	if (!kind || !isReasonableFeishuLinkToken(token)) return null;
	return {
		urlKind: kind,
		token
	};
}
function hasResolvedLinkedDocumentReference(link) {
	return link.urlKind !== "unknown" && (Boolean(link.resolvedObjToken) || Boolean(link.wikiNodeToken));
}
function resolveCommentLinkedDocumentFromUrl(params) {
	const link = {
		rawUrl: params.rawUrl,
		urlKind: "unknown"
	};
	try {
		const parsedPath = parseCommentLinkedDocumentPath(new URL(params.rawUrl).pathname);
		if (!parsedPath) return link;
		const { urlKind, token } = parsedPath;
		link.urlKind = urlKind;
		if (urlKind === "wiki") {
			link.urlKind = "wiki";
			link.wikiNodeToken = token;
		} else {
			link.resolvedObjType = urlKind;
			link.resolvedObjToken = token;
		}
		if (link.resolvedObjType && link.resolvedObjToken && isCommentFileType(link.resolvedObjType) && params.currentDocument?.fileType === link.resolvedObjType && params.currentDocument.fileToken === link.resolvedObjToken) link.isCurrentDocument = true;
		else if (link.resolvedObjType && link.resolvedObjToken && isCommentFileType(link.resolvedObjType)) link.isCurrentDocument = false;
	} catch {
		return link;
	}
	return link;
}
function parseCommentContentElements(params) {
	const elements = Array.isArray(params.elements) ? params.elements : [];
	const plainTextParts = [];
	const semanticTextParts = [];
	const mentions = [];
	const linkedDocuments = [];
	const botIds = new Set(Array.from(params.botOpenIds ?? []).map((value) => normalizeString(value)).filter((value) => Boolean(value)));
	const linkedDocumentKeys = /* @__PURE__ */ new Set();
	let botMentioned = false;
	for (const rawElement of elements) {
		if (!isRecord(rawElement)) continue;
		const element = rawElement;
		const type = normalizeString(element.type);
		const text = (type === "text_run" ? readElementTextPreservingWhitespace(element) : void 0) || (type === "text" ? readElementTextPreservingWhitespace(element) : void 0) || (type === "docs_link" || type === "link" ? readDocsLinkUrl(element) : void 0) || (type === "mention" || type === "mention_user" || type === "person" ? (() => {
			const userId = readMentionUserId(element);
			return userId ? readMentionDisplayText(element, userId) : void 0;
		})() : void 0) || readElementTextPreservingWhitespace(element) || void 0;
		if (type === "mention" || type === "mention_user" || type === "person") {
			const userId = readMentionUserId(element);
			if (userId) {
				const displayText = readMentionDisplayText(element, userId);
				const isBotMention = botIds.has(userId);
				mentions.push({
					userId,
					displayText,
					isBotMention
				});
				plainTextParts.push(displayText);
				if (!isBotMention) semanticTextParts.push(displayText);
				else botMentioned = true;
				continue;
			}
		}
		if (type === "docs_link" || type === "link") {
			const rawUrl = readDocsLinkUrl(element);
			if (rawUrl) {
				plainTextParts.push(rawUrl);
				semanticTextParts.push(rawUrl);
				const linkedDocument = resolveCommentLinkedDocumentFromUrl({
					rawUrl,
					currentDocument: params.currentDocument
				});
				if (hasResolvedLinkedDocumentReference(linkedDocument)) {
					const key = [
						linkedDocument.rawUrl,
						linkedDocument.urlKind,
						linkedDocument.resolvedObjType,
						linkedDocument.resolvedObjToken,
						linkedDocument.wikiNodeToken
					].join(":");
					if (!linkedDocumentKeys.has(key)) {
						linkedDocumentKeys.add(key);
						linkedDocuments.push(linkedDocument);
					}
				}
				continue;
			}
		}
		if (text) {
			plainTextParts.push(text);
			semanticTextParts.push(text);
		}
	}
	return {
		plainText: normalizeCommentText(plainTextParts),
		semanticText: normalizeCommentSemanticText(semanticTextParts),
		mentions,
		linkedDocuments,
		botMentioned
	};
}
function extractReplyText(reply) {
	if (!reply || !isRecord(reply.content)) return;
	return parseCommentContentElements({ elements: Array.isArray(reply.content.elements) ? reply.content.elements : [] }).plainText;
}
//#endregion
export { createFeishuApiError, encodeQuery, extractReplyText, formatFeishuApiError, getFeishuSendRateLimitCode, getFeishuSendRateLimitCodeFromResponse, isRecord, normalizeString, parseCommentContentElements, readString, requestFeishuApi, resolveCommentLinkedDocumentFromUrl };
