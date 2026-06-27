import { releaseFeishuMessageProcessing } from "./processing-claims.js";
import { claimUnprocessedFeishuMessage, recordProcessedFeishuMessage } from "./dedup.js";
import { parseFeishuDriveCommentNoticeEventPayload } from "./monitor.comment.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { botOpenIds } from "./monitor.state.js";
import { isFeishuRetryableSyntheticEventError } from "./monitor.synthetic-error.js";
import { createSequentialQueue } from "./sequential-queue.js";
//#region src/monitor.comment-notice-handler.ts
function buildCommentNoticeQueueKey(event) {
	return `comment-doc:${event.notice_meta?.file_type?.trim() || "unknown"}:${event.notice_meta?.file_token?.trim() || "unknown"}`;
}
function createFeishuDriveCommentNoticeHandler(params) {
	const { cfg, accountId, runtime, fireAndForget } = params;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	const enqueue = createSequentialQueue();
	const getBotOpenId = params.getBotOpenId ?? ((id) => botOpenIds.get(id));
	const runFeishuHandler = async (task) => {
		const promise = task().catch((err) => {
			error(`feishu[${accountId}]: error handling drive comment notice: ${String(err)}`);
		});
		if (!fireAndForget) await promise;
	};
	return async (data) => {
		await runFeishuHandler(async () => {
			const event = parseFeishuDriveCommentNoticeEventPayload(data);
			if (!event) {
				error(`feishu[${accountId}]: ignoring malformed drive comment notice payload`);
				return;
			}
			const eventId = event.event_id?.trim();
			const syntheticMessageId = eventId ? `drive-comment:${eventId}` : void 0;
			if (syntheticMessageId) {
				const claim = await claimUnprocessedFeishuMessage({
					messageId: syntheticMessageId,
					namespace: accountId,
					log
				});
				if (claim === "duplicate") {
					log(`feishu[${accountId}]: dropping duplicate comment event ${syntheticMessageId}`);
					return;
				}
				if (claim === "inflight") {
					log(`feishu[${accountId}]: dropping in-flight comment event ${syntheticMessageId}`);
					return;
				}
			}
			log(`feishu[${accountId}]: received drive comment notice event=${event.event_id ?? "unknown"} type=${event.notice_meta?.notice_type ?? "unknown"} file=${event.notice_meta?.file_type ?? "unknown"}:${event.notice_meta?.file_token ?? "unknown"} comment=${event.comment_id ?? "unknown"} reply=${event.reply_id ?? "none"} from=${event.notice_meta?.from_user_id?.open_id ?? "unknown"} mentioned=${event.is_mentioned === true ? "yes" : "no"}`);
			try {
				await enqueue(buildCommentNoticeQueueKey(event), async () => {
					await handleFeishuCommentEvent({
						cfg,
						accountId,
						event,
						botOpenId: getBotOpenId(accountId),
						runtime
					});
				});
				if (syntheticMessageId) await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
			} catch (err) {
				if (syntheticMessageId && !isFeishuRetryableSyntheticEventError(err)) await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
				throw err;
			} finally {
				if (syntheticMessageId) releaseFeishuMessageProcessing(syntheticMessageId, accountId);
			}
		});
	};
}
//#endregion
export { createFeishuDriveCommentNoticeHandler };
