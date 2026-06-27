//#region src/comment-target.ts
const FEISHU_COMMENT_FILE_TYPES = [
	"doc",
	"docx",
	"file",
	"sheet",
	"slides"
];
function normalizeCommentFileType(value) {
	return typeof value === "string" && FEISHU_COMMENT_FILE_TYPES.includes(value) ? value : void 0;
}
function buildFeishuCommentTarget(params) {
	return `comment:${params.fileType}:${params.fileToken}:${params.commentId}`;
}
function parseFeishuCommentTarget(raw) {
	const trimmed = raw?.trim();
	if (!trimmed?.startsWith("comment:")) return null;
	const parts = trimmed.split(":");
	if (parts.length !== 4) return null;
	const fileType = normalizeCommentFileType(parts[1]);
	const fileToken = parts[2]?.trim();
	const commentId = parts[3]?.trim();
	if (!fileType || !fileToken || !commentId) return null;
	return {
		fileType,
		fileToken,
		commentId
	};
}
//#endregion
export { FEISHU_COMMENT_FILE_TYPES, buildFeishuCommentTarget, normalizeCommentFileType, parseFeishuCommentTarget };
