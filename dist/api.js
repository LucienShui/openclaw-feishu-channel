import { buildFeishuConversationId, buildFeishuModelOverrideParentCandidates, parseFeishuConversationId, parseFeishuDirectConversationId, parseFeishuTargetId } from "./src/conversation-id.js";
import { feishuSetupAdapter, setFeishuNamedAccountEnabled } from "./src/setup-core.js";
import { feishuSetupWizard, runFeishuLogin } from "./src/setup-surface.js";
import { feishuPlugin } from "./src/channel.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuChatTools } from "./src/chat.js";
import { registerFeishuWikiTools } from "./src/wiki.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { __testing as testing, createFeishuThreadBindingManager, getFeishuThreadBindingManager } from "./src/thread-bindings.js";
import { handleFeishuSubagentDeliveryTarget, handleFeishuSubagentEnded, handleFeishuSubagentSpawning } from "./src/subagent-hooks.js";
import { createClackPrompter } from "openclaw/plugin-sdk/setup-runtime";
//#region api.ts
const feishuSessionBindingAdapterChannels = ["feishu"];
//#endregion
export { testing as __testing, testing as feishuThreadBindingTesting, testing, buildFeishuConversationId, buildFeishuModelOverrideParentCandidates, createClackPrompter, createFeishuThreadBindingManager, feishuPlugin, feishuSessionBindingAdapterChannels, feishuSetupAdapter, feishuSetupWizard, getFeishuThreadBindingManager, handleFeishuSubagentDeliveryTarget, handleFeishuSubagentEnded, handleFeishuSubagentSpawning, parseFeishuConversationId, parseFeishuDirectConversationId, parseFeishuTargetId, registerFeishuBitableTools, registerFeishuChatTools, registerFeishuDocTools, registerFeishuDriveTools, registerFeishuPermTools, registerFeishuWikiTools, runFeishuLogin, setFeishuNamedAccountEnabled };
