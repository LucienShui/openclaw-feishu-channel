import { resolveFeishuAccount } from "./accounts.js";
import { normalizeFeishuTarget } from "./targets.js";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createResolvedApproverActionAuthAdapter, resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
//#region src/approval-auth.ts
function normalizeFeishuApproverId(value) {
	const trimmed = normalizeOptionalLowercaseString(normalizeFeishuTarget(String(value)));
	return trimmed?.startsWith("ou_") ? trimmed : void 0;
}
const feishuApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Feishu",
	resolveApprovers: ({ cfg, accountId }) => {
		const account = resolveFeishuAccount({
			cfg,
			accountId
		}).config;
		return resolveApprovalApprovers({
			allowFrom: account.allowFrom,
			normalizeApprover: normalizeFeishuApproverId
		});
	},
	normalizeSenderId: (value) => normalizeFeishuApproverId(value)
});
//#endregion
export { feishuApprovalAuth };
