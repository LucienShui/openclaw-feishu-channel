//#region src/monitor.synthetic-error.ts
var FeishuRetryableSyntheticEventError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "FeishuRetryableSyntheticEventError";
	}
};
function isFeishuRetryableSyntheticEventError(error) {
	return error instanceof FeishuRetryableSyntheticEventError || typeof error === "object" && error !== null && "name" in error && error.name === "FeishuRetryableSyntheticEventError";
}
//#endregion
export { FeishuRetryableSyntheticEventError, isFeishuRetryableSyntheticEventError };
