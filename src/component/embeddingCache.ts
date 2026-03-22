import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";

export async function upsertEmbeddingCacheEntry(
  ctx: MutationCtx,
  args: {
    modelId: string;
    dimension: number;
    textHash: string;
    embedding: number[];
  },
): Promise<void> {
  const existing = await ctx.db
    .query("embeddingCache")
    .withIndex("by_modelId_dimension_hash", (q) =>
      q
        .eq("modelId", args.modelId)
        .eq("dimension", args.dimension)
        .eq("textHash", args.textHash),
    )
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, { embedding: args.embedding });
  } else {
    await ctx.db.insert("embeddingCache", {
      modelId: args.modelId,
      dimension: args.dimension,
      textHash: args.textHash,
      embedding: args.embedding,
    });
  }
}

export async function upsertEmbeddingCacheBatch(
  ctx: MutationCtx,
  items: Array<{
    modelId: string;
    dimension: number;
    textHash: string;
    embedding: number[];
  }>,
): Promise<void> {
  for (const item of items) {
    await upsertEmbeddingCacheEntry(ctx, item);
  }
}

export const lookup = internalQuery({
  args: {
    modelId: v.string(),
    dimension: v.number(),
    textHash: v.string(),
  },
  returns: v.union(v.null(), v.array(v.number())),
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("embeddingCache")
      .withIndex("by_modelId_dimension_hash", (q) =>
        q
          .eq("modelId", args.modelId)
          .eq("dimension", args.dimension)
          .eq("textHash", args.textHash),
      )
      .first();
    return doc?.embedding ?? null;
  },
});

export const lookupBatch = internalQuery({
  args: {
    modelId: v.string(),
    dimension: v.number(),
    textHashes: v.array(v.string()),
  },
  returns: v.array(v.union(v.null(), v.array(v.number()))),
  handler: async (ctx, args) => {
    return Promise.all(
      args.textHashes.map(async (textHash) => {
        const doc = await ctx.db
          .query("embeddingCache")
          .withIndex("by_modelId_dimension_hash", (q) =>
            q
              .eq("modelId", args.modelId)
              .eq("dimension", args.dimension)
              .eq("textHash", textHash),
          )
          .first();
        return doc?.embedding ?? null;
      }),
    );
  },
});

export const store = internalMutation({
  args: {
    modelId: v.string(),
    dimension: v.number(),
    textHash: v.string(),
    embedding: v.array(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertEmbeddingCacheEntry(ctx, args);
    return null;
  },
});

const vCacheItem = v.object({
  modelId: v.string(),
  dimension: v.number(),
  textHash: v.string(),
  embedding: v.array(v.number()),
});

export const storeBatch = internalMutation({
  args: {
    items: v.array(vCacheItem),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertEmbeddingCacheBatch(ctx, args.items);
    return null;
  },
});

export const clear = internalMutation({
  args: {
    modelId: v.optional(v.string()),
    dimension: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let deleted = 0;

    if (args.modelId !== undefined && args.dimension !== undefined) {
      while (true) {
        const batch = await ctx.db
          .query("embeddingCache")
          .withIndex("by_modelId_dimension_hash", (q) =>
            q.eq("modelId", args.modelId!).eq("dimension", args.dimension!),
          )
          .take(128);
        if (batch.length === 0) break;
        for (const doc of batch) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
      }
      return deleted;
    }

    if (args.modelId !== undefined) {
      while (true) {
        const batch = await ctx.db
          .query("embeddingCache")
          .withIndex("by_modelId_dimension_hash", (q) => q.eq("modelId", args.modelId!))
          .take(128);
        if (batch.length === 0) break;
        for (const doc of batch) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
      }
      return deleted;
    }

    if (args.dimension !== undefined) {
      while (true) {
        const batch = await ctx.db
          .query("embeddingCache")
          .withIndex("by_dimension", (q) => q.eq("dimension", args.dimension!))
          .take(128);
        if (batch.length === 0) break;
        for (const doc of batch) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
      }
      return deleted;
    }

    while (true) {
      const batch = await ctx.db.query("embeddingCache").take(128);
      if (batch.length === 0) break;
      for (const doc of batch) {
        await ctx.db.delete(doc._id);
        deleted++;
      }
    }
    return deleted;
  },
});
