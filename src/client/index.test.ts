import { describe, expect, test } from "vitest";
import { StringRAG, type EntryId } from "./index.js";
import type { DataModelFromSchemaDefinition } from "convex/server";
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
    if (args.content) {
      return rag.add(ctx, { ...args, content: args.content });
    }
    return rag.add(ctx, { ...args, text: args.text ?? "" });
  },
});

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

export const searchSimilar = action({
  args: {
    entryId: v.string(),
    limit: v.optional(v.number()),
    vectorScoreThreshold: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return rag.searchSimilar(ctx, {
      entryId: args.entryId as EntryId,
      limit: args.limit ?? 10,
      vectorScoreThreshold: args.vectorScoreThreshold,
    });
  },
});

const testApi: ApiFromModules<{
  fns: {
    findEntryByContentHash: typeof findEntryByContentHash;
    add: typeof add;
    search: typeof search;
    searchSimilar: typeof searchSimilar;
  };
}>["fns"] = anyApi["index.test"] as any;

function dummyEmbeddings(text: string) {
  return Array.from({ length: 1536 }, (_, i) =>
    i === 0 ? text.charCodeAt(0) / 256 : 0.1,
  );
}

function addWithDummyContent(
  t: { mutation: (fn: unknown, args: unknown) => Promise<unknown> },
  args: {
    key: string;
    text: string;
    namespace: string;
    title?: string;
    contentHash?: string;
  },
) {
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
  });
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
        text: "Important chunk content",
        namespace: "ellipsis-test",
        title: "Document",
      });

      const { text, entries } = await t.action(testApi.search, {
        embedding: dummyEmbeddings("Important chunk"),
        namespace: "ellipsis-test",
        limit: 2,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("Important chunk content");
      expect(text).toContain("Important chunk content");
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
        text: "Chunk 1 contents",
        namespace: "readme-format-test",
        title: "Title 1",
      });

      await addWithDummyContent(t, {
        key: "title2-doc",
        text: "Chunk 3 contents",
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

Chunk 1 contents

---

## Title 2:

Chunk 3 contents`,
      );
    });
  });

  describe("searchSimilar", () => {
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

      const { results, entries, text } = await t.action(testApi.searchSimilar, {
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

      const { results, entries } = await t.action(testApi.searchSimilar, {
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

      const out = await t.action(testApi.searchSimilar, {
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
});
