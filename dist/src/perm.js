import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import { jsonToolResult, toolExecutionErrorResult, unknownToolActionResult } from "./tool-result.js";
import { FeishuPermSchema } from "./perm-schema.js";
//#region src/perm.ts
async function listMembers(client, token, type) {
	const res = await client.drive.permissionMember.list({
		path: { token },
		params: { type }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return { members: res.data?.items?.map((m) => ({
		member_type: m.member_type,
		member_id: m.member_id,
		perm: m.perm,
		name: m.name
	})) ?? [] };
}
async function addMember(client, token, type, memberType, memberId, perm) {
	const res = await client.drive.permissionMember.create({
		path: { token },
		params: {
			type,
			need_notification: false
		},
		data: {
			member_type: memberType,
			member_id: memberId,
			perm
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		member: res.data?.member
	};
}
async function removeMember(client, token, type, memberType, memberId) {
	const res = await client.drive.permissionMember.delete({
		path: {
			token,
			member_id: memberId
		},
		params: {
			type,
			member_type: memberType
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return { success: true };
}
function registerFeishuPermTools(api) {
	if (!api.config) return;
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) return;
	if (!resolveAnyEnabledFeishuToolsConfig(accounts).perm) return;
	api.registerTool((ctx) => {
		const defaultAccountId = ctx.agentAccountId;
		return {
			name: "feishu_perm",
			label: "Feishu Perm",
			description: "Feishu permission management. Actions: list, add, remove",
			parameters: FeishuPermSchema,
			async execute(_toolCallId, params) {
				const p = params;
				try {
					const client = createFeishuToolClient({
						api,
						executeParams: p,
						defaultAccountId,
						requiredTool: {
							family: "perm",
							label: "Perm"
						}
					});
					switch (p.action) {
						case "list": return jsonToolResult(await listMembers(client, p.token, p.type));
						case "add": return jsonToolResult(await addMember(client, p.token, p.type, p.member_type, p.member_id, p.perm));
						case "remove": return jsonToolResult(await removeMember(client, p.token, p.type, p.member_type, p.member_id));
						default: return unknownToolActionResult(p.action);
					}
				} catch (err) {
					return toolExecutionErrorResult(err);
				}
			}
		};
	}, { name: "feishu_perm" });
}
//#endregion
export { registerFeishuPermTools };
