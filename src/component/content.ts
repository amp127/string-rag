import { assert } from "convex-helpers";
import { mergedStream, stream } from "convex-helpers/server/stream";
import { type Infer } from "convex/values";
import { statuses, vCreateContentArgs, vEntry, vStatus, type Entry } from "../shared.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { insertEmbedding } from "./embeddings/index.js";
import { vVectorId } from "./embeddings/tables.js";
import { schema, v } from "./schema.js";
import { getPreviousEntry, publicEntry } from "./entries.js";
import {
  filterFieldsFromNumbers,
  numberedFilterFromNamedFilters,
} from "./filters.js";

export const vInsertContentArgs = v.object({
  entryId: v.id("entries"),
  content: vCreateContentArgs,
});
type InsertContentArgs = Infer<typeof vInsertContentArgs>;

export const insert = mutation({
  args: vInsertContentArgs,
  returns: v.object({ status: vStatus }),
  handler: insertContent,
});

export async function insertContent(
  ctx: MutationCtx,
  { entryId, content }: InsertContentArgs,
) {
  const entry = await ctx.db.get(entryId);
  if (!entry) {
    throw new Error(`Entry ${entryId} not found`);
  }
  await ensureLatestEntryVersion(ctx, entry);

  const namespace = await ctx.db.get(entry.namespaceId);
  assert(namespace, `Namespace ${entry.namespaceId} not found`);

  const previousEntry = await getPreviousEntry(ctx, entry);

  const existingContent = await ctx.db
    .query("content")
    .withIndex("entryId", (q) => q.eq("entryId", entryId))
    .first();

  if (existingContent) {
    if (existingContent.state.kind === "ready") {
      await ctx.db.delete(existingContent.state.embeddingId);
    }
    await ctx.db.delete(existingContent._id);
  }

  const numberedFilter = numberedFilterFromNamedFilters(
    entry.filterValues,
    namespace.filterNames,
  );

  let state: Doc<"content">["state"] = {
    kind: "pending",
    embedding: content.embedding,
    importance: entry.importance,
    pendingSearchableText: content.searchableText,
  };
  if (!previousEntry) {
    const embeddingId = await insertEmbedding(
      ctx,
      content.embedding,
      entry.namespaceId,
      entry.importance,
      numberedFilter,
    );
    state = {
      kind: "ready",
      embeddingId,
      searchableText: content.searchableText,
    };
  }

  await ctx.db.insert("content", {
    entryId,
    text: content.content.text,
    metadata: content.content.metadata,
    state,
    namespaceId: entry.namespaceId,
    ...filterFieldsFromNumbers(entry.namespaceId, numberedFilter),
  });

  return { status: previousEntry ? ("pending" as const) : ("ready" as const) };
}

async function ensureLatestEntryVersion(ctx: QueryCtx, entry: Doc<"entries">) {
  if (!entry.key) {
    return true;
  }
  const newerEntry = await mergedStream(
    statuses.map((status) =>
      stream(ctx.db, schema)
        .query("entries")
        .withIndex("namespaceId_status_key_version", (q) =>
          q
            .eq("namespaceId", entry.namespaceId)
            .eq("status.kind", status)
            .eq("key", entry.key)
            .gt("version", entry.version),
        ),
    ),
    ["version"],
  ).first();
  if (newerEntry) {
    console.warn(
      `Bailing from inserting content for entry ${entry.key} at version ${entry.version} since there's a newer version ${newerEntry.version}`,
    );
    return false;
  }
  return true;
}

