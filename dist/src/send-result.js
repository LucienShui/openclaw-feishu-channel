import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
//#region src/send-result.ts
function resolveFeishuReceiptKind(msgType) {
	switch (msgType) {
		case "audio": return "voice";
		case "image":
		case "media":
		case "file": return "media";
		case "interactive": return "card";
		case "post":
		case "text": return "text";
		default: return "unknown";
	}
}
function createFeishuSendReceipt(params) {
	const messageId = params.messageId?.trim();
	const chatId = params.chatId.trim();
	return createMessageReceiptFromOutboundResults({
		results: messageId ? [{
			channel: "feishu",
			messageId,
			chatId,
			conversationId: chatId
		}] : [],
		...chatId ? { threadId: chatId } : {},
		kind: params.kind ?? "unknown"
	});
}
function assertFeishuMessageApiSuccess(response, errorPrefix) {
	if (response.code !== 0) throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);
}
function toFeishuSendResult(response, chatId, kind) {
	const messageId = response.data?.message_id ?? "unknown";
	return {
		messageId,
		chatId,
		receipt: createFeishuSendReceipt({
			messageId,
			chatId,
			kind
		})
	};
}
//#endregion
export { assertFeishuMessageApiSuccess, createFeishuSendReceipt, resolveFeishuReceiptKind, toFeishuSendResult };
