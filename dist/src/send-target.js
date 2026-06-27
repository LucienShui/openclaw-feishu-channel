import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";
import { createFeishuClient } from "./client.js";
//#region src/send-target.ts
function resolveFeishuSendTarget(params) {
	const target = params.to.trim();
	const account = resolveFeishuRuntimeAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const client = createFeishuClient(account);
	const receiveId = normalizeFeishuTarget(target);
	if (!receiveId) throw new Error(`Invalid Feishu target: ${params.to}`);
	return {
		client,
		receiveId,
		receiveIdType: resolveReceiveIdType(target.replace(/^(feishu|lark):/i, ""))
	};
}
//#endregion
export { resolveFeishuSendTarget };
