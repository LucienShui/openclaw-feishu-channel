import { parseFeishuCommentTarget } from "./comment-target.js";
import { encodeQuery, formatFeishuApiError } from "./comment-shared.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
//#region src/comment-reaction.ts
const COMMENT_TYPING_REACTION_TYPE = "Typing";
const COMMENT_REACTION_TIMEOUT_MS = 3e4;
const commentTypingReactionState = /* @__PURE__ */ new Map();
function buildCommentTypingReactionKey(params) {
	return `${params.fileType}:${params.fileToken}:${params.replyId}`;
}
function ensureCommentTypingReactionState(key) {
	const existing = commentTypingReactionState.get(key);
	if (existing) return existing;
	const created = {
		active: false,
		cleaned: false,
		cleanupPromise: void 0
	};
	commentTypingReactionState.set(key, created);
	return created;
}
async function requestCommentTypingReactionWithClient(params) {
	try {
		const response = await params.client.request({
			method: "POST",
			url: `/open-apis/drive/v2/files/${encodeURIComponent(params.fileToken)}/comments/reaction` + encodeQuery({ file_type: params.fileType }),
			data: {
				action: params.action,
				reply_id: params.replyId,
				reaction_type: COMMENT_TYPING_REACTION_TYPE
			},
			timeout: COMMENT_REACTION_TIMEOUT_MS
		});
		if (response.code === 0) return true;
		params.runtime?.log?.(`${params.logPrefix ?? "[feishu]"}: comment typing reaction ${params.action} failed reply=${params.replyId} file=${params.fileType}:${params.fileToken} code=${response.code ?? "unknown"} msg=${response.msg ?? "unknown"} log_id=${response.log_id ?? response.error?.log_id ?? "unknown"}`);
	} catch (error) {
		params.runtime?.log?.(`${params.logPrefix ?? "[feishu]"}: comment typing reaction ${params.action} threw reply=${params.replyId} file=${params.fileType}:${params.fileToken} error=${formatCommentReactionFailure(error)}`);
	}
	return false;
}
function formatCommentReactionFailure(error) {
	return formatFeishuApiError(error, { includeNestedErrorLogId: true });
}
async function requestCommentTypingReaction(params) {
	const account = resolveFeishuRuntimeAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured || !(account.config.typingIndicator ?? true)) return false;
	return requestCommentTypingReactionWithClient({
		client: createFeishuClient(account),
		fileToken: params.fileToken,
		fileType: params.fileType,
		replyId: params.replyId,
		action: params.action,
		runtime: params.runtime,
		logPrefix: `feishu[${account.accountId}]`
	});
}
async function cleanupCommentTypingReactionByKey(params) {
	const state = ensureCommentTypingReactionState(params.key);
	if (state.cleaned) return false;
	if (state.cleanupPromise) return await state.cleanupPromise;
	const cleanupPromise = (async () => {
		if (!state.active) {
			state.cleaned = true;
			return false;
		}
		const deleted = await params.performDelete();
		if (deleted) {
			state.cleaned = true;
			state.active = false;
		}
		return deleted;
	})();
	state.cleanupPromise = cleanupPromise;
	try {
		return await cleanupPromise;
	} finally {
		state.cleanupPromise = void 0;
		if (state.cleaned) {
			state.active = false;
			commentTypingReactionState.delete(params.key);
		}
	}
}
async function cleanupAmbientCommentTypingReaction(params) {
	const deliveryContext = params.deliveryContext;
	if (deliveryContext?.channel && deliveryContext.channel !== "feishu" && deliveryContext.channel !== "feishu-comment") return false;
	const target = parseFeishuCommentTarget(deliveryContext?.to);
	const replyId = typeof deliveryContext?.threadId === "string" || typeof deliveryContext?.threadId === "number" ? String(deliveryContext.threadId).trim() : "";
	if (!target || !replyId) return false;
	return cleanupCommentTypingReactionByKey({
		key: buildCommentTypingReactionKey({
			fileToken: target.fileToken,
			fileType: target.fileType,
			replyId
		}),
		performDelete: () => requestCommentTypingReactionWithClient({
			client: params.client,
			fileToken: target.fileToken,
			fileType: target.fileType,
			replyId,
			action: "delete",
			runtime: params.runtime,
			logPrefix: "[feishu]"
		})
	});
}
function createCommentTypingReactionLifecycle(params) {
	const key = params.replyId?.trim() ? buildCommentTypingReactionKey({
		fileToken: params.fileToken,
		fileType: params.fileType,
		replyId: params.replyId.trim()
	}) : void 0;
	const state = key ? ensureCommentTypingReactionState(key) : void 0;
	return {
		start: async () => {
			const replyId = params.replyId?.trim();
			if (!state || state.cleaned || state.active || !replyId) return;
			state.active = await requestCommentTypingReaction({
				cfg: params.cfg,
				fileToken: params.fileToken,
				fileType: params.fileType,
				replyId,
				action: "add",
				accountId: params.accountId,
				runtime: params.runtime
			});
		},
		cleanup: async () => {
			const replyId = params.replyId?.trim();
			if (!key || !replyId) return;
			await cleanupCommentTypingReactionByKey({
				key,
				performDelete: () => requestCommentTypingReaction({
					cfg: params.cfg,
					fileToken: params.fileToken,
					fileType: params.fileType,
					replyId,
					action: "delete",
					accountId: params.accountId,
					runtime: params.runtime
				})
			});
		}
	};
}
//#endregion
export { cleanupAmbientCommentTypingReaction, createCommentTypingReactionLifecycle };
