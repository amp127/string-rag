import { describe, expect, test } from "vitest";
import type { TestConvex } from "convex-test";
import { StringRAG, type EntryId } from "./index.js";
import type { DataModelFromSchemaDefinition } from "convex/server";
import type { EmbeddingModelUsage } from "ai";
import type { Status } from "../shared.js";
import {
  anyApi,
  queryGeneric,
  mutationGeneric,
  actionGeneric,
} from "convex/server";
import type {
  ApiFromModules,
  ActionBuilder,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { defineSchema } from "convex/server";
import { components, initConvexTest } from "./setup.test.js";
import { openai } from "@ai-sdk/openai";

// The schema for the tests
const schema = defineSchema({});
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
// type DatabaseReader = GenericDatabaseReader<DataModel>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const action = actionGeneric as ActionBuilder<DataModel, "public">;

const rag = new StringRAG(components.rag, {
  embeddingDimension: 1536,
  textEmbeddingModel: openai.embedding("text-embedding-3-small"),
  filterNames: ["simpleString", "arrayOfStrings", "customObject"],
});

export const findEntryByContentHash = query({
  args: { namespace: v.string(), key: v.string(), contentHash: v.string() },
  handler: async (ctx, args) => {
    return rag.findEntryByContentHash(ctx, {
      namespace: args.namespace,
      key: args.key,
      contentHash: args.contentHash,
    });
  },
});

export const add = mutation({
  args: {
    key: v.string(),
    text: v.optional(v.string()),
    content: v.optional(
      v.object({
        content: v.object({
          text: v.string(),
          metadata: v.optional(v.record(v.string(), v.any())),
        }),
        embedding: v.array(v.number()),
        searchableText: v.optional(v.string()),
      }),
    ),
    namespace: v.string(),
    title: v.optional(v.string()),
    filterValues: v.optional(
      v.array(
        v.union(
          v.object({
            name: v.literal("simpleString"),
            value: v.string(),
          }),
          v.object({
            name: v.literal("arrayOfStrings"),
            value: v.array(v.string()),
          }),
          v.object({
            name: v.literal("customObject"),
            value: v.record(v.string(), v.any()),
          }),
        ),
      ),
    ),
    importance: v.optional(v.number()),
    contentHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const base = {
      namespace: args.namespace,
      key: args.key,
      title: args.title,
      filterValues: args.filterValues,
      importance: args.importance,
      contentHash: args.contentHash,
    };
    if (args.content !== undefined) {
      return rag.add(ctx, { ...base, content: args.content });
    }
    return rag.add(ctx, { ...base, text: args.text ?? "" });
  },
});

const filterValuesValidator = v.optional(
  v.array(
    v.union(
      v.object({ name: v.literal("simpleString"), value: v.string() }),
      v.object({
        name: v.literal("arrayOfStrings"),
        value: v.array(v.string()),
      }),
      v.object({
        name: v.literal("customObject"),
        value: v.record(v.string(), v.any()),
      }),
    ),
  ),
);

export const search = action({
  args: {
    embedding: v.array(v.number()),
    namespace: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { results, entries, text, usage } = await rag.search(ctx, {
      query: args.embedding,
      namespace: args.namespace,
      limit: args.limit ?? 10,
    });

    return {
      results,
      text,
      entries,
      usage,
    };
  },
});

export const searchWithFilters = action({
  args: {
    embedding: v.array(v.number()),
    namespace: v.string(),
    limit: v.optional(v.number()),
    filters: filterValuesValidator,
  },
  handler: async (ctx, args) => {
    const { results, entries, text, usage } = await rag.search(ctx, {
      query: args.embedding,
      namespace: args.namespace,
      limit: args.limit ?? 10,
      filters: args.filters ?? [],
    });

    return {
      results,
      text,
      entries,
      usage,
    };
  },
});

export const searchWithEntryId = action({
  args: {
    entryId: v.string(),
    limit: v.optional(v.number()),
    vectorScoreThreshold: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return rag.searchWithEntryId(ctx, {
      entryId: args.entryId as EntryId,
      limit: args.limit ?? 10,
      vectorScoreThreshold: args.vectorScoreThreshold,
    });
  },
});

export const searchSimilar = action({
  args: {
    namespace: v.string(),
    key: v.string(),
    limit: v.optional(v.number()),
    vectorScoreThreshold: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return rag.searchSimilar(ctx, {
      namespace: args.namespace,
      key: args.key,
      limit: args.limit ?? 10,
      vectorScoreThreshold: args.vectorScoreThreshold,
    });
  },
});

const addManyItemsValidator = v.array(
  v.object({
    key: v.optional(v.string()),
    text: v.optional(v.string()),
    content: v.optional(
      v.object({
        content: v.object({
          text: v.string(),
          metadata: v.optional(v.record(v.string(), v.any())),
        }),
        embedding: v.array(v.number()),
        searchableText: v.optional(v.string()),
      }),
    ),
    namespace: v.optional(v.string()),
    title: v.optional(v.string()),
    filterValues: v.optional(
      v.array(
        v.union(
          v.object({ name: v.literal("simpleString"), value: v.string() }),
          v.object({
            name: v.literal("arrayOfStrings"),
            value: v.array(v.string()),
          }),
          v.object({
            name: v.literal("customObject"),
            value: v.record(v.string(), v.any()),
          }),
        ),
      ),
    ),
    importance: v.optional(v.number()),
    contentHash: v.optional(v.string()),
  }),
);

export const addMany = mutation({
  args: {
    namespace: v.string(),
    items: addManyItemsValidator,
    maxBatchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const defaultFilterValues = [
      { name: "simpleString" as const, value: "" },
      { name: "arrayOfStrings" as const, value: [] as string[] },
      { name: "customObject" as const, value: {} as Record<string, unknown> },
    ];
    const items = args.items.map((item) => {
      const base = {
        key: item.key,
        title: item.title,
        filterValues: item.filterValues ?? defaultFilterValues,
        importance: item.importance,
        contentHash: item.contentHash,
      };
      if (item.content) {
        return { ...base, content: item.content };
      }
      return { ...base, text: item.text ?? "" };
    });
    return rag.addMany(ctx, {
      namespace: args.namespace,
      items,
      maxBatchSize: args.maxBatchSize,
    });
  },
});

export const getEntries = query({
  args: { entryIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    return rag.getEntries(ctx, {
      entryIds: args.entryIds as EntryId[],
    });
  },
});

export const deleteMany = mutation({
  args: { entryIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    return rag.deleteMany(ctx, {
      entryIds: args.entryIds as EntryId[],
    });
  },
});

const testApi: ApiFromModules<{
  fns: {
    findEntryByContentHash: typeof findEntryByContentHash;
    add: typeof add;
    addMany: typeof addMany;
    getEntries: typeof getEntries;
    deleteMany: typeof deleteMany;
    search: typeof search;
    searchWithFilters: typeof searchWithFilters;
    searchWithEntryId: typeof searchWithEntryId;
    searchSimilar: typeof searchSimilar;
  };
}>["fns"] = anyApi["index.test"] as any;

function dummyEmbeddings(text: string) {
  return Array.from({ length: 1536 }, (_, i) =>
    i === 0 ? text.charCodeAt(0) / 256 : 0.1,
  );
}

/** Return shape of `rag.add` / the test `add` mutation (mirrors StringRAG.add). */
type AddMutationResult = {
  entryId: EntryId;
  status: Status;
  created: boolean;
  replacedEntry: unknown;
  usage: EmbeddingModelUsage;
};

function addWithDummyContent(
  t: TestConvex<typeof schema>,
  args: {
    key: string;
    text: string;
    namespace: string;
    title?: string;
    contentHash?: string;
  },
): Promise<AddMutationResult> {
  const { key, text, namespace, title, contentHash } = args;
  return t.mutation(testApi.add, {
    key,
    namespace,
    title,
    contentHash,
    content: {
      content: { text },
      embedding: dummyEmbeddings(text),
      searchableText: text,
    },
  }) as Promise<AddMutationResult>;
}

describe("StringRAG thick client", () => {
  test("should add a entry and be able to list it", async () => {
    const t = initConvexTest(schema);
    const { entryId, status, usage } = await addWithDummyContent(t, {
      key: "test",
      text: "Hello world",
      namespace: "test",
    });
    expect(entryId).toBeDefined();
    expect(status).toBe("ready");
    expect(usage).toEqual({ tokens: 0 });
    await t.run(async (ctx) => {
      const ns = await rag.getNamespace(ctx, { namespace: "test" });
      expect(ns).not.toBeNull();
      const { page } = await rag.list(ctx, {
        namespaceId: ns!.namespaceId,
        limit: 10,
      });
      expect(page.length).toBeGreaterThanOrEqual(1);
      expect(page.some((e) => e.entryId === entryId)).toBe(true);
    });
  });

  test("should work from a test function", async () => {
    const t = initConvexTest(schema);
    await addWithDummyContent(t, {
      key: "test",
      text: "Test content",
      namespace: "test",
    });
  });

  test("should be able to re-add an entry with the same key", async () => {
    const t = initConvexTest(schema);
    const { entryId, status, usage } = await addWithDummyContent(t, {
      key: "test",
      text: "A",
      namespace: "test",
    });
    expect(entryId).toBeDefined();
    expect(status).toBe("ready");
    expect(usage).toEqual({ tokens: 0 });
    const {
      entryId: entryId2,
      status: status2,
      usage: usage2,
    } = await addWithDummyContent(t, {
      key: "test",
      text: "A",
      namespace: "test",
    });
    expect(entryId2).toBeDefined();
    expect(status2).toBe("ready");
    expect(usage2).toEqual({ tokens: 0 });
    const entry = await t.run(async (ctx) => rag.getEntry(ctx, { entryId: entryId2 }));
    expect(entry).not.toBeNull();
    expect(entry!.entryId).toBe(entryId2);
  });

  describe("text formatting validation", () => {
    test("should format single entry content correctly", async () => {
      const t = initConvexTest(schema);

      await addWithDummyContent(t, {
        key: "sequential-test",
        text: "Single content block",
        namespace: "format-test",
        title: "Test Document",
      });

      const { text, entries, usage } = await t.action(testApi.search, {
        embedding: dummyEmbeddings("content"),
        namespace: "format-test",
        limit: 10,
      });

      expect(text).toContain("## Test Document:");
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("Single content block");
      expect(text).toBe("## Test Document:\n\nSingle content block");
      expect(usage).toEqual({ tokens: 0 });
    });

    test("should format single entry without title correctly", async () => {
      const t = initConvexTest(schema);

      await addWithDummyContent(t, {
        key: "no-title-test",
        text: "Content without title",
        namespace: "format-test-notitle",
      });

      const { text, entries, usage } = await t.action(testApi.search, {
        embedding: dummyEmbeddings("content"),
        namespace: "format-test-notitle",
        limit: 10,
      });

      // Should not have "## " prefix since no title
      expect(text).not.toContain("## ");
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("Content without title");
      expect(text).toBe("Content without title");
      expect(usage).toEqual({ tokens: 0 });
    });

    test("should return entry text from search", async () => {
      const t = initConvexTest(schema);

      await addWithDummyContent(t, {
        key: "doc1",
        text: "Important content",
        namespace: "ellipsis-test",
        title: "Document",
      });

      const { text, entries } = await t.action(testApi.search, {
        embedding: dummyEmbeddings("Important"),
        namespace: "ellipsis-test",
        limit: 2,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("Important content");
      expect(text).toContain("Important content");
    });

    test("should format multiple entries with separators", async () => {
      const t = initConvexTest(schema);

      await addWithDummyContent(t, {
        key: "first-doc",
        text: "First document content",
        namespace: "multi-entry-test",
        title: "First Document",
      });

      await addWithDummyContent(t, {
        key: "second-doc",
        text: "Second document content",
        namespace: "multi-entry-test",
        title: "Second Document",
      });

      const { text, entries } = await t.action(testApi.search, {
        embedding: dummyEmbeddings("document"),
        namespace: "multi-entry-test",
        limit: 10,
      });

      // Should have entries separated by "\n---\n" as per README
      expect(text).toContain("---");
      expect(text).toMatch(/## .+:\n\n.+\n\n---\n\n## .+:\n\n.+/);

      // Should have both titles prefixed with "## "
      expect(text).toContain("## First Document:");
      expect(text).toContain("## Second Document:");

      expect(entries).toHaveLength(2);
    });

    test("should format mixed entries (with and without titles)", async () => {
      const t = initConvexTest(schema);

      await addWithDummyContent(t, {
        key: "titled-doc",
        text: "Content with title",
        namespace: "mixed-test",
        title: "Titled Document",
      });

      await addWithDummyContent(t, {
        key: "untitled-doc",
        text: "Content without title",
        namespace: "mixed-test",
      });

      const { text, entries } = await t.action(testApi.search, {
        embedding: dummyEmbeddings("content"),
        namespace: "mixed-test",
        limit: 10,
      });

      // Should properly handle mixed formatting
      expect(text).toContain("---"); // Entries should be separated
      expect(text).toContain("## Titled Document:"); // Titled entry should have prefix

      // One entry should have title format, one should not
      const parts = text.split("\n---\n");
      expect(parts).toHaveLength(2);

      const hasTitle = parts.some((part) => part.startsWith("## "));
      const hasNoTitle = parts.some((part) => !part.startsWith("## "));
      expect(hasTitle).toBe(true);
      expect(hasNoTitle).toBe(true);

      expect(entries).toHaveLength(2);
    });

    test("should match exact README format specification", async () => {
      const t = initConvexTest(schema);

      await addWithDummyContent(t, {
        key: "title1-doc",
        text: "Content 1",
        namespace: "readme-format-test",
        title: "Title 1",
      });

      await addWithDummyContent(t, {
        key: "title2-doc",
        text: "Content 3",
        namespace: "readme-format-test",
        title: "Title 2",
      });

      const { text, entries } = await t.action(testApi.search, {
        embedding: dummyEmbeddings("contents"),
        namespace: "readme-format-test",
        limit: 10,
      });

      // Verify basic structure matches README
      expect(text).toContain("## Title 1:");
      expect(text).toContain("## Title 2:");
      expect(text).toContain("---");

      // Should have proper entry separation
      const parts = text.split("\n\n---\n\n");
      expect(parts).toHaveLength(2);

      // Each part should start with "## Title X:"
      parts.forEach((part) => {
        expect(part).toMatch(/^## Title \d+:/);
      });

      expect(entries).toHaveLength(2);

      expect(text).toBe(
        `## Title 1:

Content 1

---

## Title 2:

Content 3`,
      );
    });
  });

  describe("filters", () => {
    test("filterValues array order does not matter when adding", async () => {
      const t = initConvexTest(schema);
      const ns = "filter-order-ns";

      await t.mutation(testApi.add, {
        key: "order-a",
        namespace: ns,
        text: "Entry with filters A then B",
        content: {
          content: { text: "Entry with filters A then B" },
          embedding: dummyEmbeddings("order-a"),
          searchableText: "Entry with filters A then B",
        },
        filterValues: [
          { name: "simpleString", value: "tag-a" },
          { name: "arrayOfStrings", value: ["tag-b"] },
          { name: "customObject", value: {} },
        ],
      });
      await t.mutation(testApi.add, {
        key: "order-b",
        namespace: ns,
        text: "Entry with filters B then A",
        content: {
          content: { text: "Entry with filters B then A" },
          embedding: dummyEmbeddings("order-b"),
          searchableText: "Entry with filters B then A",
        },
        filterValues: [
          { name: "arrayOfStrings", value: ["tag-b"] },
          { name: "customObject", value: {} },
          { name: "simpleString", value: "tag-a" },
        ],
      });

      const bySimple = await t.action(testApi.searchWithFilters, {
        embedding: dummyEmbeddings("tag"),
        namespace: ns,
        filters: [{ name: "simpleString", value: "tag-a" }],
        limit: 10,
      });
      const byArray = await t.action(testApi.searchWithFilters, {
        embedding: dummyEmbeddings("tag"),
        namespace: ns,
        filters: [{ name: "arrayOfStrings", value: ["tag-b"] }],
        limit: 10,
      });

      expect(bySimple.entries).toHaveLength(2);
      expect(byArray.entries).toHaveLength(2);
      const keys = new Set(bySimple.entries.map((e) => e.key));
      expect(keys).toContain("order-a");
      expect(keys).toContain("order-b");
    });

    test("search filters array order does not matter", async () => {
      const t = initConvexTest(schema);
      const ns = "search-filter-order-ns";

      await t.mutation(testApi.add, {
        key: "both-filters",
        namespace: ns,
        text: "Has both filters",
        content: {
          content: { text: "Has both filters" },
          embedding: dummyEmbeddings("both"),
          searchableText: "Has both filters",
        },
        filterValues: [
          { name: "simpleString", value: "search-a" },
          { name: "arrayOfStrings", value: ["search-b"] },
          { name: "customObject", value: {} },
        ],
      });

      const order1 = await t.action(testApi.searchWithFilters, {
        embedding: dummyEmbeddings("both"),
        namespace: ns,
        filters: [
          { name: "simpleString", value: "search-a" },
          { name: "arrayOfStrings", value: ["search-b"] },
        ],
        limit: 10,
      });
      const order2 = await t.action(testApi.searchWithFilters, {
        embedding: dummyEmbeddings("both"),
        namespace: ns,
        filters: [
          { name: "arrayOfStrings", value: ["search-b"] },
          { name: "simpleString", value: "search-a" },
        ],
        limit: 10,
      });

      expect(order1.entries).toHaveLength(1);
      expect(order2.entries).toHaveLength(1);
      expect(order1.entries[0].entryId).toBe(order2.entries[0].entryId);
    });
  });

  describe("searchWithEntryId", () => {
    test("returns entries similar to the given entry and excludes source", async () => {
      const t = initConvexTest(schema);

      const { entryId: sourceId } = await addWithDummyContent(t, {
        key: "source-doc",
        text: "Source document about machine learning",
        namespace: "similar-test",
        title: "Source",
      });
      await addWithDummyContent(t, {
        key: "similar-doc",
        text: "Similar document about ML and neural networks",
        namespace: "similar-test",
        title: "Similar",
      });
      await addWithDummyContent(t, {
        key: "other-doc",
        text: "Unrelated document about cooking recipes",
        namespace: "similar-test",
        title: "Other",
      });

      const { results, entries, text } = await t.action(testApi.searchWithEntryId, {
        entryId: sourceId,
        limit: 10,
      });

      const resultEntryIds = entries.map((e) => e.entryId);
      expect(resultEntryIds).not.toContain(sourceId);
      expect(results.length).toBeGreaterThan(0);
      expect(entries.length).toBeGreaterThan(0);
      expect(text).not.toContain("Source document");
      expect(text).toContain("---");
    });

    test("respects limit", async () => {
      const t = initConvexTest(schema);

      const { entryId: sourceId } = await addWithDummyContent(t, {
        key: "limit-source",
        text: "Limit test source",
        namespace: "limit-similar",
      });
      await addWithDummyContent(t, {
        key: "limit-a",
        text: "First similar",
        namespace: "limit-similar",
      });
      await addWithDummyContent(t, {
        key: "limit-b",
        text: "Second similar",
        namespace: "limit-similar",
      });
      await addWithDummyContent(t, {
        key: "limit-c",
        text: "Third similar",
        namespace: "limit-similar",
      });

      const { results, entries } = await t.action(testApi.searchWithEntryId, {
        entryId: sourceId,
        limit: 2,
      });

      expect(results).toHaveLength(2);
      expect(entries).toHaveLength(2);
    });

    test("returns same shape as search (results, text, entries) without usage", async () => {
      const t = initConvexTest(schema);

      const { entryId } = await addWithDummyContent(t, {
        key: "shape-test",
        text: "Shape test content",
        namespace: "shape-ns",
        title: "Shape Doc",
      });

      const out = await t.action(testApi.searchWithEntryId, {
        entryId,
        limit: 5,
      });

      expect(out).toHaveProperty("results");
      expect(out).toHaveProperty("text");
      expect(out).toHaveProperty("entries");
      expect(Array.isArray(out.results)).toBe(true);
      expect(Array.isArray(out.entries)).toBe(true);
      expect(typeof out.text).toBe("string");
      expect(out).not.toHaveProperty("usage");
    });
  });

  describe("searchSimilar", () => {
    test("returns entries similar to the given key and excludes source", async () => {
      const t = initConvexTest(schema);

      await addWithDummyContent(t, {
        key: "source-doc",
        text: "Source document about machine learning",
        namespace: "similar-key-test",
        title: "Source",
      });
      await addWithDummyContent(t, {
        key: "similar-doc",
        text: "Similar document about ML and neural networks",
        namespace: "similar-key-test",
        title: "Similar",
      });
      await addWithDummyContent(t, {
        key: "other-doc",
        text: "Unrelated document about cooking recipes",
        namespace: "similar-key-test",
        title: "Other",
      });

      const { results, entries, text } = await t.action(testApi.searchSimilar, {
        namespace: "similar-key-test",
        key: "source-doc",
        limit: 10,
      });

      const sourceEntry = entries.find((e) => e.key === "source-doc");
      const resultEntryIds = entries.map((e) => e.entryId);
      if (sourceEntry) {
        expect(resultEntryIds).not.toContain(sourceEntry.entryId);
      }
      expect(results.length).toBeGreaterThan(0);
      expect(entries.length).toBeGreaterThan(0);
      expect(text).not.toContain("Source document");
      expect(text).toContain("---");
    });

    test("returns same shape as searchWithEntryId (results, text, entries) without usage", async () => {
      const t = initConvexTest(schema);

      await addWithDummyContent(t, {
        key: "shape-key-test",
        text: "Shape test content",
        namespace: "shape-key-ns",
        title: "Shape Doc",
      });

      const out = await t.action(testApi.searchSimilar, {
        namespace: "shape-key-ns",
        key: "shape-key-test",
        limit: 5,
      });

      expect(out).toHaveProperty("results");
      expect(out).toHaveProperty("text");
      expect(out).toHaveProperty("entries");
      expect(Array.isArray(out.results)).toBe(true);
      expect(Array.isArray(out.entries)).toBe(true);
      expect(typeof out.text).toBe("string");
      expect(out).not.toHaveProperty("usage");
    });
  });

  describe("addMany, getEntries, deleteMany", () => {
    test("addMany adds multiple entries in one namespace", async () => {
      const t = initConvexTest(schema);
      const result = await t.mutation(testApi.addMany, {
        namespace: "batch-ns",
        items: [
          {
            key: "batch-a",
            title: "Doc A",
            content: {
              content: { text: "First batch doc" },
              embedding: dummyEmbeddings("First batch doc"),
              searchableText: "First batch doc",
            },
          },
          {
            key: "batch-b",
            title: "Doc B",
            content: {
              content: { text: "Second batch doc" },
              embedding: dummyEmbeddings("Second batch doc"),
              searchableText: "Second batch doc",
            },
          },
          {
            key: "batch-c",
            title: "Doc C",
            content: {
              content: { text: "Third batch doc" },
              embedding: dummyEmbeddings("Third batch doc"),
              searchableText: "Third batch doc",
            },
          },
        ],
      });
      expect(result.entryIds).toHaveLength(3);
      expect(result.statuses).toEqual(["ready", "ready", "ready"]);
      expect(result.created).toEqual([true, true, true]);
      await t.run(async (ctx) => {
        const ns = await rag.getNamespace(ctx, { namespace: "batch-ns" });
        expect(ns).not.toBeNull();
        const { page } = await rag.list(ctx, {
          namespaceId: ns!.namespaceId,
          limit: 10,
        });
        expect(page.length).toBe(3);
        const entries = await rag.getEntries(ctx, {
          entryIds: result.entryIds,
        });
        expect(entries).toHaveLength(3);
        expect(entries.every((e) => e !== null)).toBe(true);
      });
    });

    test("addMany with pre-computed content (no embed call)", async () => {
      const t = initConvexTest(schema);
      const result = await t.mutation(testApi.addMany, {
        namespace: "batch-content-ns",
        items: [
          {
            key: "pre-a",
            content: {
              content: { text: "Precomputed A" },
              embedding: dummyEmbeddings("Precomputed A"),
              searchableText: "Precomputed A",
            },
          },
          {
            key: "pre-b",
            content: {
              content: { text: "Precomputed B" },
              embedding: dummyEmbeddings("Precomputed B"),
              searchableText: "Precomputed B",
            },
          },
        ],
      });
      expect(result.entryIds).toHaveLength(2);
      expect(result.statuses).toEqual(["ready", "ready"]);
      expect(result.usage.tokens).toBe(0);
    });

    test("getEntries returns multiple entries and null for missing", async () => {
      const t = initConvexTest(schema);
      const { entryId: id1 } = await addWithDummyContent(t, {
        key: "getMany-one",
        text: "Only one",
        namespace: "getMany-ns",
      });
      const { entryId: id2 } = await addWithDummyContent(t, {
        key: "getMany-two",
        text: "Second",
        namespace: "getMany-ns",
      });
      await t.run(async (ctx) => {
        const entries = await rag.getEntries(ctx, {
          entryIds: [id1, id2],
        });
        expect(entries).toHaveLength(2);
        expect(entries[0]).not.toBeNull();
        expect(entries[1]).not.toBeNull();
        const withMissing = await rag.getEntries(ctx, {
          entryIds: [id1, id2, id1],
        });
        expect(withMissing).toHaveLength(3);
        expect(withMissing[0]).not.toBeNull();
        expect(withMissing[1]).not.toBeNull();
        expect(withMissing[2]).not.toBeNull();
      });
    });

    test("deleteMany removes multiple entries in one mutation", async () => {
      const t = initConvexTest(schema);
      const result = await t.mutation(testApi.addMany, {
        namespace: "delete-many-ns",
        items: [
          {
            key: "del-1",
            content: {
              content: { text: "To delete 1" },
              embedding: dummyEmbeddings("To delete 1"),
              searchableText: "To delete 1",
            },
          },
          {
            key: "del-2",
            content: {
              content: { text: "To delete 2" },
              embedding: dummyEmbeddings("To delete 2"),
              searchableText: "To delete 2",
            },
          },
          {
            key: "del-3",
            content: {
              content: { text: "To delete 3" },
              embedding: dummyEmbeddings("To delete 3"),
              searchableText: "To delete 3",
            },
          },
        ],
      });
      await t.run(async (ctx) => {
        await rag.deleteMany(ctx, { entryIds: result.entryIds });
      });
      await t.run(async (ctx) => {
        const entries = await rag.getEntries(ctx, {
          entryIds: result.entryIds,
        });
        expect(entries.every((e) => e === null)).toBe(true);
      });
    });
  });
});
