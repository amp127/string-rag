/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import { internal } from "./_generated/api.js";
import { modules } from "./setup.test.js";
import { insertContent } from "./content.js";
import { hashText } from "../client/fileUtils.js";
import type { Value } from "convex/values";

describe("embeddingCache", () => {
  test("lookup returns null on miss", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(internal.embeddingCache.lookup, {
      modelId: "m",
      dimension: 128,
      textHash: "not-in-cache",
    });
    expect(result).toBeNull();
  });

  test("store and lookup round-trip", async () => {
    const t = convexTest(schema, modules);
    const vec = Array.from({ length: 128 }, (_, i) => i * 0.01);
    await t.mutation(internal.embeddingCache.store, {
      modelId: "m",
      dimension: 128,
      textHash: "abc",
      embedding: vec,
    });
    const result = await t.query(internal.embeddingCache.lookup, {
      modelId: "m",
      dimension: 128,
      textHash: "abc",
    });
    expect(result).toEqual(vec);
  });

  test("store upserts same key", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.embeddingCache.store, {
      modelId: "m",
      dimension: 128,
      textHash: "same",
      embedding: Array(128).fill(0.1),
    });
    await t.mutation(internal.embeddingCache.store, {
      modelId: "m",
      dimension: 128,
      textHash: "same",
      embedding: Array(128).fill(0.9),
    });
    const result = await t.query(internal.embeddingCache.lookup, {
      modelId: "m",
      dimension: 128,
      textHash: "same",
    });
    expect(result?.every((v) => v === 0.9)).toBe(true);
  });

  test("lookupBatch mixed hits and misses", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.embeddingCache.store, {
      modelId: "m",
      dimension: 128,
      textHash: "h1",
      embedding: Array(128).fill(0.2),
    });
    const batch = await t.query(internal.embeddingCache.lookupBatch, {
      modelId: "m",
      dimension: 128,
      textHashes: ["h1", "missing", "h1"],
    });
    expect(batch[0]?.every((v) => v === 0.2)).toBe(true);
    expect(batch[1]).toBeNull();
    expect(batch[2]?.every((v) => v === 0.2)).toBe(true);
  });

  test("clear removes all rows", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.embeddingCache.store, {
      modelId: "m1",
      dimension: 128,
      textHash: "a",
      embedding: Array(128).fill(0.1),
    });
    await t.mutation(internal.embeddingCache.store, {
      modelId: "m2",
      dimension: 256,
      textHash: "b",
      embedding: Array(256).fill(0.2),
    });
    const deleted = await t.mutation(internal.embeddingCache.clear, {});
    expect(deleted).toBe(2);
    const r1 = await t.query(internal.embeddingCache.lookup, {
      modelId: "m1",
      dimension: 128,
      textHash: "a",
    });
    expect(r1).toBeNull();
  });

  test("clear by modelId only", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.embeddingCache.store, {
      modelId: "keep",
      dimension: 128,
      textHash: "x",
      embedding: Array(128).fill(0.3),
    });
    await t.mutation(internal.embeddingCache.store, {
      modelId: "drop",
      dimension: 128,
      textHash: "y",
      embedding: Array(128).fill(0.4),
    });
    const deleted = await t.mutation(internal.embeddingCache.clear, {
      modelId: "drop",
    });
    expect(deleted).toBe(1);
    const kept = await t.query(internal.embeddingCache.lookup, {
      modelId: "keep",
      dimension: 128,
      textHash: "x",
    });
    expect(kept).not.toBeNull();
    const gone = await t.query(internal.embeddingCache.lookup, {
      modelId: "drop",
      dimension: 128,
      textHash: "y",
    });
    expect(gone).toBeNull();
  });

  test("clear by modelId and dimension", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.embeddingCache.store, {
      modelId: "m",
      dimension: 128,
      textHash: "a",
      embedding: Array(128).fill(0.1),
    });
    await t.mutation(internal.embeddingCache.store, {
      modelId: "m",
      dimension: 256,
      textHash: "b",
      embedding: Array(256).fill(0.2),
    });
    const deleted = await t.mutation(internal.embeddingCache.clear, {
      modelId: "m",
      dimension: 128,
    });
    expect(deleted).toBe(1);
    const r128 = await t.query(internal.embeddingCache.lookup, {
      modelId: "m",
      dimension: 128,
      textHash: "a",
    });
    expect(r128).toBeNull();
    const r256 = await t.query(internal.embeddingCache.lookup, {
      modelId: "m",
      dimension: 256,
      textHash: "b",
    });
    expect(r256).not.toBeNull();
  });

  test("clear by dimension only", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.embeddingCache.store, {
      modelId: "a",
      dimension: 512,
      textHash: "p",
      embedding: Array(512).fill(0.1),
    });
    await t.mutation(internal.embeddingCache.store, {
      modelId: "b",
      dimension: 512,
      textHash: "q",
      embedding: Array(512).fill(0.2),
    });
    await t.mutation(internal.embeddingCache.store, {
      modelId: "c",
      dimension: 128,
      textHash: "r",
      embedding: Array(128).fill(0.3),
    });
    const deleted = await t.mutation(internal.embeddingCache.clear, {
      dimension: 512,
    });
    expect(deleted).toBe(2);
    const kept = await t.query(internal.embeddingCache.lookup, {
      modelId: "c",
      dimension: 128,
      textHash: "r",
    });
    expect(kept).not.toBeNull();
  });

  test("insertContent skips cache when populateEmbeddingCache is not true", async () => {
    const t = convexTest(schema, modules);
    const text = "no cache row";
    const embedding = Array.from({ length: 128 }, () => 0.01);
    const namespaceId = await t.run(async (ctx) =>
      ctx.db.insert("namespaces", {
        namespace: "ns-skip",
        version: 1,
        modelId: "m-skip",
        dimension: 128,
        filterNames: [],
        status: { kind: "ready" },
      }),
    );
    const entryId = await t.run(async (ctx) =>
      ctx.db.insert("entries", {
        namespaceId,
        key: "k",
        version: 0,
        status: { kind: "ready" },
        contentHash: "h",
        importance: 0.5,
        filterValues: [] as Array<{ name: string; value: Value }>,
      }),
    );
    await t.run(async (ctx) => {
      await insertContent(ctx, {
        entryId,
        content: {
          content: { text, metadata: {} },
          embedding,
          searchableText: text,
        },
      });
    });
    const textHash = await hashText(text);
    const cached = await t.query(internal.embeddingCache.lookup, {
      modelId: "m-skip",
      dimension: 128,
      textHash,
    });
    expect(cached).toBeNull();
  });

  test("insertContent populates embeddingCache for cross-namespace reuse", async () => {
    const t = convexTest(schema, modules);
    const text = "shared cache text";
    const embedding = Array.from({ length: 128 }, () => 0.07);

    const nsA = await t.run(async (ctx) =>
      ctx.db.insert("namespaces", {
        namespace: "ns-a",
        version: 1,
        modelId: "shared-model",
        dimension: 128,
        filterNames: [],
        status: { kind: "ready" },
      }),
    );
    const nsB = await t.run(async (ctx) =>
      ctx.db.insert("namespaces", {
        namespace: "ns-b",
        version: 1,
        modelId: "shared-model",
        dimension: 128,
        filterNames: [],
        status: { kind: "ready" },
      }),
    );

    const entryA = await t.run(async (ctx) =>
      ctx.db.insert("entries", {
        namespaceId: nsA,
        key: "ka",
        version: 0,
        status: { kind: "ready" },
        contentHash: "ha",
        importance: 0.5,
        filterValues: [] as Array<{ name: string; value: Value }>,
      }),
    );

    await t.run(async (ctx) => {
      await insertContent(ctx, {
        entryId: entryA,
        content: {
          content: { text, metadata: {} },
          embedding,
          searchableText: text,
        },
        populateEmbeddingCache: true,
      });
    });

    const textHash = await hashText(text);
    const cached = await t.query(internal.embeddingCache.lookup, {
      modelId: "shared-model",
      dimension: 128,
      textHash,
    });
    expect(cached).toEqual(embedding);

    const entryB = await t.run(async (ctx) =>
      ctx.db.insert("entries", {
        namespaceId: nsB,
        key: "kb",
        version: 0,
        status: { kind: "ready" },
        contentHash: "hb",
        importance: 0.5,
        filterValues: [] as Array<{ name: string; value: Value }>,
      }),
    );

    await t.run(async (ctx) => {
      await insertContent(ctx, {
        entryId: entryB,
        content: {
          content: { text, metadata: {} },
          embedding,
          searchableText: text,
        },
        populateEmbeddingCache: true,
      });
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingCache")
        .withIndex("by_modelId_dimension_hash", (q) =>
          q
            .eq("modelId", "shared-model")
            .eq("dimension", 128)
            .eq("textHash", textHash),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});
