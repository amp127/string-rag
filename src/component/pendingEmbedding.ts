import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

export async function insertPendingEmbedding(
  ctx: MutationCtx,
  contentId: Id<"content">,
  embedding: number[],
) {
  await ctx.db.insert("pendingContentEmbeddings", { contentId, embedding });
}

export async function deletePendingEmbeddingForContent(
  ctx: MutationCtx,
  contentId: Id<"content">,
) {
  const row = await ctx.db
    .query("pendingContentEmbeddings")
    .withIndex("by_contentId", (q) => q.eq("contentId", contentId))
    .first();
  if (row) {
    await ctx.db.delete(row._id);
  }
}

export async function getPendingEmbeddingForContent(
  ctx: QueryCtx,
  contentId: Id<"content">,
): Promise<number[] | null> {
  const row = await ctx.db
    .query("pendingContentEmbeddings")
    .withIndex("by_contentId", (q) => q.eq("contentId", contentId))
    .first();
  return row?.embedding ?? null;
}
