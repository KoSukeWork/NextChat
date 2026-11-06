import { jest } from "@jest/globals";

jest.mocked(global.fetch).mockImplementation(
  async (input) =>
    ({
      json: async () =>
        String(input).includes("prompts.json")
          ? { en: [], cn: [], tw: [] }
          : [],
    }) as Response,
);

await import("../app/client/api");
await import("../app/store");
const { StoreKey } = await import("../app/constant");
const { useMaskStore } = await import("../app/store/mask");
const { SearchService, usePromptStore } = await import("../app/store/prompt");
const {
  getCloudAppState,
  getLocalAppState,
  mergeCloudAppState,
  setCloudAppState,
  setLocalAppState,
} = await import("../app/utils/sync");
const { restoreBackup } = await import("../app/utils/backup");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const mask = (id: string, updatedAt: number, name = id) =>
  ({ id, name, createdAt: 10, updatedAt, builtin: false }) as any;
const prompt = (id: string, updatedAt: number, title = id) =>
  ({
    id,
    title,
    content: title,
    createdAt: 10,
    updatedAt,
    isUser: true,
  }) as any;

function state(masks: Record<string, any>, prompts: Record<string, any>) {
  const value = clone(getCloudAppState());
  value[StoreKey.Mask].masks = masks;
  value[StoreKey.Mask].deletedMasks = {};
  value[StoreKey.Prompt].prompts = prompts;
  value[StoreKey.Prompt].deletedPrompts = {};
  return value;
}

beforeEach(() => {
  useMaskStore.setState({ masks: {}, deletedMasks: {} });
  usePromptStore.setState({ prompts: {}, deletedPrompts: {} });
  SearchService.setUserPrompts([]);
});

test("new items and edits record clocks; deletions beat even future edits", () => {
  const m = useMaskStore.getState().create({ name: "mask" });
  const id = usePromptStore.getState().add(prompt("ignored", 0, "prompt"));
  expect(m.updatedAt).toBeGreaterThan(0);
  expect(usePromptStore.getState().prompts[id].updatedAt).toBeGreaterThan(0);
  const future = Date.now() + 60_000;
  useMaskStore.setState({ masks: { [m.id]: { ...m, updatedAt: future } } });
  usePromptStore.setState({ prompts: { [id]: prompt(id, future) } });
  useMaskStore.getState().updateMask(m.id, (item) => {
    item.name = "edited";
  });
  usePromptStore.getState().updatePrompt(id, (item) => {
    item.title = "edited";
  });
  expect(useMaskStore.getState().masks[m.id].updatedAt).toBe(future + 1);
  expect(usePromptStore.getState().prompts[id].updatedAt).toBe(future + 1);
  useMaskStore.getState().delete(m.id);
  usePromptStore.getState().remove(id);
  expect(useMaskStore.getState().deletedMasks[m.id]).toBe(future + 2);
  expect(usePromptStore.getState().deletedPrompts[id]).toBe(future + 2);
});

test("two devices merge newer edits and propagate deletions, with local ties", () => {
  const a = state(
    {
      changed: mask("changed", 10, "old"),
      tie: mask("tie", 20, "local"),
      removed: mask("removed", 10),
    },
    {
      changed: prompt("changed", 10, "old"),
      tie: prompt("tie", 20, "local"),
      removed: prompt("removed", 10),
    },
  );
  const b = state(
    { changed: mask("changed", 30, "new"), tie: mask("tie", 20, "remote") },
    { changed: prompt("changed", 30, "new"), tie: prompt("tie", 20, "remote") },
  );
  b[StoreKey.Mask].deletedMasks = { removed: 20 };
  b[StoreKey.Prompt].deletedPrompts = { removed: 20 };
  const merged = mergeCloudAppState(a, b);
  expect(merged[StoreKey.Mask].masks.changed.name).toBe("new");
  expect(merged[StoreKey.Prompt].prompts.changed.title).toBe("new");
  expect(merged[StoreKey.Mask].masks.tie.name).toBe("local");
  expect(merged[StoreKey.Prompt].prompts.tie.title).toBe("local");
  expect(merged[StoreKey.Mask].masks.removed).toBeUndefined();
  expect(merged[StoreKey.Prompt].prompts.removed).toBeUndefined();
  const syncedBack = mergeCloudAppState(b, merged);
  expect(syncedBack[StoreKey.Mask].deletedMasks.removed).toBe(20);
  expect(syncedBack[StoreKey.Prompt].deletedPrompts.removed).toBe(20);
});

test("an edit after deletion wins and clears the corresponding tombstone", () => {
  const a = state({}, {});
  a[StoreKey.Mask].deletedMasks = { item: 20 };
  a[StoreKey.Prompt].deletedPrompts = { item: 20 };
  const b = state({ item: mask("item", 21) }, { item: prompt("item", 21) });
  const result = mergeCloudAppState(a, b);
  expect(result[StoreKey.Mask].masks.item).toBeDefined();
  expect(result[StoreKey.Prompt].prompts.item).toBeDefined();
  expect(result[StoreKey.Mask].deletedMasks.item).toBeUndefined();
  expect(result[StoreKey.Prompt].deletedPrompts.item).toBeUndefined();
});

