/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type TestConvex } from "convex-test";
import schema from "./schema.js";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import type { Id } from "./_generated/dataModel.js";

type ConvexTest = TestConvex<typeof schema>;

describe("entries", () => {
  async function setupTestNamespace(t: ConvexTest, filterNames: string[] = []) {
    const namespace = await t.mutation(api.namespaces.getOrCreate, {
      namespace: "test-namespace",
      status: "ready",
      modelId: "test-model",
      dimension: 128,
      filterNames,
    });
    return namespace.namespaceId;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function testEntryArgs(namespaceId: Id<"namespaces">, key = "test-entry") {
    return {
      namespaceId,
      key,
      importance: 0.5,
      filterValues: [],
      contentHash: "hash123",
      title: "Test Entry",
    };
  }

  function testContentArgs(text = "Test content") {
    return {
      content: { text, metadata: {} as Record<string, unknown> },
      embedding: Array.from({ length: 128 }, () => 0.1),
      searchableText: text,
    };
  }

  test("add creates a new entry when none exists", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    const result = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });

    expect(result.created).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.entryId).toBeDefined();

    // Verify the entry was actually created
    const createdDoc = await t.run(async (ctx) => {
      return ctx.db.get(result.entryId);
    });

    expect(createdDoc).toBeDefined();
    expect(createdDoc!.key).toBe(entry.key);
    expect(createdDoc!.version).toBe(0);
    expect(createdDoc!.status.kind).toBe("ready");
  });

  test("add returns existing entry when adding identical content", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    // First add
    const firstResult = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });

    expect(firstResult.created).toBe(true);
    expect(firstResult.status).toBe("ready");

    // Second add with identical content
    const secondResult = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });

    expect(secondResult.created).toBe(false);
    expect(secondResult.status).toBe("ready");
    expect(secondResult.entryId).toBe(firstResult.entryId);

    // Verify no new entry was created
    const allDocs = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) =>
          q.and(
            q.eq(q.field("namespaceId"), namespaceId),
            q.eq(q.field("key"), entry.key),
          ),
        )
        .collect();
    });

    expect(allDocs).toHaveLength(1);
    expect(allDocs[0]._id).toBe(firstResult.entryId);
  });

  test("add creates new version when content hash changes", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    // First add
    const firstResult = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });

    expect(firstResult.created).toBe(true);

    // Second add with different content hash
    const modifiedEntry = {
      ...entry,
      contentHash: "hash456", // Different hash
    };

    const secondResult = await t.mutation(api.entries.add, {
      entry: modifiedEntry,
    });

    expect(secondResult.created).toBe(true);
    expect(secondResult.entryId).not.toBe(firstResult.entryId);
    expect(secondResult.status).toBe("pending");

    // Verify both entries exist with different versions
    const allDocs = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) =>
          q.and(
            q.eq(q.field("namespaceId"), namespaceId),
            q.eq(q.field("key"), entry.key),
          ),
        )
        .collect();
    });

    expect(allDocs).toHaveLength(2);

    const versions = allDocs.map((entry) => entry.version).sort();
    expect(versions).toEqual([0, 1]);
  });

  test("add creates new version when importance changes", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    // First add
    const firstResult = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });
    expect(firstResult.status).toBe("ready");
    const first = await t.run(async (ctx) => {
      return ctx.db.get(firstResult.entryId);
    })!;
    expect(first?.version).toBe(0);
    expect(first?.status.kind).toBe("ready");

    // Second add with different importance
    const modifiedEntry = {
      ...entry,
      importance: 0.8, // Changed from 0.5
    };

    const secondResult = await t.mutation(api.entries.add, {
      entry: modifiedEntry,
    });

    expect(secondResult.created).toBe(true);
    expect(secondResult.entryId).not.toBe(firstResult.entryId);
    const second = await t.run(async (ctx) => {
      return ctx.db.get(secondResult.entryId);
    })!;
    expect(second?.version).toBe(1);
    expect(second?.status.kind).toBe("pending");
    expect(secondResult.status).toBe("pending");

    // Verify new version was created
    const newDoc = await t.run(async (ctx) => {
      return ctx.db.get(secondResult.entryId);
    });

    expect(newDoc!.version).toBe(1);
    expect(newDoc!.importance).toBe(0.8);
  });

  test("add creates new version when filter values change", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t, ["category"]); // Add filter name

    const entry = testEntryArgs(namespaceId);

    // First add
    const firstResult = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });
    expect(firstResult.status).toBe("ready");

    // Second add with different filter values
    const modifiedEntry = {
      ...entry,
      filterValues: [{ name: "category", value: "test" }],
    };

    const secondResult = await t.mutation(api.entries.add, {
      entry: modifiedEntry,
    });

    expect(secondResult.created).toBe(true);
    expect(secondResult.entryId).not.toBe(firstResult.entryId);
    expect(secondResult.status).toBe("pending");

    // Verify new version was created with correct filter values
    const newDoc = await t.run(async (ctx) => {
      return ctx.db.get(secondResult.entryId);
    });

    expect(newDoc!.version).toBe(1);
    expect(newDoc!.filterValues).toHaveLength(1);
    expect(newDoc!.filterValues[0].name).toBe("category");
    expect(newDoc!.filterValues[0].value).toBe("test");
  });

  test("add without content creates pending entry", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    const result = await t.mutation(api.entries.add, {
      entry,
      // No content provided
    });

    expect(result.created).toBe(true);
    expect(result.status).toBe("pending");

    // Verify the entry was created with pending status
    const createdDoc = await t.run(async (ctx) => {
      return ctx.db.get(result.entryId);
    });

    expect(createdDoc!.status.kind).toBe("pending");
  });

  test("multiple entries with different keys can coexist", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry1 = testEntryArgs(namespaceId, "doc1");
    const entry2 = testEntryArgs(namespaceId, "doc2");

    const result1 = await t.mutation(api.entries.add, {
      entry: entry1,
      content: testContentArgs("content 1"),
    });

    const result2 = await t.mutation(api.entries.add, {
      entry: entry2,
      content: testContentArgs("content 2"),
    });

    expect(result1.created).toBe(true);
    expect(result2.created).toBe(true);
    expect(result1.entryId).not.toBe(result2.entryId);
    expect(result1.status).toBe("ready");
    expect(result2.status).toBe("ready");

    // Verify both entries exist
    const allDocs = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) => q.eq(q.field("namespaceId"), namespaceId))
        .collect();
    });

    expect(allDocs).toHaveLength(2);
    const keys = allDocs.map((entry) => entry.key).sort();
    expect(keys).toEqual(["doc1", "doc2"]);
  });

  test("pending to ready transition populates replacedEntry", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    // First add - create as ready
    const firstResult = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });

    expect(firstResult.created).toBe(true);
    expect(firstResult.status).toBe("ready");

    // Second add - create as pending (no content)
    const modifiedEntry = {
      ...entry,
      contentHash: "hash456",
    };

    const pendingResult = await t.mutation(api.entries.add, {
      entry: modifiedEntry,
    });

    expect(pendingResult.created).toBe(true);
    expect(pendingResult.status).toBe("pending");

    // Insert content for the pending entry, then replace and promote
    await t.mutation(api.content.insert, {
      entryId: pendingResult.entryId,
      content: {
        content: { text: "Pending entry content" },
        embedding: Array.from({ length: 128 }, () => 0.5),
        searchableText: "Pending entry content",
      },
    });

    const replaceResult = await t.mutation(api.content.replaceContent, {
      entryId: pendingResult.entryId,
    });
    expect(replaceResult.status).toBe("ready");

    // Promote to ready - this should replace the first entry
    const promoteResult = await t.mutation(api.entries.promoteToReady, {
      entryId: pendingResult.entryId,
    });

    expect(promoteResult.replacedEntry).not.toBeNull();
    expect(promoteResult.replacedEntry!.entryId).toBe(firstResult.entryId);

    // Verify the first entry is now replaced
    const firstDoc = await t.run(async (ctx) => {
      return ctx.db.get(firstResult.entryId);
    });
    expect(firstDoc!.status.kind).toBe("replaced");
  });

  test("cleanupReplacedEntriesAsync removes replaced entries via workpool", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    const firstResult = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });
    expect(firstResult.status).toBe("ready");

    const modifiedEntry = { ...entry, contentHash: "hash456" };
    const pendingResult = await t.mutation(api.entries.add, {
      entry: modifiedEntry,
    });
    expect(pendingResult.status).toBe("pending");

    await t.mutation(api.content.insert, {
      entryId: pendingResult.entryId,
      content: {
        content: { text: "Pending entry content" },
        embedding: Array.from({ length: 128 }, () => 0.5),
        searchableText: "Pending entry content",
      },
    });
    await t.mutation(api.content.replaceContent, {
      entryId: pendingResult.entryId,
    });
    await t.mutation(api.entries.promoteToReady, {
      entryId: pendingResult.entryId,
    });

    const replacedDoc = await t.run(async (ctx) => {
      return ctx.db.get(firstResult.entryId);
    });
    expect(replacedDoc!.status.kind).toBe("replaced");

    await t.mutation(api.entries.cleanupReplacedEntriesAsync, {
      namespaceId,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const afterCleanup = await t.run(async (ctx) => {
      return ctx.db.get(firstResult.entryId);
    });
    expect(afterCleanup).toBeNull();
  });

  test("deleteAsync deletes entry and content", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    const testContent = {
      content: { text: "async content", metadata: { type: "text" } },
      embedding: Array.from({ length: 128 }, () => Math.random()),
      searchableText: "async content",
    };

    const result = await t.mutation(api.entries.add, {
      entry,
      content: testContent,
    });

    expect(result.created).toBe(true);
    expect(result.status).toBe("ready");

    const entryBefore = await t.run(async (ctx) => {
      return ctx.db.get(result.entryId);
    });
    expect(entryBefore).toBeDefined();

    const contentBefore = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", result.entryId))
        .collect();
    });
    expect(contentBefore).toHaveLength(1);

    await t.mutation(api.entries.deleteAsync, {
      entryId: result.entryId,
    });

    await t.finishInProgressScheduledFunctions();

    const entryAfter = await t.run(async (ctx) => {
      return ctx.db.get(result.entryId);
    });
    expect(entryAfter).toBeNull();

    const contentAfter = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", result.entryId))
        .collect();
    });
    expect(contentAfter).toHaveLength(0);
  });

  test("deleteSync deletes entry and content synchronously", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId);

    const testContent = {
      content: { text: "sync content", metadata: { type: "text" } },
      embedding: Array.from({ length: 128 }, () => Math.random()),
      searchableText: "sync content",
    };

    const result = await t.mutation(api.entries.add, {
      entry,
      content: testContent,
    });

    expect(result.created).toBe(true);
    expect(result.status).toBe("ready");

    const entryBefore = await t.run(async (ctx) => {
      return ctx.db.get(result.entryId);
    });
    expect(entryBefore).toBeDefined();

    const contentBefore = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", result.entryId))
        .collect();
    });
    expect(contentBefore).toHaveLength(1);

    await t.action(api.entries.deleteSync, {
      entryId: result.entryId,
    });

    const entryAfter = await t.run(async (ctx) => {
      return ctx.db.get(result.entryId);
    });
    expect(entryAfter).toBeNull();

    const contentAfter = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", result.entryId))
        .collect();
    });
    expect(contentAfter).toHaveLength(0);
  });

  test("deleteByKeyAsync deletes all entries with the given key", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry1 = testEntryArgs(namespaceId, "shared-key");
    const entry2 = {
      ...testEntryArgs(namespaceId, "shared-key"),
      contentHash: "hash456",
    };
    const entry3 = testEntryArgs(namespaceId, "different-key");

    // Create multiple entries with same key and one with different key
    const result1 = await t.mutation(api.entries.add, {
      entry: entry1,
      content: {
        content: { text: "content 1" },
        embedding: Array.from({ length: 128 }, () => Math.random()),
      },
    });
    expect(result1.status).toBe("ready");

    const result2 = await t.mutation(api.entries.add, {
      entry: entry2,
      content: {
        content: { text: "content 2" },
        embedding: Array.from({ length: 128 }, () => Math.random()),
      },
    });
    expect(result2.status).toBe("pending");

    const result3 = await t.mutation(api.entries.add, {
      entry: entry3,
      content: {
        content: { text: "content 3" },
        embedding: Array.from({ length: 128 }, () => Math.random()),
      },
    });
    expect(result3.status).toBe("ready");

    // Verify all entries exist
    const entriesBefore = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) => q.eq(q.field("namespaceId"), namespaceId))
        .collect();
    });
    expect(entriesBefore).toHaveLength(3);
    const sharedBefore = await t.query(
      internal.entries.getEntriesForNamespaceByKey,
      {
        namespaceId,
        key: "shared-key",
      },
    );
    expect(sharedBefore).toHaveLength(2);

    // Delete entries by key
    await t.mutation(api.entries.deleteByKeyAsync, {
      namespaceId,
      key: "shared-key",
    });

    // Wait for async deletion to complete
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Verify only entries with "shared-key" are deleted
    const entriesAfter = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) => q.eq(q.field("namespaceId"), namespaceId))
        .collect();
    });
    expect(entriesAfter).toHaveLength(1);
    expect(entriesAfter[0].key).toBe("different-key");
    expect(entriesAfter[0]._id).toBe(result3.entryId);

    const sharedAfter = await t.query(
      internal.entries.getEntriesForNamespaceByKey,
      { namespaceId, key: "shared-key" },
    );
    expect(sharedAfter).toHaveLength(0);

    // Verify content from deleted entries are also deleted
    const contentAfter = await t.run(async (ctx) => {
      return ctx.db.query("content").collect();
    });
    expect(contentAfter).toHaveLength(1); // Only content from entry3 should remain
  });

  test("deleteByKeySync deletes all entries with the given key synchronously", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry1 = testEntryArgs(namespaceId, "sync-key");
    const entry2 = {
      ...testEntryArgs(namespaceId, "sync-key"),
      contentHash: "hash789",
    };
    const entry3 = testEntryArgs(namespaceId, "keep-key");

    // Create multiple entries with same key and one with different key
    const result1 = await t.mutation(api.entries.add, {
      entry: entry1,
      content: {
        content: { text: "sync content 1" },
        embedding: Array.from({ length: 128 }, () => Math.random()),
      },
    });
    expect(result1.status).toBe("ready");

    const result2 = await t.mutation(api.entries.add, {
      entry: entry2,
      content: {
        content: { text: "sync content 2" },
        embedding: Array.from({ length: 128 }, () => Math.random()),
      },
    });
    expect(result2.status).toBe("pending");

    const result3 = await t.mutation(api.entries.add, {
      entry: entry3,
      content: {
        content: { text: "sync content 3" },
        embedding: Array.from({ length: 128 }, () => Math.random()),
      },
    });
    expect(result3.status).toBe("ready");

    // Verify all entries exist
    const entriesBefore = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) => q.eq(q.field("namespaceId"), namespaceId))
        .collect();
    });
    expect(entriesBefore).toHaveLength(3);

    // Delete entries by key synchronously
    await t.action(api.entries.deleteByKeySync, {
      namespaceId,
      key: "sync-key",
    });

    // Verify only entries with "sync-key" are deleted
    const entriesAfter = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) => q.eq(q.field("namespaceId"), namespaceId))
        .collect();
    });
    expect(entriesAfter).toHaveLength(1);
    expect(entriesAfter[0].key).toBe("keep-key");
    expect(entriesAfter[0]._id).toBe(result3.entryId);

    // Verify content from deleted entries are also deleted
    const contentAfter = await t.run(async (ctx) => {
      return ctx.db.query("content").collect();
    });
    expect(contentAfter).toHaveLength(1); // Only content from entry3 should remain
  });

  test("deleteByKeyAsync handles entries without key gracefully", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entryWithKey = testEntryArgs(namespaceId, "has-key");
    const entryWithoutKey = { ...testEntryArgs(namespaceId), key: undefined };

    // Create entries
    const result1 = await t.mutation(api.entries.add, {
      entry: entryWithKey,
      content: testContentArgs(),
    });
    expect(result1.status).toBe("ready");

    const result2 = await t.mutation(api.entries.add, {
      entry: entryWithoutKey,
    });

    // Delete by key - should only affect entries with that key
    await t.mutation(api.entries.deleteByKeyAsync, {
      namespaceId,
      key: "has-key",
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Verify only the entry with the specified key is deleted
    const entriesAfter = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) => q.eq(q.field("namespaceId"), namespaceId))
        .collect();
    });
    expect(entriesAfter).toHaveLength(1);
    expect(entriesAfter[0]._id).toBe(result2.entryId);
    expect(entriesAfter[0].key).toBeUndefined();
  });

  test("deleteByKeyAsync with beforeVersion parameter", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);

    const entry = testEntryArgs(namespaceId, "versioned-key");

    // Create multiple versions of the same entry
    const result1 = await t.mutation(api.entries.add, {
      entry,
      content: testContentArgs(),
    });
    expect(result1.status).toBe("ready");

    const result2 = await t.mutation(api.entries.add, {
      entry: { ...entry, contentHash: "hash456" },
    });
    expect(result2.status).toBe("pending");

    const result3 = await t.mutation(api.entries.add, {
      entry: { ...entry, contentHash: "hash789" },
    });

    // Get the versions to understand ordering
    const allEntries = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) =>
          q.and(
            q.eq(q.field("namespaceId"), namespaceId),
            q.eq(q.field("key"), "versioned-key"),
          ),
        )
        .collect();
    });

    const sortedEntries = allEntries.sort((a, b) => a.version - b.version);
    expect(sortedEntries).toHaveLength(3);

    // Delete entries before version 2 (should delete version 0 and 1)
    await t.mutation(api.entries.deleteByKeyAsync, {
      namespaceId,
      key: "versioned-key",
      beforeVersion: 2,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Should only have the latest version (version 2) remaining
    const remainingEntries = await t.run(async (ctx) => {
      return ctx.db
        .query("entries")
        .filter((q) =>
          q.and(
            q.eq(q.field("namespaceId"), namespaceId),
            q.eq(q.field("key"), "versioned-key"),
          ),
        )
        .collect();
    });

    expect(remainingEntries).toHaveLength(1);
    expect(remainingEntries[0].version).toBe(2);
    expect(remainingEntries[0]._id).toBe(result3.entryId);
  });

  test("addMany creates multiple entries in one mutation", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);
    const content = testContentArgs("batch content");

    function entryWithoutNamespace(
      namespaceId: Id<"namespaces">,
      key: string,
    ) {
      const { namespaceId: _n, ...rest } = testEntryArgs(namespaceId, key);
      return rest;
    }

    const result = await t.mutation(api.entries.addMany, {
      namespaceId,
      items: [
        {
          entry: entryWithoutNamespace(namespaceId, "batch-1"),
          content,
        },
        {
          entry: entryWithoutNamespace(namespaceId, "batch-2"),
          content: testContentArgs("second"),
        },
        {
          entry: entryWithoutNamespace(namespaceId, "batch-3"),
          content: testContentArgs("third"),
        },
      ],
    });

    expect(result.entryIds).toHaveLength(3);
    expect(result.statuses).toEqual(["ready", "ready", "ready"]);
    expect(result.created).toEqual([true, true, true]);

    const entries = await t.run(async (ctx) => {
      return Promise.all(
        result.entryIds.map((id) => ctx.db.get(id)),
      );
    });
    expect(entries.every((e) => e !== null)).toBe(true);
    expect(entries.map((e) => e!.key)).toEqual(["batch-1", "batch-2", "batch-3"]);
  });

  test("getMany returns entries and null for missing ids", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);
    const { entryId: id1 } = await t.mutation(api.entries.add, {
      entry: testEntryArgs(namespaceId, "g1"),
      content: testContentArgs(),
    });
    const { entryId: id2 } = await t.mutation(api.entries.add, {
      entry: testEntryArgs(namespaceId, "g2"),
      content: testContentArgs(),
    });

    const results = await t.run(async (ctx) => {
      return ctx.runQuery(api.entries.getMany, {
        entryIds: [id1, id2, id1],
      });
    });

    expect(results).toHaveLength(3);
    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[2]).not.toBeNull();
    expect(results[0]!.entryId).toBe(id1);
    expect(results[1]!.entryId).toBe(id2);
  });

  test("deleteMany removes multiple entries in one mutation", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);
    function entryWithoutNamespace(
      namespaceId: Id<"namespaces">,
      key: string,
    ) {
      const { namespaceId: _n, ...rest } = testEntryArgs(namespaceId, key);
      return rest;
    }
    const result = await t.mutation(api.entries.addMany, {
      namespaceId,
      items: [
        {
          entry: entryWithoutNamespace(namespaceId, "d1"),
          content: testContentArgs(),
        },
        {
          entry: entryWithoutNamespace(namespaceId, "d2"),
          content: testContentArgs(),
        },
      ],
    });

    await t.mutation(api.entries.deleteMany, { entryIds: result.entryIds });

    const entries = await t.run(async (ctx) => {
      return Promise.all(
        result.entryIds.map((id) => ctx.db.get(id)),
      );
    });
    expect(entries.every((e) => e === null)).toBe(true);
  });

  test("addManyAsync creates pending entries and processes them via workpool", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);
    const contentProcessorHandle = await t.mutation(
      internal.entries.getTestContentProcessorHandle,
      {},
    );
    function entryWithoutNamespace(
      namespaceId: Id<"namespaces">,
      key: string,
    ) {
      const { namespaceId: _n, ...rest } = testEntryArgs(namespaceId, key);
      return rest;
    }

    const result = await t.mutation(api.entries.addManyAsync, {
      namespaceId,
      items: [
        {
          entry: entryWithoutNamespace(namespaceId, "async-1"),
          contentProcessor: contentProcessorHandle,
        },
        {
          entry: entryWithoutNamespace(namespaceId, "async-2"),
          contentProcessor: contentProcessorHandle,
        },
      ],
    });

    expect(result.entryIds).toHaveLength(2);
    expect(result.statuses).toEqual(["pending", "pending"]);
    expect(result.created).toEqual([true, true]);

    const entries = await t.run(async (ctx) => {
      return Promise.all(
        result.entryIds.map((id) => ctx.db.get(id)),
      );
    });
    expect(entries.every((e) => e !== null)).toBe(true);
    expect(entries.every((e) => e!.status.kind === "pending")).toBe(true);
  });

  test("addManyAsyncBatch runs one batched action then promotes all entries", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);
    const batchHandle = await t.mutation(
      internal.entries.getTestBatchTextProcessorHandle,
      {},
    );
    function entryWithoutNamespace(
      namespaceId: Id<"namespaces">,
      key: string,
    ) {
      const { namespaceId: _n, ...rest } = testEntryArgs(namespaceId, key);
      return rest;
    }

    const result = await t.mutation(api.entries.addManyAsyncBatch, {
      namespaceId,
      items: [
        { entry: entryWithoutNamespace(namespaceId, "batch-async-1") },
        { entry: entryWithoutNamespace(namespaceId, "batch-async-2") },
        { entry: entryWithoutNamespace(namespaceId, "batch-async-3") },
      ],
      batchTextProcessor: batchHandle,
    });

    expect(result.entryIds).toHaveLength(3);
    expect(result.statuses).toEqual(["pending", "pending", "pending"]);
    expect(result.created).toEqual([true, true, true]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const entries = await t.run(async (ctx) => {
      return Promise.all(
        result.entryIds.map((id) => ctx.db.get(id)),
      );
    });
    expect(entries.every((e) => e !== null)).toBe(true);
    expect(entries.every((e) => e!.status.kind === "ready")).toBe(true);

    const batchRows = await t.run(async (ctx) => {
      return ctx.db.query("asyncBatchWork").collect();
    });
    expect(batchRows).toHaveLength(0);
  });

  test("deleteManyAsync schedules deletes and entries are removed after run", async () => {
    const t = initConvexTest();
    const namespaceId = await setupTestNamespace(t);
    function entryWithoutNamespace(
      namespaceId: Id<"namespaces">,
      key: string,
    ) {
      const { namespaceId: _n, ...rest } = testEntryArgs(namespaceId, key);
      return rest;
    }
    const result = await t.mutation(api.entries.addMany, {
      namespaceId,
      items: [
        {
          entry: entryWithoutNamespace(namespaceId, "async-del-1"),
          content: testContentArgs(),
        },
        {
          entry: entryWithoutNamespace(namespaceId, "async-del-2"),
          content: testContentArgs(),
        },
      ],
    });

    await t.mutation(api.entries.deleteManyAsync, {
      entryIds: result.entryIds,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const entries = await t.run(async (ctx) => {
      return Promise.all(
        result.entryIds.map((id) => ctx.db.get(id)),
      );
    });
    expect(entries.every((e) => e === null)).toBe(true);
  });
});
