import { normalizeFeishuExternalKey } from "./external-keys.js";
import { parsePostContent } from "./post.js";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createHash } from "node:crypto";
//#region src/dedupe-key.ts
function readExternalKey(value) {
	return normalizeFeishuExternalKey(typeof value === "string" ? value : "");
}
function parseContentRecord(content) {
	try {
		return asNullableRecord(JSON.parse(content));
	} catch {
		return null;
	}
}
function buildMediaDedupeKey(messageId, mediaParts) {
	return JSON.stringify([messageId, ...mediaParts]);
}
function resolvePostMediaParts(content) {
	const parsed = parsePostContent(content);
	return [...parsed.imageKeys.map((imageKey) => `image_key:${imageKey}`), ...parsed.mediaKeys.map((media) => `file_key:${media.fileKey}`)];
}
function resolveMessageMediaParts(messageType, content) {
	if (messageType === "post") return resolvePostMediaParts(content);
	const parsed = parseContentRecord(content);
	if (!parsed) return [];
	const imageKey = readExternalKey(parsed.image_key);
	const fileKey = readExternalKey(parsed.file_key);
	switch (messageType) {
		case "image": return imageKey ? [`image_key:${imageKey}`] : [];
		case "file":
		case "audio":
		case "sticker": return fileKey ? [`file_key:${fileKey}`] : [];
		case "video":
		case "media": return fileKey ? [`file_key:${fileKey}`] : imageKey ? [`image_key:${imageKey}`] : [];
		default: return fileKey ? [`file_key:${fileKey}`] : imageKey ? [`image_key:${imageKey}`] : [];
	}
}
function resolveSenderIdentity(event) {
	const senderId = event.sender?.sender_id;
	return senderId?.open_id?.trim() || senderId?.union_id?.trim() || senderId?.user_id?.trim() || void 0;
}
function resolveTextRetryDedupeKey(event) {
	const createTime = event.message.create_time?.trim();
	const chatId = event.message.chat_id?.trim();
	const senderId = resolveSenderIdentity(event);
	if (!createTime || parseStrictNonNegativeInteger(createTime) === void 0 || !chatId || !senderId) return;
	const contentHash = createHash("sha256").update(event.message.content, "utf8").digest("hex").slice(0, 32);
	return JSON.stringify([
		"text-retry",
		senderId,
		chatId,
		createTime,
		contentHash
	]);
}
function resolveFeishuMessageDedupeKey(event) {
	const messageId = event.message.message_id?.trim();
	if (!messageId) return;
	const messageType = event.message.message_type.trim();
	const mediaParts = resolveMessageMediaParts(messageType, event.message.content);
	if (mediaParts.length > 0) return buildMediaDedupeKey(messageId, mediaParts);
	if (messageType === "text") return resolveTextRetryDedupeKey(event) ?? messageId;
	return messageId;
}
//#endregion
export { resolveFeishuMessageDedupeKey };
