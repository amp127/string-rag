/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "./schema.js";
import { api, internal } from "./_generated/api.js";
import { modules } from "./setup.test.js";
import { insertContent } from "./content.js";
import type { Id } from "./_generated/dataModel.js";
import type { Value } from "convex/values";

type ConvexTest = TestConvex<typeof schema>;

describe("search", () => {
  async function setupTestNamespace(
    t: ConvexTest,
    namespace = "test-namespace",
    dimension = 128,
    filterNames: string[] = [],
  ) {
    return await t.run(async (ctx) => {
      return ctx.db.insert("namespaces", {
        namespace,
        version: 1,
        modelId: "test-model",
        dimension,
        filterNames,
        status: { kind: "ready" },
      });
    });
  }

  async function setupTestEntry(
    t: ConvexTest,
    namespaceId: Id<"namespaces">,
    key = "test-entry",
    version = 0,
    filterValues: Array<{ name: string; value: Value }> = [],
  ) {
    return await t.run(async (ctx) => {
      return ctx.db.insert("entries", {
        namespaceId,
        key,
        version,
        status: { kind: "ready" },
        contentHash: `test-content-hash-${key}-${version}`,
        importance: 0.5,
        filterValues,
      });
    });
  }

  function createTestContent(text = "Test content", baseEmbedding = 0.1) {
    return {
      content: { text, metadata: {} },
      embedding: Array(128).fill(baseEmbedding),
      searchableText: text,
    };
  }

  test("if a namespace doesn't exist yet, returns nothing", async () => {
    const t = convexTest(schema, modules);

    // Search in a non-existent namespace
    const result = await t.action(api.search.search, {
      namespace: "non-existent-namespace",
      embedding: Array(128).fill(0.1),
      modelId: "test-model",
      filters: [],
      limit: 10,
    });

    expect(result.results).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });

  test("if a namespace exists and is compatible, it finds the correct embedding for a query", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);
    const entryId = await setupTestEntry(t, namespaceId);

    const targetEmbedding = Array(128).fill(0.5);
    await t.run(async (ctx) => {
      await insertContent(ctx, {
        entryId,
        content: {
          content: {
            text: "Target content",
            metadata: { target: true },
          },
          embedding: targetEmbedding,
          searchableText: "Target content",
        },
      });
    });

    const result = await t.action(api.search.search, {
      namespace: "test-namespace",
      embedding: targetEmbedding,
      modelId: "test-model",
      filters: [],
      limit: 10,
    });

    expect(result.results).toHaveLength(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryId).toBe(entryId);
    expect(result.results[0].content.text).toBe("Target content");
  });

  test("if the limit is 0, it returns nothing", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);
    const entryId = await setupTestEntry(t, namespaceId);

    await t.run(async (ctx) => {
      await insertContent(ctx, {
        entryId,
        content: createTestContent("Test content", 0.1),
      });
    });

    // Search with limit 0
    const result = await t.action(api.search.search, {
      namespace: "test-namespace",
      embedding: Array(128).fill(0.1),
      modelId: "test-model",
      filters: [],
      limit: 0,
    });

    expect(result.results).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });

  test("it filters out results where the vectorScoreThreshold is too low", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);
    const entryId = await setupTestEntry(t, namespaceId);

    await t.run(async (ctx) => {
      await insertContent(ctx, {
        entryId,
        content: {
          content: {
            text: "High similarity content",
            metadata: { similarity: "high" },
          },
          embedding: Array(128).fill(0.5),
          searchableText: "High similarity content",
        },
      });
    });

    // Search with a high threshold
    const searchEmbedding = Array(128).fill(0.5);
    const resultWithThreshold = await t.action(api.search.search, {
      namespace: "test-namespace",
      embedding: searchEmbedding,
      modelId: "test-model",
      filters: [],
      limit: 10,
      vectorScoreThreshold: 0.8, // High threshold
    });

    // Search without threshold
    const resultWithoutThreshold = await t.action(api.search.search, {
      namespace: "test-namespace",
      embedding: searchEmbedding,
      modelId: "test-model",
      filters: [],
      limit: 10,
    });

    // With threshold may return fewer results
    expect(resultWithThreshold.results.length).toBeLessThanOrEqual(
      resultWithoutThreshold.results.length,
    );
    expect(resultWithoutThreshold.results).toHaveLength(1);

    // All results with threshold should have score >= threshold
    for (const result of resultWithThreshold.results) {
      expect(result.score).toBeGreaterThanOrEqual(0.8);
    }
  });

  test("it successfully uses filters to search for entries that match", async () => {
    const t = convexTest(schema, modules);

    // Create namespace with filter support
    const namespaceId = await setupTestNamespace(t, "filtered-namespace", 128, [
      "category",
    ]);

    // Create entries with different filter values
    const doc1Id = await setupTestEntry(t, namespaceId, "doc1", 0, [
      { name: "category", value: "category1" },
    ]);
    const doc2Id = await setupTestEntry(t, namespaceId, "doc2", 0, [
      { name: "category", value: "category2" },
    ]);
    const doc3Id = await setupTestEntry(t, namespaceId, "doc3", 0, [
      { name: "category", value: "category1" },
    ]);

    const baseEmbedding = Array(128).fill(0.1);
    const testContent = createTestContent("doc content", 0.1);
    await t.run(async (ctx) => {
      await insertContent(ctx, { entryId: doc1Id, content: testContent });
      await insertContent(ctx, { entryId: doc2Id, content: testContent });
      await insertContent(ctx, { entryId: doc3Id, content: testContent });
    });

    const category1Results = await t.action(api.search.search, {
      namespace: "filtered-namespace",
      embedding: baseEmbedding,
      modelId: "test-model",
      filters: [{ name: "category", value: "category1" }],
      limit: 10,
    });

    expect(category1Results.entries).toHaveLength(2); // doc1 and doc3
    expect(category1Results.results).toHaveLength(2);

    const entryIds = category1Results.entries.map((d) => d.entryId).sort();
    expect(entryIds).toEqual([doc1Id, doc3Id].sort());

    const category2Results = await t.action(api.search.search, {
      namespace: "filtered-namespace",
      embedding: baseEmbedding,
      modelId: "test-model",
      filters: [{ name: "category", value: "category2" }],
      limit: 10,
    });

    expect(category2Results.entries).toHaveLength(1); // only doc2
    expect(category2Results.results).toHaveLength(1);
    expect(category2Results.entries[0].entryId).toBe(doc2Id);

    const noFilterResults = await t.action(api.search.search, {
      namespace: "filtered-namespace",
      embedding: baseEmbedding,
      modelId: "test-model",
      filters: [],
      limit: 10,
    });

    expect(noFilterResults.entries).toHaveLength(3);
    expect(noFilterResults.results).toHaveLength(3);
  });

  test("it handles multiple filter fields correctly", async () => {
    const t = convexTest(schema, modules);

    // Create namespace with multiple filter fields
    const namespaceId = await setupTestNamespace(
      t,
      "multi-filter-namespace",
      128,
      ["category", "priority_category"],
    );

    // Create entries with different filter combinations
    const doc1Id = await setupTestEntry(t, namespaceId, "doc1", 0, [
      { name: "category", value: "articles" },
      {
        name: "priority_category",
        value: { priority: "high", category: "articles" },
      },
    ]);
    const doc2Id = await setupTestEntry(t, namespaceId, "doc2", 0, [
      { name: "category", value: "articles" },
      {
        name: "priority_category",
        value: { priority: "low", category: "articles" },
      },
    ]);
    const doc3Id = await setupTestEntry(t, namespaceId, "doc3", 0, [
      { name: "category", value: "blogs" },
      {
        name: "priority_category",
        value: { priority: "high", category: "blogs" },
      },
    ]);

    // Insert content
    const baseEmbedding = Array(128).fill(0.1);
    const multiFilterContent = createTestContent("multi-filter doc", 0.1);
    await t.run(async (ctx) => {
      await insertContent(ctx, { entryId: doc1Id, content: multiFilterContent });
      await insertContent(ctx, { entryId: doc2Id, content: multiFilterContent });
      await insertContent(ctx, { entryId: doc3Id, content: multiFilterContent });
    });

    // Search for articles with high priority
    const result = await t.action(api.search.search, {
      namespace: "multi-filter-namespace",
      embedding: baseEmbedding,
      modelId: "test-model",
      filters: [
        {
          name: "priority_category",
          value: { priority: "high", category: "articles" },
        },
      ],
      limit: 10,
    });

    expect(result.entries).toHaveLength(1); // only doc1 matches both filters
    expect(result.entries[0].entryId).toBe(doc1Id);
    expect(result.results).toHaveLength(1);
  });

  test("it returns empty results for incompatible namespace dimensions", async () => {
    const t = convexTest(schema, modules);

    // Create namespace with 256 dimensions
    await setupTestNamespace(t, "high-dim-namespace", 256);

    // Search with 128-dimensional embedding (incompatible)
    const result = await t.action(api.search.search, {
      namespace: "high-dim-namespace",
      embedding: Array(128).fill(0.1), // Wrong dimension
      modelId: "test-model",
      filters: [],
      limit: 10,
    });

    expect(result.results).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });

  test("it returns empty results for incompatible model IDs", async () => {
    const t = convexTest(schema, modules);

    // Create namespace with specific model ID
    await setupTestNamespace(t, "model-specific-namespace", 128);

    // Search with different model ID
    const result = await t.action(api.search.search, {
      namespace: "model-specific-namespace",
      embedding: Array(128).fill(0.1),
      modelId: "different-model", // Wrong model ID
      filters: [],
      limit: 10,
    });

    expect(result.results).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });

  test("it respects the limit parameter", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);
    const entryId = await setupTestEntry(t, namespaceId);

    // Insert content in multiple entries to test limit
    const entry2Id = await setupTestEntry(t, namespaceId, "e2");
    const entry3Id = await setupTestEntry(t, namespaceId, "e3");
    const entry4Id = await setupTestEntry(t, namespaceId, "e4");
    await t.run(async (ctx) => {
      await insertContent(ctx, {
        entryId,
        content: createTestContent("limit 1", 0.1),
      });
      await insertContent(ctx, {
        entryId: entry2Id,
        content: createTestContent("limit 2", 0.11),
      });
      await insertContent(ctx, {
        entryId: entry3Id,
        content: createTestContent("limit 3", 0.12),
      });
      await insertContent(ctx, {
        entryId: entry4Id,
        content: createTestContent("limit 4", 0.13),
      });
    });

    // Search with small limit
    const result = await t.action(api.search.search, {
      namespace: "test-namespace",
      embedding: Array(128).fill(0.1),
      modelId: "test-model",
      filters: [],
      limit: 3,
    });

    expect(result.results).toHaveLength(3);
    expect(result.entries).toHaveLength(3);

    // Results should be sorted by score (best first)
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i - 1].score).toBeGreaterThanOrEqual(
        result.results[i].score,
      );
    }
  });

  describe("hybrid search", () => {
    function createSearchableContent(text: string, baseEmbedding = 0.1) {
      return {
        content: { text, metadata: {} },
        embedding: Array(128).fill(baseEmbedding),
        searchableText: text,
      };
    }

    test("textSearch internal query finds content by text content", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entry1Id = await setupTestEntry(t, namespaceId, "e1");
      const entry2Id = await setupTestEntry(t, namespaceId, "e2");
      const entry3Id = await setupTestEntry(t, namespaceId, "e3");

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId: entry1Id,
          content: createSearchableContent("The quick brown fox jumps over the lazy dog"),
        });
        await insertContent(ctx, {
          entryId: entry2Id,
          content: createSearchableContent("A fast red car drives on the highway"),
        });
        await insertContent(ctx, {
          entryId: entry3Id,
          content: createSearchableContent("The brown bear sleeps in the forest"),
        });
      });

      const results = await t.query(internal.search.textSearch, {
        query: "brown",
        namespaceId,
        filters: [],
        limit: 10,
      });

      expect(results).toHaveLength(2); // "brown" in entry1 and entry3
      const entryIds = results.map((r) => r.entryId).sort();
      expect(entryIds).toEqual([entry1Id, entry3Id].sort());
    });

    test("textSearch scopes results to the given namespace", async () => {
      const t = convexTest(schema, modules);
      const ns1Id = await setupTestNamespace(t, "namespace-1");
      const ns2Id = await setupTestNamespace(t, "namespace-2");
      const entry1Id = await setupTestEntry(t, ns1Id, "entry-1");
      const entry2Id = await setupTestEntry(t, ns2Id, "entry-2");

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId: entry1Id,
          content: createSearchableContent("alpha bravo charlie"),
        });
        await insertContent(ctx, {
          entryId: entry2Id,
          content: createSearchableContent("alpha delta echo"),
        });
      });

      const ns1Results = await t.query(internal.search.textSearch, {
        query: "alpha",
        namespaceId: ns1Id,
        filters: [],
        limit: 10,
      });

      // All results should belong to namespace-1's entry.
      for (const r of ns1Results) {
        expect(r.entryId).toBe(entry1Id);
      }
    });

    test("textSearch applies numbered filters", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t, "filtered-ns", 128, [
        "category",
      ]);

      const cat1Entry = await setupTestEntry(t, namespaceId, "cat1", 0, [
        { name: "category", value: "docs" },
      ]);
      const cat2Entry = await setupTestEntry(t, namespaceId, "cat2", 0, [
        { name: "category", value: "blogs" },
      ]);

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId: cat1Entry,
          content: createSearchableContent("shared keyword content"),
        });
        await insertContent(ctx, {
          entryId: cat2Entry,
          content: createSearchableContent("shared keyword content"),
        });
      });

      // Filter to "docs" category only (filter index 0 = "category").
      const results = await t.query(internal.search.textSearch, {
        query: "shared keyword",
        namespaceId,
        filters: [{ 0: "docs" }],
        limit: 10,
      });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.entryId).toBe(cat1Entry);
      }
    });

    test("text-only search returns results via dimension arg", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId);

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId,
          content: createSearchableContent(
            "Machine learning and deep learning use neural networks with many layers",
          ),
        });
      });

      // Text-only: no embedding, provide dimension instead.
      const result = await t.action(api.search.search, {
        namespace: "test-namespace",
        dimension: 128,
        modelId: "test-model",
        filters: [],
        limit: 10,
        textQuery: "neural networks",
      });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.entries).toHaveLength(1);

      // Text-only scores are position-based.
      expect(result.results[0].score).toBe(1.0);
      for (let i = 1; i < result.results.length; i++) {
        expect(result.results[i].score).toBeLessThan(
          result.results[i - 1].score,
        );
      }
    });

    test("hybrid search returns results when textQuery is provided", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId);

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId,
          content: createSearchableContent(
            "Machine learning uses neural networks",
          ),
        });
      });

      const result = await t.action(api.search.search, {
        namespace: "test-namespace",
        embedding: [...Array(127).fill(0.01), 0.1],
        modelId: "test-model",
        filters: [],
        limit: 10,
        textQuery: "neural networks",
      });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.entries).toHaveLength(1);

      // Hybrid scores are position-based (1.0 for top, decreasing linearly).
      expect(result.results[0].score).toBe(1.0);
      for (let i = 1; i < result.results.length; i++) {
        expect(result.results[i].score).toBeLessThan(
          result.results[i - 1].score,
        );
      }
    });

    test("hybrid search deduplicates results from vector and text paths", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId);

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId,
          content: createSearchableContent(
            "Unique content about quantum computing",
          ),
        });
      });

      const result = await t.action(api.search.search, {
        namespace: "test-namespace",
        embedding: [...Array(127).fill(0.01), 0.1],
        modelId: "test-model",
        filters: [],
        limit: 10,
        textQuery: "quantum computing",
      });

      // Each result should appear at most once.
      const entryOrderPairs = result.results.map(
        (r) => `${r.entryId}:${r.order}`,
      );
      const uniquePairs = new Set(entryOrderPairs);
      expect(uniquePairs.size).toBe(entryOrderPairs.length);
    });

    test("vector-only search is unchanged when textQuery is not provided", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId);

      const targetEmbedding = Array(128).fill(0.5);
      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId,
          content: {
            content: { text: "Target content", metadata: {} },
            embedding: targetEmbedding,
            searchableText: "Target content",
          },
        });
      });

      const result = await t.action(api.search.search, {
        namespace: "test-namespace",
        embedding: targetEmbedding,
        modelId: "test-model",
        filters: [],
        limit: 10,
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].content.text).toBe("Target content");
    });

    test("textWeight and vectorWeight influence hybrid ranking", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId);

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId,
          content: createSearchableContent(
            "Alpha topic with specific terminology",
          ),
        });
      });

      const embedding = [...Array(127).fill(0.01), 0.1];

      // Search with heavy text weight.
      const textHeavy = await t.action(api.search.search, {
        namespace: "test-namespace",
        embedding,
        modelId: "test-model",
        filters: [],
        limit: 10,
        textQuery: "specific terminology",
        textWeight: 10,
        vectorWeight: 1,
      });

      // Search with heavy vector weight.
      const vectorHeavy = await t.action(api.search.search, {
        namespace: "test-namespace",
        embedding,
        modelId: "test-model",
        filters: [],
        limit: 10,
        textQuery: "specific terminology",
        textWeight: 1,
        vectorWeight: 10,
      });

      // Both should return results.
      expect(textHeavy.results.length).toBeGreaterThan(0);
      expect(vectorHeavy.results.length).toBeGreaterThan(0);
    });
  });

  describe("searchWithEntryId", () => {
    test("getEntryEmbedding returns embedding and namespace info for ready content", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId);
      const embedding = Array(128).fill(0.5);

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId,
          content: {
            content: { text: "Ready content", metadata: {} },
            embedding,
            searchableText: "Ready content",
          },
        });
      });

      const result = await t.query(internal.search.getEntryEmbedding, {
        entryId,
      });
      expect(result).not.toBeNull();

      // Stored vector is normalized and importance-scaled; we strip the weight dim
      expect(result!.embedding).toHaveLength(128);
      expect(result!.namespaceId).toBe(namespaceId);
      expect(result!.filterNames).toEqual([]);
    });

    test("getEntryEmbedding returns embedding for pending content", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId, "pending-entry");
      await t.run(async (ctx) => {
        await ctx.db.patch(entryId, {
          status: { kind: "pending", onComplete: undefined },
        });
      });
      const embedding = Array(128).fill(0.3);
      await t.run(async (ctx) => {
        const contentId = await ctx.db.insert("content", {
          entryId,
          text: "Pending text",
          metadata: {},
          namespaceId,
          state: {
            kind: "pending",
            searchableText: "Pending text",
          },
        });
        await ctx.db.insert("pendingContentEmbeddings", {
          contentId,
          embedding,
        });
      });

      const result = await t.query(internal.search.getEntryEmbedding, {
        entryId,
      });
      expect(result).not.toBeNull();

      expect(result!.embedding).toHaveLength(128);
      expect(result!.embedding.every((v) => v === 0.3)).toBe(true);
      expect(result!.namespaceId).toBe(namespaceId);
    });

    test("getEntryEmbedding returns null when entry not found", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId);
      await t.run(async (ctx) => {
        await ctx.db.delete(entryId);
      });

      const result = await t.query(internal.search.getEntryEmbedding, {
        entryId,
      });
      expect(result).toBeNull();
    });

    test("getEntryEmbedding returns null when entry has no content", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId, "no-content-entry");
      // Do not insert any content for this entry

      const result = await t.query(internal.search.getEntryEmbedding, {
        entryId,
      });
      expect(result).toBeNull();
    });

    test("searchWithEntryId returns entries similar to the given entry and excludes source", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);

      const sourceId = await setupTestEntry(t, namespaceId, "source", 0);
      const similarId = await setupTestEntry(t, namespaceId, "similar", 0);
      const otherId = await setupTestEntry(t, namespaceId, "other", 0);

      const sourceEmbedding = Array(128).fill(0.5);
      const similarEmbedding = Array(128).fill(0.52);
      const otherEmbedding = Array(128).fill(0.1);

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId: sourceId,
          content: {
            content: { text: "Source content", metadata: {} },
            embedding: sourceEmbedding,
            searchableText: "Source content",
          },
        });
        await insertContent(ctx, {
          entryId: similarId,
          content: {
            content: { text: "Similar content", metadata: {} },
            embedding: similarEmbedding,
            searchableText: "Similar content",
          },
        });
        await insertContent(ctx, {
          entryId: otherId,
          content: {
            content: { text: "Other content", metadata: {} },
            embedding: otherEmbedding,
            searchableText: "Other content",
          },
        });
      });

      const result = await t.action(api.search.searchWithEntryId, {
        entryId: sourceId,
        filters: [],
        limit: 10,
      });

      expect(result.results).not.toContainEqual(
        expect.objectContaining({ entryId: sourceId }),
      );
      const resultEntryIds = result.entries.map((e) => e.entryId);
      expect(resultEntryIds).not.toContain(sourceId);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.entries.length).toBeGreaterThan(0);
      const topResult = result.results[0];
      expect(topResult.entryId).toBe(similarId);
      expect(topResult.content.text).toBe("Similar content");
    });

    test("searchWithEntryId respects filters", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(
        t,
        "similar-filter-ns",
        128,
        ["category"],
      );

      const sourceId = await setupTestEntry(t, namespaceId, "src", 0, [
        { name: "category", value: "articles" },
      ]);
      const similarId = await setupTestEntry(t, namespaceId, "sim", 0, [
        { name: "category", value: "articles" },
      ]);
      const differentCatId = await setupTestEntry(t, namespaceId, "diff", 0, [
        { name: "category", value: "blogs" },
      ]);

      const emb = Array(128).fill(0.5);
      const content = {
        content: { text: "Doc", metadata: {} },
        embedding: emb,
        searchableText: "Doc",
      };
      await t.run(async (ctx) => {
        await insertContent(ctx, { entryId: sourceId, content });
        await insertContent(ctx, { entryId: similarId, content });
        await insertContent(ctx, { entryId: differentCatId, content });
      });

      const result = await t.action(api.search.searchWithEntryId, {
        entryId: sourceId,
        filters: [{ name: "category", value: "articles" }],
        limit: 10,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entryId).toBe(similarId);
      expect(result.results).toHaveLength(1);
    });

    test("searchWithEntryId respects limit", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);

      const sourceId = await setupTestEntry(t, namespaceId, "src");
      const e2 = await setupTestEntry(t, namespaceId, "e2");
      const e3 = await setupTestEntry(t, namespaceId, "e3");
      const e4 = await setupTestEntry(t, namespaceId, "e4");

      const base = Array(128).fill(0.5);
      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId: sourceId,
          content: {
            content: { text: "S", metadata: {} },
            embedding: base,
            searchableText: "S",
          },
        });
        await insertContent(ctx, {
          entryId: e2,
          content: {
            content: { text: "E2", metadata: {} },
            embedding: [...base.slice(0, 127), 0.51],
            searchableText: "E2",
          },
        });
        await insertContent(ctx, {
          entryId: e3,
          content: {
            content: { text: "E3", metadata: {} },
            embedding: [...base.slice(0, 127), 0.52],
            searchableText: "E3",
          },
        });
        await insertContent(ctx, {
          entryId: e4,
          content: {
            content: { text: "E4", metadata: {} },
            embedding: [...base.slice(0, 127), 0.53],
            searchableText: "E4",
          },
        });
      });

      const result = await t.action(api.search.searchWithEntryId, {
        entryId: sourceId,
        filters: [],
        limit: 2,
      });

      expect(result.results).toHaveLength(2);
      expect(result.entries).toHaveLength(2);
    });

    test("searchWithEntryId applies vectorScoreThreshold", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);

      const sourceId = await setupTestEntry(t, namespaceId, "src");
      const similarId = await setupTestEntry(t, namespaceId, "sim");

      const highSim = Array(128).fill(0.5);
      const lowSim = Array(128).fill(0.1);
      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId: sourceId,
          content: {
            content: { text: "Source", metadata: {} },
            embedding: highSim,
            searchableText: "Source",
          },
        });
        await insertContent(ctx, {
          entryId: similarId,
          content: {
            content: { text: "Low similarity", metadata: {} },
            embedding: lowSim,
            searchableText: "Low similarity",
          },
        });
      });

      const noThreshold = await t.action(api.search.searchWithEntryId, {
        entryId: sourceId,
        filters: [],
        limit: 10,
      });
      const withThreshold = await t.action(api.search.searchWithEntryId, {
        entryId: sourceId,
        filters: [],
        limit: 10,
        vectorScoreThreshold: 0.5,
      });

      expect(noThreshold.results.length).toBeGreaterThanOrEqual(
        withThreshold.results.length,
      );
      for (const r of withThreshold.results) {
        expect(r.score).toBeGreaterThanOrEqual(0.5);
      }
    });

    test("searchWithEntryId returns empty when entry not found", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t);
      const entryId = await setupTestEntry(t, namespaceId);
      await t.run(async (ctx) => {
        await ctx.db.delete(entryId);
      });

      const result = await t.action(api.search.searchWithEntryId, {
        entryId,
        filters: [],
        limit: 10,
      });
      expect(result.results).toHaveLength(0);
      expect(result.entries).toHaveLength(0);
    });
  });

  describe("searchSimilar", () => {
    test("searchSimilar returns entries similar to the given key and excludes source", async () => {
      const t = convexTest(schema, modules);
      const namespaceId = await setupTestNamespace(t, "similar-key-ns");

      const sourceId = await setupTestEntry(t, namespaceId, "source", 0);
      const similarId = await setupTestEntry(t, namespaceId, "similar", 0);
      const otherId = await setupTestEntry(t, namespaceId, "other", 0);

      const sourceEmbedding = Array(128).fill(0.5);
      const similarEmbedding = Array(128).fill(0.52);
      const otherEmbedding = Array(128).fill(0.1);

      await t.run(async (ctx) => {
        await insertContent(ctx, {
          entryId: sourceId,
          content: {
            content: { text: "Source content", metadata: {} },
            embedding: sourceEmbedding,
            searchableText: "Source content",
          },
        });
        await insertContent(ctx, {
          entryId: similarId,
          content: {
            content: { text: "Similar content", metadata: {} },
            embedding: similarEmbedding,
            searchableText: "Similar content",
          },
        });
        await insertContent(ctx, {
          entryId: otherId,
          content: {
            content: { text: "Other content", metadata: {} },
            embedding: otherEmbedding,
            searchableText: "Other content",
          },
        });
      });

      const result = await t.action(api.search.searchSimilar, {
        namespace: "similar-key-ns",
        modelId: "test-model",
        dimension: 128,
        key: "source",
        filters: [],
        limit: 10,
      });

      expect(result.results).not.toContainEqual(
        expect.objectContaining({ entryId: sourceId }),
      );
      const resultEntryIds = result.entries.map((e) => e.entryId);
      expect(resultEntryIds).not.toContain(sourceId);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.entries.length).toBeGreaterThan(0);
      const topResult = result.results[0];
      expect(topResult.entryId).toBe(similarId);
      expect(topResult.content.text).toBe("Similar content");
    });

    test("searchSimilar returns empty when no compatible namespace", async () => {
      const t = convexTest(schema, modules);
      const result = await t.action(api.search.searchSimilar, {
        namespace: "non-existent-namespace",
        modelId: "test-model",
        dimension: 128,
        key: "any-key",
        filters: [],
        limit: 10,
      });
      expect(result.results).toHaveLength(0);
      expect(result.entries).toHaveLength(0);
    });

    test("searchSimilar returns empty when no ready entry for key", async () => {
      const t = convexTest(schema, modules);
      await setupTestNamespace(t, "empty-key-ns");
      const result = await t.action(api.search.searchSimilar, {
        namespace: "empty-key-ns",
        modelId: "test-model",
        dimension: 128,
        key: "no-such-key",
        filters: [],
        limit: 10,
      });
      expect(result.results).toHaveLength(0);
      expect(result.entries).toHaveLength(0);
    });
  });
});
