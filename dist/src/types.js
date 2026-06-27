//#region src/types.ts
function isFeishuGroupChatType(chatType) {
	return chatType === "group" || chatType === "topic_group";
}
//#endregion
export { isFeishuGroupChatType };
