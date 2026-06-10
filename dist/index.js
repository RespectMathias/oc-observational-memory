import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;
const STATE_VERSION = 1;
const DEFAULT_MAX_INJECTED_TOKENS = 1_500;
const DEFAULT_MAX_COMPACTION_CONTEXT_TOKENS = 2_000;
const DEFAULT_STORE_DIR = ".opencode/observational-memory";
const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this project.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall_observation tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall_observation as broad search or inject raw source unless it is needed.`;
const defaultOptions = {
    enabled: true,
    observeUser: true,
    observeAssistant: true,
    inject: true,
    compactionContext: true,
    maxInjectedTokens: DEFAULT_MAX_INJECTED_TOKENS,
    maxCompactionContextTokens: DEFAULT_MAX_COMPACTION_CONTEXT_TOKENS,
    storeDir: DEFAULT_STORE_DIR,
};
const plugin = async (input, pluginOptions) => {
    const options = parseOptions(pluginOptions);
    const store = new MemoryStore({
        file: path.join(resolveStoreDir(input, options.storeDir), "memory.json"),
        projectID: input.project.id ?? input.worktree ?? input.directory,
        options,
    });
    if (!options.enabled)
        return {};
    return {
        tool: {
            recall_observation: tool({
                description: "Recall exact source evidence for an oc-observational-memory observation or reflection id. Use only when condensed memory needs precision or traceability.",
                args: {
                    id: tool.schema
                        .string()
                        .regex(MEMORY_ID_PATTERN)
                        .describe("12-character memory id from injected observations or reflections"),
                },
                execute: async (args, context) => {
                    const id = args.id;
                    return {
                        title: `Recall ${id}`,
                        output: await store.recall(id, context.sessionID),
                    };
                },
            }),
        },
        event: async (input) => {
            if (input.event.type !== "session.deleted")
                return;
            const sessionID = deletedSessionID(input.event);
            if (sessionID)
                await store.deleteSession(sessionID);
        },
        "chat.message": async (hookInput, output) => {
            if (!options.observeUser)
                return;
            const text = partsText(output.parts);
            if (!text)
                return;
            await store.record({
                role: "user",
                sessionID: hookInput.sessionID,
                messageID: hookInput.messageID ?? idFor([hookInput.sessionID, text]),
                text,
            });
        },
        "experimental.text.complete": async (hookInput, output) => {
            if (!options.observeAssistant)
                return;
            await store.record({
                role: "assistant",
                sessionID: hookInput.sessionID,
                messageID: hookInput.messageID,
                text: output.text,
            });
        },
        "experimental.chat.system.transform": async (hookInput, output) => {
            if (!options.inject || !hookInput.sessionID)
                return;
            const summary = await store.render(options.maxInjectedTokens, hookInput.sessionID);
            if (summary)
                output.system.push(summary);
        },
        "experimental.session.compacting": async (hookInput, output) => {
            if (!options.compactionContext)
                return;
            const prefix = "Project observational memory:\n\n";
            const summary = await store.render(options.maxCompactionContextTokens - estimateTokens(prefix), hookInput.sessionID);
            if (summary)
                output.context.push(`${prefix}${summary}`);
        },
    };
};
export default plugin;
class MemoryStore {
    input;
    queue = Promise.resolve();
    constructor(input) {
        this.input = input;
    }
    async record(input) {
        const text = normalizeText(input.text);
        if (!text)
            return;
        await this.mutate((state) => {
            const timestamp = new Date().toISOString();
            const source = {
                id: idFor([input.sessionID, input.messageID, input.role, text]),
                sessionID: input.sessionID,
                messageID: input.messageID,
                role: input.role,
                timestamp,
                text,
            };
            const observations = extractObservations({ role: input.role, text, source, timestamp });
            if (observations.length === 0)
                return state;
            const next = {
                ...state,
                sources: upsertByID([...state.sources, source]),
                observations: upsertObservations([...state.observations, ...observations]),
            };
            return {
                ...next,
                reflections: upsertReflections([...next.reflections, ...extractReflections(next.observations)]),
            };
        });
    }
    async render(maxTokens, sessionID) {
        const state = await this.read();
        const visible = sessionState(state, sessionID);
        return renderSummary(visible.reflections, visible.observations, maxTokens);
    }
    async recall(id, sessionID) {
        if (!MEMORY_ID_PATTERN.test(id))
            return `Invalid memory id: ${id}`;
        const state = sessionState(await this.read(), sessionID);
        const observation = state.observations.find((item) => item.id === id);
        if (observation)
            return recallObservation(state, observation);
        const reflection = state.reflections.find((item) => item.id === id);
        if (reflection)
            return recallReflection(state, reflection);
        return `No observational memory found for ${id} in project store for session ${sessionID}.`;
    }
    async deleteSession(sessionID) {
        await this.mutate((state) => removeSession(state, sessionID));
    }
    async mutate(update) {
        const run = async () => {
            const current = await this.read();
            await this.write(update(current));
        };
        this.queue = this.queue.then(run, run);
        await this.queue;
    }
    async read() {
        try {
            const parsed = JSON.parse(await readFile(this.input.file, "utf8"));
            if (isState(parsed))
                return parsed;
        }
        catch (error) {
            if (!isMissingFile(error))
                throw error;
        }
        return emptyState(this.input.projectID);
    }
    async write(state) {
        await mkdir(path.dirname(this.input.file), { recursive: true });
        const temp = `${this.input.file}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await rename(temp, this.input.file);
    }
}
function parseOptions(input) {
    return {
        enabled: readBoolean(input?.enabled, defaultOptions.enabled),
        observeUser: readBoolean(input?.observeUser, defaultOptions.observeUser),
        observeAssistant: readBoolean(input?.observeAssistant, defaultOptions.observeAssistant),
        inject: readBoolean(input?.inject, defaultOptions.inject),
        compactionContext: readBoolean(input?.compactionContext, defaultOptions.compactionContext),
        maxInjectedTokens: readPositiveInteger(input?.maxInjectedTokens, defaultOptions.maxInjectedTokens),
        maxCompactionContextTokens: readPositiveInteger(input?.maxCompactionContextTokens, defaultOptions.maxCompactionContextTokens),
        storeDir: typeof input?.storeDir === "string" && input.storeDir.trim() ? input.storeDir : defaultOptions.storeDir,
    };
}
function resolveStoreDir(input, storeDir) {
    if (path.isAbsolute(storeDir))
        return storeDir;
    return path.join(input.worktree || input.directory, storeDir);
}
function readBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
function readPositiveInteger(value, fallback) {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function emptyState(projectID) {
    return { version: STATE_VERSION, projectID, observations: [], reflections: [], sources: [] };
}
function deletedSessionID(event) {
    const properties = event.properties;
    if (!properties || typeof properties !== "object")
        return;
    const value = properties;
    if (typeof value.sessionID === "string")
        return value.sessionID;
    if (typeof value.info?.id === "string")
        return value.info.id;
}
function sessionState(state, sessionID) {
    const sources = state.sources.filter((source) => source.sessionID === sessionID);
    const sourceIds = new Set(sources.map((source) => source.id));
    const observations = state.observations
        .map((observation) => ({
        ...observation,
        sourceEntryIds: observation.sourceEntryIds.filter((id) => sourceIds.has(id)),
    }))
        .filter((observation) => observation.sourceEntryIds.length > 0);
    const observationIds = new Set(observations.map((observation) => observation.id));
    const reflections = state.reflections
        .map((reflection) => ({
        ...reflection,
        supportingObservationIds: reflection.supportingObservationIds.filter((id) => observationIds.has(id)),
    }))
        .filter((reflection) => reflection.supportingObservationIds.length > 0);
    return { ...state, observations, reflections, sources };
}
function removeSession(state, sessionID) {
    const sources = state.sources.filter((source) => source.sessionID !== sessionID);
    const sourceIds = new Set(sources.map((source) => source.id));
    const observations = state.observations
        .map((observation) => ({
        ...observation,
        sourceEntryIds: observation.sourceEntryIds.filter((id) => sourceIds.has(id)),
    }))
        .filter((observation) => observation.sourceEntryIds.length > 0);
    const observationIds = new Set(observations.map((observation) => observation.id));
    const reflections = state.reflections
        .map((reflection) => ({
        ...reflection,
        supportingObservationIds: reflection.supportingObservationIds.filter((id) => observationIds.has(id)),
    }))
        .filter((reflection) => reflection.supportingObservationIds.length > 0);
    return { ...state, observations, reflections, sources };
}
function extractObservations(input) {
    const candidates = input.role === "user" ? userCandidates(input.text) : assistantCandidates(input.text);
    return candidates.map((candidate) => {
        const content = candidate.content.slice(0, 700);
        return {
            id: idFor([content]),
            content,
            timestamp: input.timestamp,
            relevance: candidate.relevance,
            sourceEntryIds: [input.source.id],
            tokenCount: estimateTokens(content),
        };
    });
}
function userCandidates(text) {
    return splitStatements(text)
        .map((statement) => statement.replace(/^remember\s+(that\s+)?/i, ""))
        .filter((statement) => userSignal(statement))
        .slice(0, 6)
        .map((statement) => ({
        content: `User stated: ${statement}`,
        relevance: relevanceFor(statement),
    }));
}
function assistantCandidates(text) {
    const statements = splitStatements(text).filter((statement) => /\b(added|built|changed|created|fixed|implemented|updated|verified|wrote|renamed|removed)\b/i.test(statement));
    if (statements.length === 0)
        return [];
    return [
        {
            content: `Assistant reported progress: ${statements.slice(0, 4).join(" ")}`,
            relevance: "medium",
        },
    ];
}
function extractReflections(observations) {
    return observations
        .filter((observation) => observation.relevance === "high" || observation.relevance === "critical")
        .filter((observation) => /\b(prefer|must|never|always|required|requirement|constraint|decision|decided|remember|plugin name|source of truth|notice)\b/i.test(observation.content))
        .map((observation) => {
        const content = observation.content.replace(/^User stated:\s*/i, "Project memory: ");
        return {
            id: idFor([content]),
            content,
            supportingObservationIds: [observation.id],
            tokenCount: estimateTokens(content),
        };
    });
}
function userSignal(statement) {
    return /\b(remember|prefer|preference|must|never|always|required|requirement|constraint|decision|decided|goal|use|source of truth|plugin name|notice|do not|don't|make sure)\b/i.test(statement);
}
function relevanceFor(statement) {
    if (/\b(must|never|required|requirement|security|secret|do not|don't|make sure)\b/i.test(statement))
        return "critical";
    if (/\b(remember|prefer|preference|decision|decided|constraint|source of truth|plugin name|notice)\b/i.test(statement))
        return "high";
    if (/\b(goal|use|should)\b/i.test(statement))
        return "medium";
    return "low";
}
function splitStatements(text) {
    return normalizeText(text)
        .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
        .map((item) => item.trim().replace(/^[-*]\s+/, ""))
        .filter((item) => item.length >= 12 && item.length <= 1_000);
}
function partsText(parts) {
    return parts
        .flatMap((part) => {
        if (!part || typeof part !== "object")
            return [];
        const value = part;
        if (value.type !== "text" || value.synthetic || value.ignored || typeof value.text !== "string")
            return [];
        return [value.text];
    })
        .join("\n")
        .trim();
}
function renderSummary(reflections, observations, maxTokens) {
    if (reflections.length === 0 && observations.length === 0)
        return "";
    if (maxTokens <= 0)
        return "";
    const parts = [CONTEXT_USAGE_INSTRUCTIONS];
    if (estimateTokens(parts.join("\n\n")) > maxTokens)
        return "";
    appendBoundedSection(parts, "## Reflections", reflections.map(reflectionToSummaryLine), maxTokens);
    appendBoundedSection(parts, "## Observations", [
        ...observations
            .filter((observation) => observation.relevance === "critical" || observation.relevance === "high")
            .sort(newestFirst)
            .map(observationToSummaryLine),
        ...observations
            .filter((observation) => observation.relevance === "medium" || observation.relevance === "low")
            .sort(newestFirst)
            .map(observationToSummaryLine),
    ], maxTokens);
    return parts.length === 1 ? "" : parts.join("\n\n");
}
function appendBoundedSection(parts, heading, lines, maxTokens) {
    const accepted = [];
    for (const line of lines) {
        const nextSection = `${heading}\n${[...accepted, line].join("\n")}`;
        if (estimateTokens([...parts, nextSection].join("\n\n")) <= maxTokens)
            accepted.push(line);
    }
    if (accepted.length > 0)
        parts.push(`${heading}\n${accepted.join("\n")}`);
}
function newestFirst(a, b) {
    return b.timestamp.localeCompare(a.timestamp);
}
function observationToSummaryLine(observation) {
    return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}
function reflectionToSummaryLine(reflection) {
    return `[${reflection.id}] ${reflection.content}`;
}
function recallObservation(state, observation) {
    return [
        `Observation ${observation.id}`,
        `Relevance: ${observation.relevance}`,
        `Content: ${observation.content}`,
        "",
        "Sources:",
        ...sourcesFor(state, observation.sourceEntryIds),
    ].join("\n");
}
function recallReflection(state, reflection) {
    const observations = reflection.supportingObservationIds.flatMap((id) => state.observations.find((item) => item.id === id) ?? []);
    return [
        `Reflection ${reflection.id}`,
        `Content: ${reflection.content}`,
        "",
        "Supporting observations:",
        ...observations.map(observationToSummaryLine),
        "",
        "Sources:",
        ...sourcesFor(state, observations.flatMap((observation) => observation.sourceEntryIds)),
    ].join("\n");
}
function sourcesFor(state, ids) {
    const sources = ids.flatMap((id) => state.sources.find((source) => source.id === id) ?? []);
    if (sources.length === 0)
        return ["(source unavailable)"];
    return sources.map((source) => [`- ${source.role} ${source.sessionID}/${source.messageID} at ${source.timestamp}`, indent(source.text)].join("\n"));
}
function upsertByID(items) {
    return [...new Map(items.map((item) => [item.id, item])).values()];
}
function upsertObservations(items) {
    const byId = new Map();
    for (const item of items) {
        const existing = byId.get(item.id);
        byId.set(item.id, existing ? { ...existing, sourceEntryIds: uniqueStrings([...existing.sourceEntryIds, ...item.sourceEntryIds]) } : item);
    }
    return [...byId.values()];
}
function upsertReflections(items) {
    const byId = new Map();
    for (const item of items) {
        const existing = byId.get(item.id);
        byId.set(item.id, existing
            ? {
                ...existing,
                supportingObservationIds: uniqueStrings([
                    ...existing.supportingObservationIds,
                    ...item.supportingObservationIds,
                ]),
            }
            : item);
    }
    return [...byId.values()];
}
function uniqueStrings(items) {
    return [...new Set(items)];
}
function normalizeText(text) {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ").replace(/\s+/g, " ").trim();
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function idFor(parts) {
    const hash = createHash("sha256");
    for (const part of parts)
        hash.update(part).update("\0");
    return hash.digest("hex").slice(0, 12);
}
function indent(text) {
    return text
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
}
function isMissingFile(error) {
    return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function isState(value) {
    if (!value || typeof value !== "object")
        return false;
    const state = value;
    return (state.version === STATE_VERSION &&
        typeof state.projectID === "string" &&
        Array.isArray(state.observations) &&
        state.observations.every(isObservation) &&
        Array.isArray(state.reflections) &&
        state.reflections.every(isReflection) &&
        Array.isArray(state.sources) &&
        state.sources.every(isSource));
}
function isObservation(value) {
    if (!value || typeof value !== "object")
        return false;
    const observation = value;
    return (typeof observation.id === "string" &&
        MEMORY_ID_PATTERN.test(observation.id) &&
        typeof observation.content === "string" &&
        typeof observation.timestamp === "string" &&
        ["low", "medium", "high", "critical"].includes(observation.relevance ?? "") &&
        Array.isArray(observation.sourceEntryIds) &&
        observation.sourceEntryIds.every((item) => typeof item === "string") &&
        typeof observation.tokenCount === "number");
}
function isReflection(value) {
    if (!value || typeof value !== "object")
        return false;
    const reflection = value;
    return (typeof reflection.id === "string" &&
        MEMORY_ID_PATTERN.test(reflection.id) &&
        typeof reflection.content === "string" &&
        Array.isArray(reflection.supportingObservationIds) &&
        reflection.supportingObservationIds.every((item) => typeof item === "string") &&
        typeof reflection.tokenCount === "number");
}
function isSource(value) {
    if (!value || typeof value !== "object")
        return false;
    const source = value;
    return (typeof source.id === "string" &&
        typeof source.sessionID === "string" &&
        typeof source.messageID === "string" &&
        (source.role === "user" || source.role === "assistant") &&
        typeof source.timestamp === "string" &&
        typeof source.text === "string");
}
