import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
//#region src/tool-result.ts
function jsonToolResult(data) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(data, null, 2)
		}],
		details: data
	};
}
function unknownToolActionResult(action) {
	return jsonToolResult({ error: `Unknown action: ${String(action)}` });
}
function toolExecutionErrorResult(error) {
	return jsonToolResult({ error: formatErrorMessage(error) });
}
//#endregion
export { jsonToolResult, toolExecutionErrorResult, unknownToolActionResult };
