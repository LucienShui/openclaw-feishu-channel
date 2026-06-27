import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { loadSessionStore, resolveSessionFilePath, resolveStorePath, updateSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
//#region src/doctor.ts
const FEISHU_STATE_DIR = "feishu";
const BACKUP_PREFIX = "feishu-state-repair";
const BLANK_USER_MESSAGE_REPAIR_THRESHOLD = 3;
const SESSION_FILE_INSPECTION_MAX_BYTES = 16 * 1024 * 1024;
function timestampForPath(now = /* @__PURE__ */ new Date()) {
	return now.toISOString().replaceAll(":", "-");
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function toFeishuSessionEntry(value) {
	if (!isRecord(value)) return {};
	return {
		sessionId: value.sessionId,
		sessionFile: value.sessionFile
	};
}
function countLabel(count, singular, plural = `${singular}s`) {
	return `${count} ${count === 1 ? singular : plural}`;
}
function existsDir(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
function existsFile(filePath) {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
function safeReadDir(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}
function isPathWithinRoot(targetPath, rootPath) {
	const resolvedTarget = path.resolve(targetPath);
	const resolvedRoot = path.resolve(rootPath);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function formatDisplayPath(filePath) {
	const home = os.homedir();
	const resolved = path.resolve(filePath);
	return resolved === home || resolved.startsWith(`${home}${path.sep}`) ? `~${resolved.slice(home.length)}` : resolved;
}
function formatFinding(finding) {
	switch (finding.kind) {
		case "corrupt-state-json": return `- Feishu local JSON state is corrupt: ${formatDisplayPath(finding.path)}`;
		case "missing-session-transcript": return `- Feishu session ${finding.sessionKey} points to a missing transcript in ${formatDisplayPath(finding.storePath)}`;
		case "invalid-session-transcript": return `- Feishu session ${finding.sessionKey} has an invalid transcript (${finding.reason}): ${formatDisplayPath(finding.path)}`;
		case "blank-user-message-run": return `- Feishu session ${finding.sessionKey} contains ${finding.count} blank user messages: ${formatDisplayPath(finding.path)}`;
	}
	return finding;
}
function isFeishuSessionStoreKey(key) {
	const normalized = key.trim().toLowerCase();
	return /^agent:[^:]+:feishu(?::|$)/.test(normalized) || /^feishu(?::|$)/.test(normalized);
}
function isFeishuAcpBindingSessionKey(key) {
	return /^agent:[^:]+:acp:binding:feishu(?::|$)/.test(key.trim().toLowerCase());
}
function normalizeMetadataString(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function isFeishuSessionEntry(key, value) {
	if (isFeishuAcpBindingSessionKey(key)) return false;
	if (isFeishuSessionStoreKey(key)) return true;
	if (!isRecord(value)) return false;
	if (normalizeMetadataString(value.channel) === "feishu" || normalizeMetadataString(value.lastChannel) === "feishu") return true;
	if (normalizeMetadataString((isRecord(value.route) ? value.route : null)?.channel) === "feishu") return true;
	if (normalizeMetadataString((isRecord(value.deliveryContext) ? value.deliveryContext : null)?.channel) === "feishu") return true;
	if (normalizeMetadataString((isRecord(value.pendingFinalDeliveryContext) ? value.pendingFinalDeliveryContext : null)?.channel) === "feishu") return true;
	const origin = isRecord(value.origin) ? value.origin : null;
	const originProvider = normalizeMetadataString(origin?.provider);
	const originSurface = normalizeMetadataString(origin?.surface);
	const originFrom = normalizeMetadataString(origin?.from);
	return originProvider === "feishu" || originSurface.startsWith("feishu") || originFrom.startsWith("feishu:");
}
function collectConfiguredAgentIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	ids.add(resolveConfiguredDefaultAgentId(cfg));
	for (const agent of cfg.agents?.list ?? []) if (typeof agent.id === "string" && agent.id.trim()) ids.add(normalizeAgentId(agent.id));
	return [...ids].toSorted();
}
function resolveConfiguredDefaultAgentId(cfg) {
	const agents = cfg.agents?.list ?? [];
	const chosen = agents.find((agent) => agent?.default) ?? agents[0];
	return normalizeAgentId(typeof chosen?.id === "string" && chosen.id.trim() ? chosen.id : "main");
}
function collectFeishuSessionTargets(params) {
	const byStorePath = /* @__PURE__ */ new Map();
	const addTarget = (target) => {
		byStorePath.set(path.resolve(target.storePath), {
			...target,
			storePath: path.resolve(target.storePath)
		});
	};
	for (const agentId of collectConfiguredAgentIds(params.cfg)) addTarget({
		agentId,
		storePath: resolveStorePath(params.cfg.session?.store, {
			agentId,
			env: params.env
		})
	});
	const agentsDir = path.join(params.stateDir, "agents");
	for (const agentDir of safeReadDir(agentsDir)) {
		if (!agentDir.isDirectory()) continue;
		const agentId = normalizeAgentId(agentDir.name);
		const storePath = path.join(agentsDir, agentDir.name, "sessions", "sessions.json");
		if (existsFile(storePath)) addTarget({
			agentId,
			storePath
		});
	}
	return [...byStorePath.values()].toSorted((left, right) => left.storePath.localeCompare(right.storePath));
}
function collectJsonFiles(rootDir, limit = 200) {
	const files = [];
	const visit = (dir) => {
		if (files.length >= limit) return;
		for (const entry of safeReadDir(dir).toSorted((left, right) => left.name.localeCompare(right.name))) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".json")) files.push(fullPath);
			if (files.length >= limit) return;
		}
	};
	if (existsDir(rootDir)) visit(rootDir);
	return files;
}
function collectCorruptFeishuStateJsonFindings(feishuStateDir) {
	const findings = [];
	for (const filePath of collectJsonFiles(feishuStateDir)) try {
		JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		findings.push({
			kind: "corrupt-state-json",
			path: filePath
		});
	}
	return findings;
}
function resolveSessionTranscriptCandidates(params) {
	const candidates = /* @__PURE__ */ new Set();
	const sessionsDir = path.dirname(params.storePath);
	const addSafeCandidate = (candidate) => {
		const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(sessionsDir, candidate);
		if (resolved === sessionsDir || !isPathWithinRoot(resolved, sessionsDir)) return;
		candidates.add(resolved);
	};
	if (typeof params.entry.sessionId === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(params.entry.sessionId)) {
		candidates.add(resolveSessionFilePath(params.entry.sessionId, typeof params.entry.sessionFile === "string" ? { sessionFile: params.entry.sessionFile } : void 0, {
			agentId: params.agentId,
			sessionsDir
		}));
		return [...candidates].toSorted();
	}
	if (typeof params.entry.sessionFile === "string" && params.entry.sessionFile.trim()) addSafeCandidate(params.entry.sessionFile.trim());
	return [...candidates].toSorted();
}
function isSessionHeader(value) {
	return isRecord(value) && value.type === "session" && typeof value.id === "string";
}
function isBlankUserMessage(value) {
	if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) return false;
	if (value.message.role !== "user") return false;
	const content = value.message.content;
	if (typeof content === "string") return content.trim().length === 0;
	return Array.isArray(content) && content.length === 0;
}
function isUserMessage(value) {
	return isRecord(value) && value.type === "message" && isRecord(value.message) && value.message.role === "user";
}
function inspectSessionTranscript(params) {
	let stat;
	try {
		stat = fs.statSync(params.transcriptPath);
	} catch {
		return null;
	}
	if (!stat.isFile()) return {
		kind: "invalid-session-transcript",
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		path: params.transcriptPath,
		reason: "not a file"
	};
	if (stat.size > SESSION_FILE_INSPECTION_MAX_BYTES) return null;
	let raw;
	try {
		raw = fs.readFileSync(params.transcriptPath, "utf-8");
	} catch {
		return {
			kind: "invalid-session-transcript",
			sessionKey: params.sessionKey,
			storePath: params.storePath,
			path: params.transcriptPath,
			reason: "unreadable"
		};
	}
	const entries = [];
	let malformedLines = 0;
	let blankUserMessageRun = 0;
	let maxBlankUserMessageRun = 0;
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			entries.push(entry);
			if (isBlankUserMessage(entry)) {
				blankUserMessageRun += 1;
				maxBlankUserMessageRun = Math.max(maxBlankUserMessageRun, blankUserMessageRun);
			} else if (isUserMessage(entry)) blankUserMessageRun = 0;
		} catch {
			malformedLines += 1;
		}
	}
	if (entries.length === 0) return {
		kind: "invalid-session-transcript",
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		path: params.transcriptPath,
		reason: "empty transcript"
	};
	if (!isSessionHeader(entries[0])) return {
		kind: "invalid-session-transcript",
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		path: params.transcriptPath,
		reason: "invalid session header"
	};
	if (malformedLines > 0) return {
		kind: "invalid-session-transcript",
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		path: params.transcriptPath,
		reason: `${malformedLines} malformed JSONL line(s)`
	};
	if (maxBlankUserMessageRun >= BLANK_USER_MESSAGE_REPAIR_THRESHOLD) return {
		kind: "blank-user-message-run",
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		path: params.transcriptPath,
		count: maxBlankUserMessageRun
	};
	return null;
}
function collectFeishuSessionFindings(params) {
	const transcriptCandidates = resolveSessionTranscriptCandidates(params);
	const existing = transcriptCandidates.filter(existsFile);
	if (transcriptCandidates.length > 0 && existing.length === 0) return [{
		kind: "missing-session-transcript",
		sessionKey: params.sessionKey,
		storePath: params.storePath
	}];
	const findings = [];
	for (const transcriptPath of existing) {
		const finding = inspectSessionTranscript({
			sessionKey: params.sessionKey,
			storePath: params.storePath,
			transcriptPath
		});
		if (finding) findings.push(finding);
	}
	return findings;
}
function hasCorruptFeishuStateJsonFinding(inspection) {
	return inspection.findings.some((finding) => finding.kind === "corrupt-state-json");
}
function sessionEntryId(storePath, key) {
	return `${path.resolve(storePath)}\0${key}`;
}
function collectRepairSessionEntries(inspection) {
	const entriesById = /* @__PURE__ */ new Map();
	for (const entry of inspection.sessionEntries) entriesById.set(sessionEntryId(entry.storePath, entry.key), entry);
	const repairEntries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const finding of inspection.findings) {
		if (finding.kind === "corrupt-state-json") continue;
		const id = sessionEntryId(finding.storePath, finding.sessionKey);
		if (seen.has(id)) continue;
		const entry = entriesById.get(id);
		if (entry) {
			repairEntries.push(entry);
			seen.add(id);
		}
	}
	return repairEntries.toSorted((left, right) => left.storePath.localeCompare(right.storePath) || left.key.localeCompare(right.key));
}
function inspectFeishuDoctorState(params) {
	const env = params.env ?? process.env;
	const stateDir = resolveStateDir(env, os.homedir);
	const feishuStateDir = path.join(stateDir, FEISHU_STATE_DIR);
	const findings = collectCorruptFeishuStateJsonFindings(feishuStateDir);
	const sessionEntries = [];
	for (const target of collectFeishuSessionTargets({
		cfg: params.cfg,
		env,
		stateDir
	})) {
		const store = loadSessionStore(target.storePath, { skipCache: true });
		for (const [key, entry] of Object.entries(store).toSorted(([left], [right]) => left.localeCompare(right))) {
			if (!isFeishuSessionEntry(key, entry)) continue;
			const sessionEntry = toFeishuSessionEntry(entry);
			sessionEntries.push({
				key,
				storePath: target.storePath,
				agentId: target.agentId,
				entry: sessionEntry
			});
			findings.push(...collectFeishuSessionFindings({
				sessionKey: key,
				storePath: target.storePath,
				agentId: target.agentId,
				entry: sessionEntry
			}));
		}
	}
	return {
		stateDir,
		feishuStateDir,
		findings,
		sessionEntries
	};
}
function ensureBackupDir(stateDir, now) {
	const backupDir = path.join(stateDir, "backups", `${BACKUP_PREFIX}-${timestampForPath(now)}`);
	fs.mkdirSync(backupDir, {
		recursive: true,
		mode: 448
	});
	return backupDir;
}
function resolveUniquePath(candidate) {
	if (!fs.existsSync(candidate)) return candidate;
	for (let index = 1; index < 1e3; index += 1) {
		const next = `${candidate}.${index}`;
		if (!fs.existsSync(next)) return next;
	}
	throw new Error(`Unable to resolve unique path for ${candidate}`);
}
function movePathToBackup(params) {
	if (!fs.existsSync(params.sourcePath)) return false;
	const targetPath = resolveUniquePath(path.join(params.backupDir, params.relativeTarget));
	fs.mkdirSync(path.dirname(targetPath), {
		recursive: true,
		mode: 448
	});
	fs.renameSync(params.sourcePath, targetPath);
	return true;
}
function copyStoreBackup(params) {
	if (!existsFile(params.storePath)) return;
	const targetPath = path.join(params.backupDir, "session-stores", params.agentId, path.basename(params.storePath));
	fs.mkdirSync(path.dirname(targetPath), {
		recursive: true,
		mode: 448
	});
	fs.copyFileSync(params.storePath, resolveUniquePath(targetPath));
}
function collectSessionArtifactPaths(params) {
	const artifacts = /* @__PURE__ */ new Set();
	for (const transcriptPath of resolveSessionTranscriptCandidates(params)) {
		artifacts.add(transcriptPath);
		if (transcriptPath.endsWith(".jsonl")) {
			const base = transcriptPath.slice(0, -6);
			artifacts.add(`${base}.trajectory.jsonl`);
			artifacts.add(`${base}.trajectory-path.json`);
		}
	}
	return [...artifacts].toSorted();
}
function archiveSessionArtifacts(params) {
	const seen = /* @__PURE__ */ new Set();
	let archived = 0;
	for (const entry of params.entries) for (const artifactPath of collectSessionArtifactPaths({
		storePath: params.storePath,
		agentId: entry.agentId,
		entry: entry.entry
	})) {
		if (seen.has(artifactPath) || !existsFile(artifactPath)) continue;
		seen.add(artifactPath);
		const archivedPath = resolveUniquePath(`${artifactPath}.deleted.${params.archiveTimestamp}`);
		fs.renameSync(artifactPath, archivedPath);
		archived += 1;
	}
	return archived;
}
async function repairFeishuDoctorState(params) {
	const env = params.env ?? process.env;
	const now = params.now ?? /* @__PURE__ */ new Date();
	const inspection = params.inspection ?? inspectFeishuDoctorState({
		cfg: params.cfg,
		env
	});
	const backupDir = ensureBackupDir(inspection.stateDir, now);
	const archiveTimestamp = timestampForPath(now);
	const warnings = [];
	const stateDirRepairAttempted = hasCorruptFeishuStateJsonFinding(inspection);
	let rebuiltStateDir = false;
	if (stateDirRepairAttempted) try {
		rebuiltStateDir = movePathToBackup({
			sourcePath: inspection.feishuStateDir,
			backupDir,
			relativeTarget: FEISHU_STATE_DIR
		});
		fs.mkdirSync(inspection.feishuStateDir, {
			recursive: true,
			mode: 448
		});
	} catch (error) {
		warnings.push(`- Failed to rebuild Feishu local state: ${String(error)}`);
	}
	const entriesByStore = /* @__PURE__ */ new Map();
	for (const entry of collectRepairSessionEntries(inspection)) {
		const existing = entriesByStore.get(entry.storePath);
		if (existing) existing.entries.push({
			key: entry.key,
			entry: entry.entry
		});
		else entriesByStore.set(entry.storePath, {
			agentId: entry.agentId,
			entries: [{
				key: entry.key,
				entry: entry.entry
			}]
		});
	}
	let removedSessionEntries = 0;
	let touchedSessionStores = 0;
	let archivedSessionArtifacts = 0;
	for (const [storePath, group] of [...entriesByStore.entries()].toSorted(([left], [right]) => left.localeCompare(right))) try {
		copyStoreBackup({
			storePath,
			backupDir,
			agentId: group.agentId
		});
		const keys = new Set(group.entries.map((entry) => entry.key));
		const removedEntries = await updateSessionStore(storePath, (store) => {
			const removed = [];
			for (const key of keys) if (Object.hasOwn(store, key)) {
				delete store[key];
				const entry = group.entries.find((candidate) => candidate.key === key);
				if (entry) removed.push(entry);
			}
			return removed;
		}, { skipMaintenance: true });
		const removed = removedEntries.length;
		removedSessionEntries += removed;
		if (removed > 0) {
			touchedSessionStores += 1;
			archivedSessionArtifacts += archiveSessionArtifacts({
				storePath,
				entries: removedEntries.map((entry) => ({
					agentId: group.agentId,
					entry: entry.entry
				})),
				archiveTimestamp
			});
		}
	} catch (error) {
		warnings.push(`- Failed to archive Feishu sessions in ${formatDisplayPath(storePath)}: ${String(error)}`);
	}
	return {
		backupDir,
		stateDirRepairAttempted,
		rebuiltStateDir,
		removedSessionEntries,
		touchedSessionStores,
		archivedSessionArtifacts,
		warnings
	};
}
function formatPreviewWarning(inspection) {
	const previewFindings = inspection.findings.slice(0, 5).map(formatFinding);
	const remaining = inspection.findings.length - previewFindings.length;
	const repairActions = [];
	if (hasCorruptFeishuStateJsonFinding(inspection)) repairActions.push(`archive ${formatDisplayPath(inspection.feishuStateDir)}`);
	const repairSessionEntries = collectRepairSessionEntries(inspection);
	if (repairSessionEntries.length > 0) repairActions.push(`archive artifacts and remove ${countLabel(repairSessionEntries.length, "flagged Feishu-scoped session entry", "flagged Feishu-scoped session entries")}`);
	const repairSummary = repairActions.length > 0 ? repairActions.join(" and ") : "apply targeted Feishu state cleanup";
	return [
		"- Feishu local channel state may need repair.",
		...previewFindings,
		...remaining > 0 ? [`- ...and ${remaining} more Feishu state finding(s).`] : [],
		`- Repair will ${repairSummary}, while preserving Feishu App ID/secret config and healthy session entries.`,
		"- Run \"openclaw doctor --fix\" to rebuild Feishu local state."
	].join("\n");
}
function formatRepairChange(report) {
	const stateRepairStatus = report.stateDirRepairAttempted ? report.rebuiltStateDir ? "yes" : "no existing state" : "not needed";
	return [
		"Feishu local state repaired.",
		`- Backup dir: ${formatDisplayPath(report.backupDir)}`,
		`- Rebuilt Feishu runtime state: ${stateRepairStatus}`,
		`- Removed ${countLabel(report.removedSessionEntries, "Feishu-scoped session entry", "Feishu-scoped session entries")} from ${countLabel(report.touchedSessionStores, "session store")}.`,
		`- Archived ${countLabel(report.archivedSessionArtifacts, "session artifact file")}.`,
		"- Preserved Feishu App ID/secret config."
	].join("\n");
}
function hasConfiguredFeishuChannel(cfg) {
	return Boolean(cfg.channels?.feishu);
}
async function runFeishuDoctorSequence(params) {
	if (!hasConfiguredFeishuChannel(params.cfg)) return {
		changeNotes: [],
		warningNotes: []
	};
	const inspection = inspectFeishuDoctorState({
		cfg: params.cfg,
		env: params.env
	});
	if (inspection.findings.length === 0) return {
		changeNotes: [],
		warningNotes: []
	};
	if (!params.shouldRepair) return {
		changeNotes: [],
		warningNotes: [formatPreviewWarning(inspection)]
	};
	const report = await repairFeishuDoctorState({
		cfg: params.cfg,
		env: params.env,
		inspection
	});
	return {
		changeNotes: [formatRepairChange(report)],
		warningNotes: report.warnings
	};
}
const feishuDoctor = { runConfigSequence: async ({ cfg, env, shouldRepair }) => await runFeishuDoctorSequence({
	cfg,
	env,
	shouldRepair
}) };
//#endregion
export { feishuDoctor, inspectFeishuDoctorState, isFeishuSessionStoreKey, runFeishuDoctorSequence };
