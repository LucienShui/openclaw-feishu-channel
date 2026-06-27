import { getChatInfo, getChatMembers, getFeishuMemberInfo } from "./chat.js";
import { editMessageFeishu, getMessageFeishu, sendCardFeishu, sendMessageFeishu } from "./send.js";
import { listFeishuDirectoryGroupsLive, listFeishuDirectoryPeersLive } from "./directory.js";
import { feishuOutbound } from "./outbound.js";
import { createPinFeishu, listPinsFeishu, removePinFeishu } from "./pins.js";
import { probeFeishu } from "./probe.js";
import { addReactionFeishu, listReactionsFeishu, removeReactionFeishu } from "./reactions.js";
//#region src/channel.runtime.ts
const feishuChannelRuntime = {
	listFeishuDirectoryGroupsLive,
	listFeishuDirectoryPeersLive,
	feishuOutbound: { ...feishuOutbound },
	createPinFeishu,
	listPinsFeishu,
	removePinFeishu,
	probeFeishu,
	addReactionFeishu,
	listReactionsFeishu,
	removeReactionFeishu,
	getChatInfo,
	getChatMembers,
	getFeishuMemberInfo,
	editMessageFeishu,
	getMessageFeishu,
	sendCardFeishu,
	sendMessageFeishu
};
//#endregion
export { feishuChannelRuntime };
