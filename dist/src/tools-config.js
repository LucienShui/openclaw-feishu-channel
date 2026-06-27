//#region src/tools-config.ts
/**
* Default tool configuration.
* - doc, chat, wiki, drive, scopes, bitable/base: enabled by default
* - perm: disabled by default (sensitive operation)
*/
const DEFAULT_TOOLS_CONFIG = {
	doc: true,
	chat: true,
	wiki: true,
	drive: true,
	perm: false,
	scopes: true,
	bitable: true,
	base: true
};
/**
* Resolve tools config with defaults.
*
* `base` is a backward-compatible alias for the Bitable tool family. When both
* keys are present, the explicit `bitable` value wins and `base` mirrors it.
*/
function resolveToolsConfig(cfg) {
	const bitable = cfg?.bitable ?? cfg?.base ?? DEFAULT_TOOLS_CONFIG.bitable;
	return {
		...DEFAULT_TOOLS_CONFIG,
		...cfg,
		bitable,
		base: bitable
	};
}
//#endregion
export { resolveToolsConfig };