test("equal deletion timestamps win and stale devices cannot resurrect deleted records", () => {
  const local = state({ item: mask("item", 20) }, { item: prompt("item", 20) });
  const deletion = state({}, {});
  deletion[StoreKey.Mask].deletedMasks = { item: 20 };
  deletion[StoreKey.Prompt].deletedPrompts = { item: 20 };
  const result = mergeCloudAppState(local, deletion);
  const stale = state({ item: mask("item", 19) }, { item: prompt("item", 19) });
  const again = mergeCloudAppState(result, stale);
  expect(again[StoreKey.Mask].masks.item).toBeUndefined();
  expect(again[StoreKey.Prompt].prompts.item).toBeUndefined();
  expect(again[StoreKey.Mask].deletedMasks.item).toBe(20);
  expect(again[StoreKey.Prompt].deletedPrompts.item).toBe(20);
});

test("legacy map keys are reconciled by record id before applying deletions", () => {
  const local = state({}, {});
  local[StoreKey.Mask].deletedMasks = { item: 20 };
  local[StoreKey.Prompt].deletedPrompts = { item: 20 };
  const old = state(
    { legacyKey: mask("item", 10) },
    { legacyKey: prompt("item", 10) },
  );
  const merged = mergeCloudAppState(local, old);
  expect(Object.keys(merged[StoreKey.Mask].masks)).toEqual([]);
  expect(Object.keys(merged[StoreKey.Prompt].prompts)).toEqual([]);
});

test("legacy remote records without ids use their storage keys for later deletion", () => {
  const local = state({}, {});
  const remote = state(
    { oldMask: { ...mask("ignored", 10), id: undefined } },
    { oldPrompt: { ...prompt("ignored", 10), id: undefined } },
  );
  const merged = mergeCloudAppState(local, remote);
  expect(merged[StoreKey.Mask].masks.oldMask.id).toBe("oldMask");
  expect(merged[StoreKey.Prompt].prompts.oldPrompt.id).toBe("oldPrompt");

  setCloudAppState(merged);
  useMaskStore.getState().delete("oldMask");
  usePromptStore.getState().remove("oldPrompt");
  expect(useMaskStore.getState().deletedMasks.oldMask).toBeGreaterThan(10);
  expect(usePromptStore.getState().deletedPrompts.oldPrompt).toBeGreaterThan(10);
});

test("import explicitly restores items despite later tombstones without mutating backup", () => {
  const local = clone(getLocalAppState());
  const backup = clone(local);
  const future = Date.now() + 60_000;
  local[StoreKey.Mask].masks = {};
  local[StoreKey.Prompt].prompts = {};
  local[StoreKey.Mask].deletedMasks = { item: future };
  local[StoreKey.Prompt].deletedPrompts = { item: future };
  backup[StoreKey.Mask].masks = { item: mask("item", 10) };
  backup[StoreKey.Prompt].prompts = { item: prompt("item", 10) };
  const original = clone(backup);
  const result = restoreBackup(local, backup, { plugins: {} }, {});
  expect(result.local[StoreKey.Mask].masks.item.updatedAt).toBeGreaterThan(
    future,
  );
  expect(result.local[StoreKey.Prompt].prompts.item.updatedAt).toBeGreaterThan(
    future,
  );
  expect(result.local[StoreKey.Mask].deletedMasks.item).toBeUndefined();
  expect(result.local[StoreKey.Prompt].deletedPrompts.item).toBeUndefined();
  expect(backup).toEqual(original);
  setLocalAppState(result.local);
  expect(SearchService.search("item").some((item) => item.id === "item")).toBe(
    true,
  );
});

test("legacy store migrations use createdAt and initialize deletion maps", async () => {
  const migrateMask = useMaskStore.persist.getOptions().migrate!;
  const migratePrompt = usePromptStore.persist.getOptions().migrate!;
  const oldMask = { id: "a", createdAt: 123, name: "old" };
  const oldPrompt = { id: "a", createdAt: 456, title: "old", content: "old" };
  const masks = (await migrateMask(
    { masks: { legacyKey: oldMask } } as any,
    3.1,
  )) as any;
  const prompts = (await migratePrompt(
    { prompts: { legacyKey: oldPrompt } } as any,
    3,
  )) as any;
  expect(masks.masks.a.updatedAt).toBe(123);
  expect(prompts.prompts.a.updatedAt).toBe(456);
  expect(Object.keys(masks.masks)).toEqual(["a"]);
  expect(Object.keys(prompts.prompts)).toEqual(["a"]);
  expect(masks.deletedMasks).toEqual({});
  expect(prompts.deletedPrompts).toEqual({});
});

test("applying synced prompts refreshes search while preserving builtin prompts", () => {
  const builtin = prompt("builtin", 10, "builtin needle");
  SearchService.builtinPrompts = [builtin];
  SearchService.builtinEngine.setCollection([builtin]);
  const old = prompt("old", 10, "obsolete kiwi");
  SearchService.setUserPrompts([old]);
  const incoming = state({}, { fresh: prompt("fresh", 20, "fresh melon") });
  setCloudAppState(incoming);
  expect(
    SearchService.search("obsolete kiwi").some((p) => p.id === "old"),
  ).toBe(false);
  expect(
    SearchService.search("fresh melon").some((p) => p.id === "fresh"),
  ).toBe(true);
  expect(
    SearchService.search("builtin needle").some((p) => p.id === "builtin"),
  ).toBe(true);
});
