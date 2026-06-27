import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { isFeishuGroupChatType } from "./types.js";
import { resolveFeishuGroupSession } from "./bot-content.js";
import { parseFeishuMessageEvent } from "./bot.js";
import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
//#region src/sequential-key.ts
function getFeishuSequentialKey(params) {
	const { accountId, event, cfg, botOpenId, botName } = params;
	const chatId = event.message.chat_id?.trim() || "unknown";
	const parsed = parseFeishuMessageEvent(event, botOpenId, botName);
	const feishuCfg = cfg ? resolveFeishuAccount({
		cfg,
		accountId
	}).config : void 0;
	const groupConfig = isFeishuGroupChatType(parsed.chatType) ? resolveFeishuGroupConfig({
		cfg: feishuCfg,
		groupId: chatId
	}) : void 0;
	const baseKey = `feishu:${accountId}:${(isFeishuGroupChatType(parsed.chatType) ? resolveFeishuGroupSession({
		chatId,
		senderOpenId: parsed.senderOpenId,
		messageId: parsed.messageId,
		rootId: parsed.rootId,
		threadId: parsed.threadId,
		chatType: parsed.chatType,
		groupConfig,
		feishuCfg
	}) : null)?.peerId ?? chatId}`;
	const text = parsed.content.trim();
	if (isAbortRequestText(text)) return `${baseKey}:control`;
	if (isBtwRequestText(text)) return `${baseKey}:btw`;
	return baseKey;
}
//#endregion
export { getFeishuSequentialKey };
