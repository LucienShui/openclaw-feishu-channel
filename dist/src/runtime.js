import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
//#region src/runtime.ts
const { setRuntime: setFeishuRuntime, getRuntime: getFeishuRuntime } = createPluginRuntimeStore({
	pluginId: "feishu",
	errorMessage: "Feishu runtime not initialized"
});
//#endregion
export { getFeishuRuntime, setFeishuRuntime };
