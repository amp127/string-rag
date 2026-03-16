/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "./schema.js";
import { api, internal } from "./_generated/api.js";
import { modules } from "./setup.test.js";
import { insertContent, deleteContentHandler } from "./content.js";
import type { Id } from "./_generated/dataModel.js";
import { assert } from "convex-helpers";

type ConvexTest = TestConvex<typeof schema>;

function createTestContent() {
  return {
    content: {
      text: "Test content text",
      metadata: { index: 0 },
    },
    embedding: Array(128).fill(0.1),
    searchableText: "Test content text",
  };
}

describe("content", () => {
  async function setupTestNamespace(t: ConvexTest) {
    return await t.run(async (ctx) => {
      return ctx.db.insert("namespaces", {
        namespace: "test-namespace",
        version: 1,
        modelId: "test-model",
        dimension: 128,
        filterNames: [],
        status: { kind: "ready" },
      });
    });
  }

  async function setupTestEntry(
    t: ConvexTest,
    namespaceId: Id<"namespaces">,
    key = "test-entry",
    version = 0,
    status: "ready" | "pending" = "ready",
  ) {
    return await t.run(async (ctx) => {
      return ctx.db.insert("entries", {
        namespaceId,
        key,
        version,
        status: { kind: status },
        contentHash: `test-content-hash-${key}-${version}`,
        importance: 0.5,
        filterValues: [],
      });
    });
  }

  test("inserting content when there's no entry throws error", async () => {
    const t = convexTest(schema, modules);
    await setupTestNamespace(t);

    const nonExistentDocId = "j57c3xc4x6j3c4x6j3c4x6j3c4x6" as Id<"entries">;
    const content = createTestContent();

    await expect(
      t.run(async (ctx) => {
        return insertContent(ctx, {
          entryId: nonExistentDocId,
          content,
        });
      }),
    ).rejects.toThrow(`Entry ${nonExistentDocId} not found`);
  });

  test("inserting content creates one content row per entry", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);
    const entryId = await setupTestEntry(t, namespaceId);

    const content = createTestContent();
    await t.run(async (ctx) => {
      return insertContent(ctx, { entryId, content });
    });

    const contentList = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", entryId))
        .collect();
    });
    expect(contentList).toHaveLength(1);
    expect(contentList[0].text).toBe("Test content text");
    expect(contentList[0].state.kind).toBe("ready");
  });

  test("overwriting content with insert works", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);
    const entryId = await setupTestEntry(t, namespaceId);

    await t.run(async (ctx) => {
      return insertContent(ctx, {
        entryId,
        content: createTestContent(),
      });
    });

    const overwriteContent = {
      content: {
        text: "Overwritten content",
        metadata: { overwritten: true },
      },
      embedding: Array(128).fill(0.9),
      searchableText: "Overwritten content",
    };

    await t.run(async (ctx) => {
      return insertContent(ctx, { entryId, content: overwriteContent });
    });

    const contentList = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", entryId))
        .collect();
    });
    expect(contentList).toHaveLength(1);
    expect(contentList[0].text).toBe("Overwritten content");
    expect(contentList[0].metadata?.overwritten).toBe(true);
  });

  test("when replacing an older version, replaceContent promotes new to ready", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);

    const docV1Id = await setupTestEntry(t, namespaceId, "versioned-entry", 1);
    await t.run(async (ctx) => {
      return insertContent(ctx, {
        entryId: docV1Id,
        content: createTestContent(),
      });
    });

    const docV2Id = await setupTestEntry(
      t,
      namespaceId,
      "versioned-entry",
      2,
      "pending",
    );
    await t.run(async (ctx) => {
      return insertContent(ctx, {
        entryId: docV2Id,
        content: {
          content: { text: "Version 2 content" },
          embedding: Array(128).fill(0.2),
          searchableText: "Version 2 content",
        },
      });
    });

    await t.mutation(api.content.replaceContent, { entryId: docV2Id });

    const v2Content = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", docV2Id))
        .first();
    });
    expect(v2Content?.state.kind).toBe("ready");
  });

  test("getContentByEmbeddingIds returns content and entries", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);
    const entryId = await setupTestEntry(t, namespaceId);

    await t.run(async (ctx) => {
      return insertContent(ctx, {
        entryId,
        content: createTestContent(),
      });
    });

    const contentDoc = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", entryId))
        .first();
    });
    assert(contentDoc?.state.kind === "ready");

    const { results, entries } = await t.query(
      internal.content.getContentByEmbeddingIds,
      {
        embeddingIds: [contentDoc.state.embeddingId],
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].entryId).toBe(entryId);
    expect(results).toHaveLength(1);
    expect(results[0]?.content.text).toBe("Test content text");
    expect(results[0]?.entryId).toBe(entryId);
  });

  test("deleteContentHandler removes content and embedding", async () => {
    const t = convexTest(schema, modules);
    const namespaceId = await setupTestNamespace(t);
    const entryId = await setupTestEntry(t, namespaceId);

    await t.run(async (ctx) => {
      return insertContent(ctx, {
        entryId,
        content: createTestContent(),
      });
    });

    const deleteResult = await t.run(async (ctx) => {
      return deleteContentHandler(ctx, { entryId });
    });
    expect(deleteResult.isDone).toBe(true);

    const contentList = await t.run(async (ctx) => {
      return ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", entryId))
        .collect();
    });
    expect(contentList).toHaveLength(0);

    const allContent = await t.run(async (ctx) => {
      return ctx.db.query("content").collect();
    });
    expect(allContent).toHaveLength(0);

    const allEmbeddings = await t.run(async (ctx) => {
      return ctx.db.query("vectors_128").collect();
    });
    expect(allEmbeddings).toHaveLength(0);
  });
});
