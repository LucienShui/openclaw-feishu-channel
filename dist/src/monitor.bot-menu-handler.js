import { releaseFeishuMessageProcessing } from "./processing-claims.js";
import { claimUnprocessedFeishuMessage, forgetProcessedFeishuMessage, recordProcessedFeishuMessage } from "./dedup.js";
import { handleFeishuMessage } from "./bot.js";
import { maybeHandleFeishuQuickActionMenu } from "./card-ux-launcher.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { isFeishuRetryableSyntheticEventError } from "./monitor.synthetic-error.js";
import { isRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/monitor.bot-menu-handler.ts
function readStringOrNumber(value) {
	return typeof value === "string" || typeof value === "number" ? value : void 0;
}
function parseFeishuBotMenuEvent(value) {
	if (!isRecord(value)) return null;
	const operator = value.operator;
	if (operator !== void 0 && !isRecord(operator)) return null;
	return {
		event_key: readStringValue(value.event_key),
		timestamp: readStringOrNumber(value.timestamp),
		operator: operator ? {
			operator_name: readStringValue(operator.operator_name),
			operator_id: isRecord(operator.operator_id) ? {
				open_id: readStringValue(operator.operator_id.open_id),
				user_id: readStringValue(operator.operator_id.user_id),
				union_id: readStringValue(operator.operator_id.union_id)
			} : void 0
		} : void 0
	};
}
function createFeishuBotMenuHandler(params) {
	const { cfg, accountId, runtime, chatHistories, fireAndForget } = params;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	const getBotOpenId = params.getBotOpenId ?? ((id) => botOpenIds.get(id));
	const getBotName = params.getBotName ?? ((id) => botNames.get(id));
	return async (data) => {
		try {
			const event = parseFeishuBotMenuEvent(data);
			if (!event) return;
			const operatorOpenId = event.operator?.operator_id?.open_id?.trim();
			const eventKey = event.event_key?.trim();
			if (!operatorOpenId || !eventKey) return;
			const syntheticEvent = {
				sender: {
					sender_id: {
						open_id: operatorOpenId,
						user_id: event.operator?.operator_id?.user_id,
						union_id: event.operator?.operator_id?.union_id
					},
					sender_type: "user"
				},
				message: {
					message_id: `bot-menu:${eventKey}:${event.timestamp ?? Date.now()}`,
					suppress_reply_target: true,
					chat_id: `p2p:${operatorOpenId}`,
					chat_type: "p2p",
					message_type: "text",
					content: JSON.stringify({ text: `/menu ${eventKey}` })
				}
			};
			const syntheticMessageId = syntheticEvent.message.message_id;
			const claim = await claimUnprocessedFeishuMessage({
				messageId: syntheticMessageId,
				namespace: accountId,
				log
			});
			if (claim === "duplicate") {
				log(`feishu[${accountId}]: dropping duplicate bot-menu event for ${syntheticMessageId}`);
				return;
			}
			if (claim === "inflight") {
				log(`feishu[${accountId}]: dropping in-flight bot-menu event for ${syntheticMessageId}`);
				return;
			}
			const handleLegacyMenu = () => handleFeishuMessage({
				cfg,
				event: syntheticEvent,
				botOpenId: getBotOpenId(accountId),
				botName: getBotName(accountId),
				runtime,
				channelRuntime: params.channelRuntime,
				chatHistories,
				accountId,
				processingClaimHeld: true
			});
			const promise = maybeHandleFeishuQuickActionMenu({
				cfg,
				eventKey,
				operatorOpenId,
				runtime,
				accountId
			}).then(async (handledMenu) => {
				if (handledMenu) {
					await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
					return;
				}
				return await handleLegacyMenu();
			}).catch(async (err) => {
				if (isFeishuRetryableSyntheticEventError(err)) await forgetProcessedFeishuMessage(syntheticMessageId, accountId, log);
				else await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
				throw err;
			}).finally(() => {
				releaseFeishuMessageProcessing(syntheticMessageId, accountId);
			});
			if (fireAndForget) {
				promise.catch((err) => {
					error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
				});
				return;
			}
			await promise;
		} catch (err) {
			error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
		}
	};
}
//#endregion
export { createFeishuBotMenuHandler };
