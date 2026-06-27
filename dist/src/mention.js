import { isFeishuGroupChatType } from "./types.js";
//#region src/mention.ts
function isFeishuBroadcastMention(mention) {
	const normalizedKey = mention.key?.trim().toLowerCase();
	if (normalizedKey === "@all" || normalizedKey === "@_all") return true;
	return [
		mention.id?.open_id,
		mention.id?.user_id,
		mention.id?.union_id
	].some((id) => id?.trim().toLowerCase() === "all");
}
/**
* Extract mention targets from message event (excluding the bot itself)
*/
function extractMentionTargets(event, botOpenId) {
	return (event.message.mentions ?? []).filter((m) => {
		if (isFeishuBroadcastMention(m)) return false;
		if (botOpenId && m.id.open_id === botOpenId) return false;
		return Boolean(m.id.open_id);
	}).map((m) => ({
		openId: m.id.open_id,
		name: m.name,
		key: m.key
	}));
}
/**
* Check if message is a mention forward request
* Rules:
* - Group: message mentions bot + at least one other user
* - DM: message mentions any user (no need to mention bot)
*/
function isMentionForwardRequest(event, botOpenId) {
	const mentions = event.message.mentions ?? [];
	if (mentions.length === 0) return false;
	const isDirectMessage = !isFeishuGroupChatType(event.message.chat_type);
	const userMentions = mentions.filter((m) => !isFeishuBroadcastMention(m));
	const hasOtherMention = userMentions.some((m) => m.id.open_id !== botOpenId);
	if (isDirectMessage) return hasOtherMention;
	return userMentions.some((m) => m.id.open_id === botOpenId) && hasOtherMention;
}
/**
* Format @mention for card message (lark_md)
*/
function formatMentionForCard(target) {
	return `<at id=${target.openId}></at>`;
}
/**
* Build card content with @mentions (Markdown format)
*/
function buildMentionedCardContent(targets, message) {
	if (targets.length === 0) return message;
	return `${targets.map((t) => formatMentionForCard(t)).join(" ")} ${message}`;
}
//#endregion
export { buildMentionedCardContent, extractMentionTargets, isFeishuBroadcastMention, isMentionForwardRequest };
