import { createFeishuClient } from "./client.js";
import { asDateTimestampMs, resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/bot-sender-name.ts
const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];
const FEISHU_SCOPE_CORRECTIONS = { "contact:contact.base:readonly": "contact:user.base:readonly" };
const SENDER_NAME_TTL_MS = 600 * 1e3;
const senderNameCache = /* @__PURE__ */ new Map();
function correctFeishuScopeInUrl(url) {
	let corrected = url;
	for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
		corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
		corrected = corrected.replaceAll(wrong, right);
	}
	return corrected;
}
function shouldSuppressPermissionErrorNotice(permissionError) {
	const message = normalizeLowercaseStringOrEmpty(permissionError.message);
	return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}
function extractPermissionError(err) {
	if (!err || typeof err !== "object") return null;
	const data = err.response?.data;
	if (!data || typeof data !== "object") return null;
	const feishuErr = data;
	if (feishuErr.code !== 99991672) return null;
	const msg = feishuErr.msg ?? "";
	const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
	return {
		code: feishuErr.code,
		message: msg,
		grantUrl: urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : void 0
	};
}
function resolveSenderLookupIdType(senderId) {
	const trimmed = senderId.trim();
	if (trimmed.startsWith("ou_")) return "open_id";
	if (trimmed.startsWith("on_")) return "union_id";
	return "user_id";
}
async function resolveFeishuSenderName(params) {
	const { account, senderId, log } = params;
	if (!account.configured) return {};
	const normalizedSenderId = senderId.trim();
	if (!normalizedSenderId) return {};
	const cached = senderNameCache.get(normalizedSenderId);
	const now = asDateTimestampMs(Date.now());
	const cachedExpireAt = cached ? asDateTimestampMs(cached.expireAt) : void 0;
	if (cached && now !== void 0 && cachedExpireAt !== void 0 && cachedExpireAt > now) return { name: cached.name };
	if (cached) senderNameCache.delete(normalizedSenderId);
	try {
		const client = createFeishuClient(account);
		const userIdType = resolveSenderLookupIdType(normalizedSenderId);
		const user = (await client.contact.user.get({
			path: { user_id: normalizedSenderId },
			params: { user_id_type: userIdType }
		})).data?.user;
		const name = user?.name ?? user?.nickname ?? user?.en_name;
		if (name) {
			const expireAt = resolveExpiresAtMsFromDurationMs(SENDER_NAME_TTL_MS);
			if (expireAt !== void 0) senderNameCache.set(normalizedSenderId, {
				name,
				expireAt
			});
			return { name };
		}
		return {};
	} catch (err) {
		const permErr = extractPermissionError(err);
		if (permErr) {
			if (shouldSuppressPermissionErrorNotice(permErr)) {
				log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
				return {};
			}
			log(`feishu: permission error resolving sender name: code=${permErr.code}`);
			return { permissionError: permErr };
		}
		log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
		return {};
	}
}
//#endregion
export { resolveFeishuSenderName };
