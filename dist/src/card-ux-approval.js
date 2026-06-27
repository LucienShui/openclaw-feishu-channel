import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { buildFeishuCardButton, buildFeishuCardInteractionContext } from "./card-ux-shared.js";
//#region src/card-ux-approval.ts
const FEISHU_APPROVAL_REQUEST_ACTION = "feishu.quick_actions.request_approval";
const FEISHU_APPROVAL_CONFIRM_ACTION = "feishu.approval.confirm";
const FEISHU_APPROVAL_CANCEL_ACTION = "feishu.approval.cancel";
function createApprovalCard(params) {
	const context = buildFeishuCardInteractionContext(params);
	return {
		schema: "2.0",
		config: { width_mode: "fill" },
		header: {
			title: {
				tag: "plain_text",
				content: "Confirm action"
			},
			template: "orange"
		},
		body: { elements: [{
			tag: "markdown",
			content: params.prompt
		}, {
			tag: "action",
			actions: [buildFeishuCardButton({
				label: params.confirmLabel ?? "Confirm",
				type: "primary",
				value: createFeishuCardInteractionEnvelope({
					k: "quick",
					a: FEISHU_APPROVAL_CONFIRM_ACTION,
					q: params.command,
					c: context
				})
			}), buildFeishuCardButton({
				label: params.cancelLabel ?? "Cancel",
				value: createFeishuCardInteractionEnvelope({
					k: "button",
					a: FEISHU_APPROVAL_CANCEL_ACTION,
					c: context
				})
			})]
		}] }
	};
}
//#endregion
export { FEISHU_APPROVAL_CANCEL_ACTION, FEISHU_APPROVAL_CONFIRM_ACTION, FEISHU_APPROVAL_REQUEST_ACTION, createApprovalCard };
