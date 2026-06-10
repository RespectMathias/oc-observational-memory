import { access, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import plugin from "../src/index.js";

type Hooks = Awaited<ReturnType<typeof plugin>>;

const tempRoot = "C:/Users/User/AppData/Local/Temp/opencode";

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

async function createHooks(options?: Record<string, unknown>) {
  const root = await mkdtemp(path.join(tempRoot, "oc-om-vitest-"));
  const hooks = await createHooksAtRoot(root, options);
  return { root, hooks };
}

async function createHooksAtRoot(
  root: string,
  options?: Record<string, unknown>,
) {
  const hooks = await plugin(
    {
      project: { id: `project-${path.basename(root)}` },
      directory: root,
      worktree: root,
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://127.0.0.1"),
      client: {} as never,
      $: {} as never,
    },
    options,
  );
  return hooks;
}

async function recordUser(
  hooks: Hooks,
  text: string,
  index: number,
  sessionID = "session-1",
) {
  await hooks["chat.message"]?.(
    { sessionID, messageID: `user-${index}` },
    {
      message: {} as never,
      parts: [{ type: "text", text } as never],
    },
  );
}

async function recordAssistant(
  hooks: Hooks,
  text: string,
  index: number,
  sessionID = "session-1",
) {
  await hooks["experimental.text.complete"]?.(
    { sessionID, messageID: `assistant-${index}`, partID: `part-${index}` },
    { text },
  );
}

async function readState(root: string) {
  return readStateFile(defaultMemoryFile(root));
}

async function readStateFile(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as {
    observations: Array<{
      id: string;
      content: string;
      relevance: string;
      timestamp: string;
    }>;
    reflections: Array<{
      id: string;
      content: string;
      supportingObservationIds: string[];
    }>;
    sources: Array<{ id: string; text: string }>;
  };
}

function defaultMemoryFile(root: string) {
  return path.join(root, ".opencode/observational-memory/memory.json");
}

async function fileExists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function injectedText(hooks: Hooks, sessionID = "session-1") {
  const output = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]?.(
    { sessionID, model: {} as never },
    output,
  );
  return output.system.join("\n\n");
}

async function compactionText(hooks: Hooks, sessionID = "session-1") {
  const output = { context: [] as string[] };
  await hooks["experimental.session.compacting"]?.({ sessionID }, output);
  return output.context.join("\n\n");
}

async function recall(
  hooks: Hooks,
  root: string,
  id: string,
  sessionID = "session-1",
) {
  const result = await hooks.tool?.recall_observation.execute(
    { id },
    {
      sessionID,
      messageID: "recall-1",
      agent: "build",
      directory: root,
      worktree: root,
      abort: new AbortController().signal,
      metadata() {},
      ask: async () => {},
    },
  );
  return typeof result === "object" ? result.output : (result ?? "");
}

async function deleteSession(hooks: Hooks, sessionID: string) {
  await hooks.event?.({
    event: {
      type: "session.deleted",
      properties: { sessionID, info: { id: sessionID } },
    } as never,
  });
}