export const replaceContent = mutation({
  args: v.object({ entryId: v.id("entries") }),
  returns: v.object({ status: vStatus }),
  handler: async (ctx, args) => {
    const { entryId } = args;
    const entry = await ctx.db.get(entryId);
    if (!entry) {
      throw new Error(`Entry ${entryId} not found`);
    }
    const isLatest = await ensureLatestEntryVersion(ctx, entry);
    if (!isLatest) {
      return { status: "replaced" as const };
    }

    const namespace = await ctx.db.get(entry.namespaceId);
    assert(namespace, `Namespace ${entry.namespaceId} not found`);

    const previousEntry = await getPreviousEntry(ctx, entry);
    const numberedFilter = numberedFilterFromNamedFilters(
      entry.filterValues,
      namespace.filterNames,
    );

    const contentDoc = await ctx.db
      .query("content")
      .withIndex("entryId", (q) => q.eq("entryId", entryId))
      .first();

    if (!contentDoc) {
      return { status: "ready" as const };
    }

    if (contentDoc.state.kind === "pending") {
      const embeddingId = await insertEmbedding(
        ctx,
        contentDoc.state.embedding,
        entry.namespaceId,
        entry.importance,
        numberedFilter,
      );
      await ctx.db.patch(contentDoc._id, {
        state: { kind: "ready", embeddingId, searchableText: contentDoc.state.pendingSearchableText },
      });
    }

    if (previousEntry) {
      const previousContent = await ctx.db
        .query("content")
        .withIndex("entryId", (q) => q.eq("entryId", previousEntry._id))
        .first();
      if (previousContent?.state.kind === "ready") {
        const vector = await ctx.db.get(previousContent.state.embeddingId);
        if (vector) {
          await ctx.db.delete(previousContent.state.embeddingId);
          await ctx.db.patch(previousContent._id, {
            state: {
              kind: "replaced",
              embeddingId: previousContent.state.embeddingId,
              vector: vector.vector,
              pendingSearchableText: previousContent.state.searchableText,
            },
          });
        }
      }
    }

    return { status: "ready" as const };
  },
});

export const vContentResult = v.object({
  entryId: v.id("entries"),
  content: v.object({
    text: v.string(),
    metadata: v.optional(v.record(v.string(), v.any())),
  }),
});

export const getContentByEmbeddingIds = internalQuery({
  args: {
    embeddingIds: v.array(vVectorId),
  },
  returns: v.object({
    results: v.array(v.union(v.null(), vContentResult)),
    entries: v.array(vEntry),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    results: (null | Infer<typeof vContentResult>)[];
    entries: Entry[];
  }> => {
    const contentDocs = await Promise.all(
      args.embeddingIds.map((embeddingId) =>
        ctx.db
          .query("content")
          .withIndex("embeddingId", (q) =>
            q.eq("state.embeddingId", embeddingId),
          )
          .first(),
      ),
    );

    const entryIdsInOrder = [
      ...new Set(
        contentDocs
          .filter((c): c is Doc<"content"> => c !== null)
          .map((c) => c.entryId),
      ),
    ];
    const entryDocs = (
      await Promise.all(entryIdsInOrder.map((id) => ctx.db.get(id)))
    ).filter((d): d is Doc<"entries"> => d !== null);
    const entries = entryDocs.map(publicEntry);

    const results: (null | Infer<typeof vContentResult>)[] = contentDocs.map(
      (content) => {
        if (!content) return null;
        return {
          entryId: content.entryId,
          content: { text: content.text, metadata: content.metadata },
        };
      },
    );

    return { results, entries };
  },
});

export const deleteContent = internalMutation({
  args: v.object({ entryId: v.id("entries") }),
  returns: v.object({ isDone: v.boolean() }),
  handler: deleteContentHandler,
});

export async function deleteContentHandler(
  ctx: MutationCtx,
  { entryId }: { entryId: Id<"entries"> },
) {
  const contentDoc = await ctx.db
    .query("content")
    .withIndex("entryId", (q) => q.eq("entryId", entryId))
    .first();

  if (!contentDoc) {
    return { isDone: true };
  }

  if (contentDoc.state.kind === "ready") {
    const embedding = await ctx.db.get(contentDoc.state.embeddingId);
    if (embedding) {
      await ctx.db.delete(contentDoc.state.embeddingId);
    }
  }
  await ctx.db.delete(contentDoc._id);
  return { isDone: true };
}