describe("oc-observational-memory plugin", () => {
  test("records observations and reflections while injecting bounded memory into OpenCode hooks", async () => {
    const { root, hooks } = await createHooks({
      maxInjectedTokens: 1_500,
      maxCompactionContextTokens: 2_000,
    });

    await recordUser(
      hooks,
      "Remember plugin name is oc-observational-memory and make sure to add a NOTICE file.",
      1,
    );
    await recordAssistant(
      hooks,
      "Implemented the OpenCode plugin and verified the build completed successfully.",
      1,
    );

    const state = await readState(root);
    expect(state.observations).toHaveLength(2);
    expect(state.reflections).toHaveLength(1);

    const injected = await injectedText(hooks);
    expect(injected).toContain("These are condensed memories");
    expect(injected).toContain("## Reflections");
    expect(injected).toContain("## Observations");
    expect(injected).toContain("oc-observational-memory");

    const compaction = await compactionText(hooks);
    expect(compaction).toContain("Project observational memory:");
    expect(compaction).toContain("oc-observational-memory");
  });

  test("keeps complete store while bounding normal injection and compaction context separately", async () => {
    const { root, hooks } = await createHooks({
      maxInjectedTokens: 430,
      maxCompactionContextTokens: 720,
    });

    await recordUser(
      hooks,
      "Remember plugin name is oc-observational-memory and make sure to add a NOTICE file.",
      0,
    );
    for (let index = 1; index <= 14; index++) {
      await recordUser(
        hooks,
        `Goal should include context budget check number ${index} with enough details to consume budget quickly and prove lower priority observations can be omitted.`,
        index,
      );
    }

    const state = await readState(root);
    expect(state.observations).toHaveLength(15);
    expect(state.sources).toHaveLength(15);

    const injected = await injectedText(hooks);
    const compaction = await compactionText(hooks);
    expect(estimateTokens(injected)).toBeLessThanOrEqual(430);
    expect(estimateTokens(compaction)).toBeLessThanOrEqual(720);
    expect(estimateTokens(compaction)).toBeGreaterThan(
      estimateTokens(injected),
    );
    expect(injected).toContain("## Reflections");
    expect(injected).toContain("[critical]");
  });

  test("renders reflections first, then critical and high observations before medium and low", async () => {
    const { hooks } = await createHooks({ maxInjectedTokens: 1_500 });

    await recordUser(
      hooks,
      "Goal should include medium priority planning details for later.",
      1,
    );
    await recordAssistant(
      hooks,
      "Updated medium progress item with implementation details.",
      2,
    );
    await recordUser(
      hooks,
      "Remember source of truth is OpenCode and pi-observational-memory.",
      3,
    );
    await recordUser(
      hooks,
      "Make sure NOTICE remains required for this plugin release.",
      4,
    );

    const injected = await injectedText(hooks);
    const reflectionsIndex = injected.indexOf("## Reflections");
    const observationsIndex = injected.indexOf("## Observations");
    const criticalIndex = injected.indexOf("[critical]");
    const highIndex = injected.indexOf("[high]");
    const mediumIndex = injected.indexOf("[medium]");

    expect(reflectionsIndex).toBeGreaterThan(-1);
    expect(observationsIndex).toBeGreaterThan(reflectionsIndex);
    expect(criticalIndex).toBeGreaterThan(observationsIndex);
    expect(highIndex).toBeGreaterThan(observationsIndex);
    expect(mediumIndex).toBeGreaterThan(highIndex);
  });

  test("recall returns exact source evidence that injected memory omits", async () => {
    const { root, hooks } = await createHooks({ maxInjectedTokens: 1_500 });
    const sourceText =
      "Remember plugin name is oc-observational-memory and make sure to add a NOTICE file. Exact source phrase: alpha beta gamma.";
    await recordUser(hooks, sourceText, 1);

    const state = await readState(root);
    const injected = await injectedText(hooks);
    expect(injected).not.toContain("Exact source phrase: alpha beta gamma");

    const result = await hooks.tool?.recall_observation.execute(
      { id: state.observations[0].id },
      {
        sessionID: "session-1",
        messageID: "recall-1",
        agent: "build",
        directory: root,
        worktree: root,
        abort: new AbortController().signal,
        metadata() {},
        ask: async () => {},
      },
    );
    expect(typeof result).toBe("object");
    expect(result).toMatchObject({
      title: `Recall ${state.observations[0].id}`,
    });
    expect(typeof result === "object" ? result.output : result).toContain(
      "Exact source phrase: alpha beta gamma",
    );
  });

  test("does not create memory for ignored, synthetic, or non-text user parts", async () => {
    const { root, hooks } = await createHooks();
    await hooks["chat.message"]?.(
      { sessionID: "session-1", messageID: "ignored" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            ignored: true,
            text: "Remember ignored content must not persist.",
          } as never,
          {
            type: "text",
            synthetic: true,
            text: "Remember synthetic content must not persist.",
          } as never,
          {
            type: "file",
            text: "Remember file content must not persist.",
          } as never,
        ],
      },
    );

    expect(await fileExists(defaultMemoryFile(root))).toBe(false);
    expect(await injectedText(hooks)).toBe("");
  });

  test("observeUser false skips user messages but keeps assistant observation", async () => {
    const { root, hooks } = await createHooks({ observeUser: false });
    await recordUser(hooks, "Remember user content must not be stored.", 1);
    await recordAssistant(
      hooks,
      "Implemented assistant-only progress item for the project.",
      1,
    );

    const state = await readState(root);
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0].content).toContain("assistant-only progress");
    expect(state.observations[0].content).not.toContain("user content");
  });

  test("observeAssistant false skips assistant completions but keeps user observation", async () => {
    const { root, hooks } = await createHooks({ observeAssistant: false });
    await recordUser(hooks, "Remember user content must be stored.", 1);
    await recordAssistant(
      hooks,
      "Implemented assistant content that must not be stored.",
      1,
    );

    const state = await readState(root);
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0].content).toContain("user content");
    expect(state.observations[0].content).not.toContain("assistant content");
  });

  test("inject false records memory but does not add system context", async () => {
    const { root, hooks } = await createHooks({ inject: false });
    await recordUser(
      hooks,
      "Remember injection must be disabled for this plugin run.",
      1,
    );

    expect((await readState(root)).observations).toHaveLength(1);
    expect(await injectedText(hooks)).toBe("");
  });

  test("system transform without session id does not inject memory", async () => {
    const { hooks } = await createHooks();
    await recordUser(
      hooks,
      "Remember sessionless system transform must not inject.",
      1,
    );
    const output = { system: [] as string[] };

    await hooks["experimental.chat.system.transform"]?.(
      { model: {} as never },
      output,
    );

    expect(output.system).toEqual([]);
  });

  test("compactionContext false records memory but does not append compaction context", async () => {
    const { root, hooks } = await createHooks({ compactionContext: false });
    await recordUser(
      hooks,
      "Remember compaction context must be disabled for this plugin run.",
      1,
    );

    expect((await readState(root)).observations).toHaveLength(1);
    expect(await compactionText(hooks)).toBe("");
  });

  test("tiny token budgets keep store but produce no injected or compaction memory", async () => {
    const { root, hooks } = await createHooks({
      maxInjectedTokens: 20,
      maxCompactionContextTokens: 20,
    });
    await recordUser(
      hooks,
      "Remember tiny budgets must keep stored memory without injecting it.",
      1,
    );

    expect((await readState(root)).observations).toHaveLength(1);
    expect(await injectedText(hooks)).toBe("");
    expect(await compactionText(hooks)).toBe("");
  });

  test("invalid token budget options fall back to defaults", async () => {
    const { hooks } = await createHooks({
      maxInjectedTokens: -1,
      maxCompactionContextTokens: "bad",
    });
    await recordUser(
      hooks,
      "Remember invalid options must fall back to default token budgets.",
      1,
    );

    expect(await injectedText(hooks)).toContain("invalid options");
    expect(await compactionText(hooks)).toContain("invalid options");
  });

  test("relative storeDir writes under worktree", async () => {
    const { root, hooks } = await createHooks({ storeDir: ".memory-test" });
    await recordUser(
      hooks,
      "Remember relative store directory must be honored.",
      1,
    );

    const state = await readStateFile(
      path.join(root, ".memory-test/memory.json"),
    );
    expect(state.observations[0].content).toContain("relative store directory");
  });

  test("absolute storeDir writes to absolute path", async () => {
    const root = await mkdtemp(path.join(tempRoot, "oc-om-vitest-"));
    const storeDir = path.join(root, "absolute-memory");
    const hooks = await createHooksAtRoot(root, { storeDir });
    await recordUser(
      hooks,
      "Remember absolute store directory must be honored.",
      1,
    );

    const state = await readStateFile(path.join(storeDir, "memory.json"));
    expect(state.observations[0].content).toContain("absolute store directory");
  });

  test("memory persists across plugin instances for the same worktree", async () => {
    const root = await mkdtemp(path.join(tempRoot, "oc-om-vitest-"));
    const first = await createHooksAtRoot(root);
    await recordUser(
      first,
      "Remember persisted memory must survive plugin reload.",
      1,
    );

    const second = await createHooksAtRoot(root);

    expect(await injectedText(second)).toContain("persisted memory");
  });

  test("separate worktrees keep separate memory stores", async () => {
    const first = await createHooks();
    const second = await createHooks();
    await recordUser(
      first.hooks,
      "Remember first project must use alpha memory.",
      1,
    );
    await recordUser(
      second.hooks,
      "Remember second project must use beta memory.",
      1,
    );

    expect(await injectedText(first.hooks)).toContain("alpha memory");
    expect(await injectedText(first.hooks)).not.toContain("beta memory");
    expect(await injectedText(second.hooks)).toContain("beta memory");
    expect(await injectedText(second.hooks)).not.toContain("alpha memory");
  });

  test("same worktree keeps memory scoped to current session", async () => {
    const { hooks } = await createHooks();
    await recordUser(
      hooks,
      "Remember session alpha must use alpha memory.",
      1,
      "session-alpha",
    );
    await recordUser(
      hooks,
      "Remember session beta must use beta memory.",
      1,
      "session-beta",
    );

    expect(await injectedText(hooks, "session-alpha")).toContain(
      "alpha memory",
    );
    expect(await injectedText(hooks, "session-alpha")).not.toContain(
      "beta memory",
    );
    expect(await injectedText(hooks, "session-beta")).toContain("beta memory");
    expect(await injectedText(hooks, "session-beta")).not.toContain(
      "alpha memory",
    );
    expect(await compactionText(hooks, "session-alpha")).toContain(
      "alpha memory",
    );
    expect(await compactionText(hooks, "session-alpha")).not.toContain(
      "beta memory",
    );
  });

  test("same worktree recall is session scoped", async () => {
    const { root, hooks } = await createHooks();
    await recordUser(
      hooks,
      "Remember session alpha must keep alpha-only recall.",
      1,
      "session-alpha",
    );
    await recordUser(
      hooks,
      "Remember session beta must keep beta-only recall.",
      1,
      "session-beta",
    );
    const state = await readState(root);
    const alpha = state.observations.find((observation) =>
      observation.content.includes("alpha-only"),
    );
    const beta = state.observations.find((observation) =>
      observation.content.includes("beta-only"),
    );

    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(await recall(hooks, root, alpha!.id, "session-alpha")).toContain(
      "alpha-only recall",
    );
    expect(await recall(hooks, root, alpha!.id, "session-beta")).toContain(
      "No observational memory found",
    );
    expect(await recall(hooks, root, beta!.id, "session-alpha")).toContain(
      "No observational memory found",
    );
  });

  test("session.deleted removes deleted session memory and keeps other sessions", async () => {
    const { root, hooks } = await createHooks();
    await recordUser(
      hooks,
      "Remember session alpha must be removed on deletion.",
      1,
      "session-alpha",
    );
    await recordUser(
      hooks,
      "Remember session beta must survive other session deletion.",
      1,
      "session-beta",
    );

    await deleteSession(hooks, "session-alpha");

    const state = await readState(root);
    expect(
      state.sources.every((source) => !source.text.includes("alpha")),
    ).toBe(true);
    expect(
      state.observations.every(
        (observation) => !observation.content.includes("alpha"),
      ),
    ).toBe(true);
    expect(await injectedText(hooks, "session-alpha")).toBe("");
    expect(await injectedText(hooks, "session-beta")).toContain("beta");
  });

  test("session.deleted via info.id removes matching memory", async () => {
    const { hooks } = await createHooks();
    await recordUser(
      hooks,
      "Remember session gamma must be removed by info id.",
      1,
      "session-gamma",
    );

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "session-gamma" } },
      } as never,
    });

    expect(await injectedText(hooks, "session-gamma")).toBe("");
  });

  test("session.deleted prunes shared duplicate memory only after all sessions are deleted", async () => {
    const { root, hooks } = await createHooks();
    await recordUser(
      hooks,
      "Remember duplicate cross-session content must persist while any session remains.",
      1,
      "session-alpha",
    );
    await recordUser(
      hooks,
      "Remember duplicate cross-session content must persist while any session remains.",
      1,
      "session-beta",
    );
    let state = await readState(root);
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0].sourceEntryIds).toHaveLength(2);

    await deleteSession(hooks, "session-alpha");
    state = await readState(root);
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0].sourceEntryIds).toHaveLength(1);
    expect(await injectedText(hooks, "session-beta")).toContain(
      "duplicate cross-session",
    );

    await deleteSession(hooks, "session-beta");
    state = await readState(root);
    expect(state.observations).toHaveLength(0);
    expect(state.reflections).toHaveLength(0);
    expect(state.sources).toHaveLength(0);
  });

  test("duplicate observation content keeps one observation id", async () => {
    const { root, hooks } = await createHooks();
    await recordUser(
      hooks,
      "Remember duplicate observation content must collapse.",
      1,
    );
    await recordUser(
      hooks,
      "Remember duplicate observation content must collapse.",
      2,
    );

    const state = await readState(root);
    expect(state.observations).toHaveLength(1);
    expect(state.sources).toHaveLength(2);
  });

  test("chat.message without messageID still records deterministic memory", async () => {
    const { root, hooks } = await createHooks();
    await hooks["chat.message"]?.(
      { sessionID: "session-1" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            text: "Remember missing message id must still record memory.",
          } as never,
        ],
      },
    );

    const state = await readState(root);
    expect(state.observations).toHaveLength(1);
    expect(state.sources[0].messageID).toMatch(/^[a-f0-9]{12}$/);
  });

  test("recall for reflection includes supporting observation and source", async () => {
    const { root, hooks } = await createHooks();
    await recordUser(
      hooks,
      "Remember reflection recall must include supporting source evidence.",
      1,
    );
    const state = await readState(root);

    const output = await recall(hooks, root, state.reflections[0].id);

    expect(output).toContain(`Reflection ${state.reflections[0].id}`);
    expect(output).toContain(`Supporting observations:`);
    expect(output).toContain("supporting source evidence");
    expect(output).toContain("Sources:");
  });

  test("recall rejects invalid memory ids", async () => {
    const { root, hooks } = await createHooks();

    expect(await recall(hooks, root, "not-valid")).toContain(
      "Invalid memory id",
    );
  });

  test("recall reports missing valid memory ids", async () => {
    const { root, hooks } = await createHooks();

    expect(await recall(hooks, root, "abcdef123456")).toContain(
      "No observational memory found",
    );
  });

  test("medium and low observations are omitted first under tight budget", async () => {
    const { hooks } = await createHooks({ maxInjectedTokens: 430 });
    await recordUser(
      hooks,
      "Remember critical preference must stay in tiny injected context.",
      1,
    );
    for (let index = 0; index < 8; index++) {
      await recordUser(
        hooks,
        `Goal should include medium detail ${index} that can be dropped from injected context.`,
        index + 2,
      );
    }

    const injected = await injectedText(hooks);
    expect(injected).toContain("critical preference");
    expect(injected).not.toContain("medium detail 0");
  });

  test("disabled plugin registers no hooks", async () => {
    const { hooks } = await createHooks({ enabled: false });
    expect(hooks).toEqual({});
  });
});
