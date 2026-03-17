import { v, type Infer } from "convex/values";
import { action, internalQuery, type QueryCtx } from "./_generated/server.js";
import { searchEmbeddings } from "./embeddings/index.js";
import {
  filterFieldsFromNumbers,
  numberedFiltersFromNamedFilters,
  vNamedFilter,
  type NumberedFilter,
} from "./filters.js";
import { internal } from "./_generated/api.js";
import {
  vEntry,
  vSearchResult,
  vSearchType,
  type SearchResult,
  type EntryId,
} from "../shared.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { type vContentResult } from "./content.js";
import { publicEntry } from "./entries.js";
import { hybridRank } from "../client/hybridRank.js";
import { vVectorId, type VectorTableId } from "./embeddings/tables.js";
import { getPendingEmbeddingForContent } from "./pendingEmbedding.js";

export const search = action({
  args: {
    namespace: v.string(),
    embedding: v.optional(v.array(v.number())),
    dimension: v.optional(v.number()),
    modelId: v.string(),
    // These are all OR'd together
    filters: v.array(vNamedFilter),
    limit: v.number(),
    vectorScoreThreshold: v.optional(v.number()),
    searchType: v.optional(vSearchType),
    textQuery: v.optional(v.string()),
    textWeight: v.optional(v.number()),
    vectorWeight: v.optional(v.number()),
  },
  returns: v.object({
    results: v.array(vSearchResult),
    entries: v.array(vEntry),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    results: SearchResult[];
    entries: Infer<typeof vEntry>[];
  }> => {
    const { modelId, embedding, filters, limit } = args;
    const dimension = embedding?.length ?? args.dimension;
    if (!dimension) {
      throw new Error(
        "Either embedding or dimension must be provided to search.",
      );
    }

    const namespace = await ctx.runQuery(
      internal.namespaces.getCompatibleNamespace,
      {
        namespace: args.namespace,
        modelId,
        dimension,
        filterNames: filters.map((f) => f.name),
      },
    );
    if (!namespace) {
      console.debug(
        `No compatible namespace found for ${args.namespace} with model ${args.modelId} and dimension ${dimension} and filters ${filters.map((f) => f.name).join(", ")}.`,
      );
      return {
        results: [],
        entries: [],
      };
    }

    const numberedFilters = numberedFiltersFromNamedFilters(
      filters,
      namespace.filterNames,
    );

    const hasEmbedding = !!embedding;
    const hasTextQuery = !!args.textQuery;

    // Vector-only path: return results with cosine similarity scores.
    if (hasEmbedding && !hasTextQuery) {
      const vectorResults = await searchEmbeddings(ctx, {
        embedding,
        namespaceId: namespace._id,
        filters: numberedFilters,
        limit,
      });
      const threshold = args.vectorScoreThreshold ?? -1;
      const aboveThreshold = vectorResults.filter((r) => r._score >= threshold);
      const { results: contentResults, entries } = await ctx.runQuery(
        internal.content.getContentByEmbeddingIds,
        {
          embeddingIds: aboveThreshold.map((r) => r._id),
        },
      );
      return {
        results: contentResults
          .map((r, i) =>
            r ? publicSearchResult(r, aboveThreshold[i]._score) : null,
          )
          .filter((r): r is SearchResult => r !== null),
        entries: entries as Infer<typeof vEntry>[],
      };
    }

    // Hybrid or text-only path: combine vector and text results with RRF.
    let embeddingIds: VectorTableId[] = [];
    if (hasEmbedding && embedding) {
      const vectorResults = await searchEmbeddings(ctx, {
        embedding,
        namespaceId: namespace._id,
        filters: numberedFilters,
        limit,
      });
      const threshold = args.vectorScoreThreshold ?? -1;
      embeddingIds = vectorResults
        .filter((r) => r._score >= threshold)
        .map((r) => r._id);
    }

    if (!hasTextQuery) {
      throw new Error(
        "Search requires at least one of embedding or textQuery.",
      );
    }

    const textQuery = args.textQuery;
    const { results: contentResults, entries, resultCount } =
      await ctx.runQuery(internal.search.textAndContent, {
        embeddingIds,
        textQuery: textQuery ?? "",
        namespaceId: namespace._id,
        filters: numberedFilters,
        limit,
        vectorWeight: args.vectorWeight ?? 1,
        textWeight: args.textWeight ?? 1,
      });

    return {
      results: contentResults
        .map((r, i) =>
          r ? publicSearchResult(r, (resultCount - i) / resultCount) : null,
        )
        .filter((r): r is SearchResult => r !== null),
      entries: entries as Infer<typeof vEntry>[],
    };
  },
});

type TextSearchResult = {
  contentId: Id<"content">;
  entryId: Id<"entries">;
};

async function textSearchImpl(
  ctx: QueryCtx,
  args: {
    query: string;
    namespaceId: Id<"namespaces">;
    filters: NumberedFilter[];
    limit: number;
  },
): Promise<TextSearchResult[]> {
  const toResults = (contents: Doc<"content">[]): TextSearchResult[] =>
    contents
      .filter((content) => content.state.kind === "ready")
      .map((content) => ({
        contentId: content._id,
        entryId: content.entryId,
      }));

  if (args.filters.length === 0) {
    const results = await ctx.db
      .query("content")
      .withSearchIndex("searchableText", (q) =>
        q
          .search("state.searchableText", args.query)
          .eq("namespaceId", args.namespaceId),
      )
      .take(args.limit);
    return toResults(results);
  }

  const seen = new Set<Id<"content">>();
  const merged: TextSearchResult[] = [];
  for (const filter of args.filters) {
    const fields = filterFieldsFromNumbers(args.namespaceId, filter);
    const results = await ctx.db
      .query("content")
      .withSearchIndex("searchableText", (q) => {
        let query = q
          .search("state.searchableText", args.query)
          .eq("namespaceId", args.namespaceId);
        for (const [field, value] of Object.entries(fields)) {
          query = query.eq(
            field as "filter0" | "filter1" | "filter2" | "filter3",
            value,
          );
        }
        return query;
      })
      .take(args.limit);
    for (const r of toResults(results)) {
      if (!seen.has(r.contentId)) {
        seen.add(r.contentId);
        merged.push(r);
      }
    }
  }
  return merged.slice(0, args.limit);
}

export const textSearch = internalQuery({
  args: {
    query: v.string(),
    namespaceId: v.id("namespaces"),
    filters: v.array(v.any()),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      contentId: v.id("content"),
      entryId: v.id("entries"),
    }),
  ),
  handler: async (ctx, args) => {
    return textSearchImpl(ctx, {
      query: args.query,
      namespaceId: args.namespaceId,
      filters: args.filters as NumberedFilter[],
      limit: args.limit,
    });
  },
});

export const textAndContent = internalQuery({
  args: {
    embeddingIds: v.array(vVectorId),
    textQuery: v.string(),
    namespaceId: v.id("namespaces"),
    filters: v.array(v.any()),
    limit: v.number(),
    vectorWeight: v.number(),
    textWeight: v.number(),
  },
  returns: v.object({
    results: v.array(
      v.union(
        v.null(),
        v.object({
          entryId: v.id("entries"),
          content: v.object({
            text: v.string(),
            metadata: v.optional(v.record(v.string(), v.any())),
          }),
        }),
      ),
    ),
    entries: v.array(vEntry),
    resultCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const vectorContentIds: Id<"content">[] = (
      await Promise.all(
        args.embeddingIds.map(async (embeddingId) => {
          const content = await ctx.db
            .query("content")
            .withIndex("embeddingId", (q) =>
              q.eq("state.embeddingId", embeddingId),
            )
            .first();
          return content?._id ?? null;
        }),
      )
    ).filter((id) => id !== null);

    const textResults = await textSearchImpl(ctx, {
      query: args.textQuery,
      namespaceId: args.namespaceId,
      filters: args.filters as NumberedFilter[],
      limit: args.limit,
    });
    const textContentIds: Id<"content">[] = textResults.map((r) => r.contentId);

    const mergedContentIds = hybridRank<Id<"content">>(
      [vectorContentIds, textContentIds],
      { k: 10, weights: [args.vectorWeight, args.textWeight] },
    ).slice(0, args.limit);

    if (mergedContentIds.length === 0) {
      return { results: [], entries: [], resultCount: 0 };
    }

    const contentDocs = await Promise.all(
      mergedContentIds.map((id) => ctx.db.get(id)),
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
    const results = contentDocs.map((content) =>
      content
        ? {
            entryId: content.entryId,
            content: { text: content.text, metadata: content.metadata },
          }
        : null,
    );
    return {
      results,
      entries,
      resultCount: mergedContentIds.length,
    };
  },
});

export const getEntryEmbedding = internalQuery({
  args: {
    entryId: v.id("entries"),
  },
  returns: v.object({
    embedding: v.array(v.number()),
    namespaceId: v.id("namespaces"),
    filterNames: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) {
      throw new Error(`Entry ${args.entryId} not found`);
    }

    const content = await ctx.db
      .query("content")
      .withIndex("entryId", (q) => q.eq("entryId", args.entryId))
      .first();
    if (!content) {
      throw new Error(`No content found for entry ${args.entryId}`);
    }

    let embedding: number[];
    switch (content.state.kind) {
      case "pending": {
        const pending = await getPendingEmbeddingForContent(
          ctx,
          content._id,
        );
        if (!pending) {
          throw new Error(
            `No pending embedding stored for content ${content._id}`,
          );
        }
        embedding = pending;
        break;
      }
      case "ready": {
        const vector = await ctx.db.get(content.state.embeddingId);
        if (!vector) {
          throw new Error(
            `Vector ${content.state.embeddingId} not found`,
          );
        }
        // Strip the importance weight dimension appended by vectorWithImportance
        embedding = vector.vector.slice(0, -1);
        // 4096-dim embeddings were truncated to 4095 to fit the importance
        // weight within the 4096 limit; pad back so searchEmbeddings resolves
        // the correct vector table.
        if (embedding.length === 4095) {
          embedding.push(0);
        }
        break;
      }
      case "replaced": {
        embedding = content.state.vector.slice(0, -1);
        if (embedding.length === 4095) {
          embedding.push(0);
        }
        break;
      }
    }

    const namespace = await ctx.db.get(entry.namespaceId);
    if (!namespace) {
      throw new Error(`Namespace ${entry.namespaceId} not found`);
    }

    return {
      embedding,
      namespaceId: entry.namespaceId,
      filterNames: namespace.filterNames,
    };
  },
});

export const getEntryEmbeddingByKey = internalQuery({
  args: {
    namespaceId: v.id("namespaces"),
    key: v.string(),
  },
  returns: v.object({
    embedding: v.array(v.number()),
    namespaceId: v.id("namespaces"),
    filterNames: v.array(v.string()),
    entryId: v.id("entries"),
  }),
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("entries")
      .withIndex("namespaceId_status_key_version", (q) =>
        q
          .eq("namespaceId", args.namespaceId)
          .eq("status.kind", "ready")
          .eq("key", args.key),
      )
      .order("desc")
      .first();
    if (!entry) {
      throw new Error(
        `No ready entry found for key "${args.key}" in the given namespace`,
      );
    }

    const content = await ctx.db
      .query("content")
      .withIndex("entryId", (q) => q.eq("entryId", entry._id))
      .first();
    if (!content) {
      throw new Error(`No content found for entry ${entry._id}`);
    }

    let embedding: number[];
    switch (content.state.kind) {
      case "pending": {
        const pending = await getPendingEmbeddingForContent(
          ctx,
          content._id,
        );
        if (!pending) {
          throw new Error(
            `No pending embedding stored for content ${content._id}`,
          );
        }
        embedding = pending;
        break;
      }
      case "ready": {
        const vector = await ctx.db.get(content.state.embeddingId);
        if (!vector) {
          throw new Error(
            `Vector ${content.state.embeddingId} not found`,
          );
        }
        embedding = vector.vector.slice(0, -1);
        if (embedding.length === 4095) {
          embedding.push(0);
        }
        break;
      }
      case "replaced": {
        embedding = content.state.vector.slice(0, -1);
        if (embedding.length === 4095) {
          embedding.push(0);
        }
        break;
      }
    }

    const namespace = await ctx.db.get(entry.namespaceId);
    if (!namespace) {
      throw new Error(`Namespace ${entry.namespaceId} not found`);
    }

    return {
      embedding,
      namespaceId: entry.namespaceId,
      filterNames: namespace.filterNames,
      entryId: entry._id,
    };
  },
});

export const searchSimilar = action({
  args: {
    namespace: v.string(),
    modelId: v.string(),
    dimension: v.number(),
    key: v.string(),
    filters: v.array(vNamedFilter),
    limit: v.number(),
    vectorScoreThreshold: v.optional(v.number()),
  },
  returns: v.object({
    results: v.array(vSearchResult),
    entries: v.array(vEntry),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    results: SearchResult[];
    entries: Infer<typeof vEntry>[];
  }> => {
    const { key, filters, limit } = args;

    const namespaceDoc = await ctx.runQuery(
      internal.namespaces.getCompatibleNamespace,
      {
        namespace: args.namespace,
        modelId: args.modelId,
        dimension: args.dimension,
        filterNames: filters.map((f) => f.name),
      },
    );
    if (!namespaceDoc) {
      return { results: [], entries: [] };
    }

    const { embedding, namespaceId, filterNames, entryId } = await ctx.runQuery(
      internal.search.getEntryEmbeddingByKey,
      { namespaceId: namespaceDoc._id, key },
    );

    const numberedFilters = numberedFiltersFromNamedFilters(
      filters,
      filterNames,
    );

    const vectorResults = await searchEmbeddings(ctx, {
      embedding,
      namespaceId,
      filters: numberedFilters,
      limit: limit + 1,
    });

    const threshold = args.vectorScoreThreshold ?? -1;
    const aboveThreshold = vectorResults.filter((r) => r._score >= threshold);

    const { results: contentResults, entries } = await ctx.runQuery(
      internal.content.getContentByEmbeddingIds,
      {
        embeddingIds: aboveThreshold.map((r) => r._id),
      },
    );

    const sourceEntryIdStr = entryId as unknown as string;
    const results = contentResults
      .map((r, i) =>
        r ? publicSearchResult(r, aboveThreshold[i]._score) : null,
      )
      .filter(
        (r): r is SearchResult =>
          r !== null &&
          (r.entryId as unknown as string) !== sourceEntryIdStr,
      )
      .slice(0, limit);

    const resultEntryIds = new Set(results.map((r) => r.entryId));

    return {
      results,
      entries: (entries as Infer<typeof vEntry>[]).filter((e) =>
        resultEntryIds.has(e.entryId),
      ),
    };
  },
});

export const searchWithEntryId = action({
  args: {
    entryId: v.id("entries"),
    filters: v.array(vNamedFilter),
    limit: v.number(),
    vectorScoreThreshold: v.optional(v.number()),
  },
  returns: v.object({
    results: v.array(vSearchResult),
    entries: v.array(vEntry),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    results: SearchResult[];
    entries: Infer<typeof vEntry>[];
  }> => {
    const { entryId, filters, limit } = args;

    const { embedding, namespaceId, filterNames } = await ctx.runQuery(
      internal.search.getEntryEmbedding,
      { entryId },
    );

    const numberedFilters = numberedFiltersFromNamedFilters(
      filters,
      filterNames,
    );

    const vectorResults = await searchEmbeddings(ctx, {
      embedding,
      namespaceId,
      filters: numberedFilters,
      limit: limit + 1,
    });

    const threshold = args.vectorScoreThreshold ?? -1;
    const aboveThreshold = vectorResults.filter((r) => r._score >= threshold);

    const { results: contentResults, entries } = await ctx.runQuery(
      internal.content.getContentByEmbeddingIds,
      {
        embeddingIds: aboveThreshold.map((r) => r._id),
      },
    );

    const sourceEntryIdStr = entryId as unknown as string;
    const results = contentResults
      .map((r, i) =>
        r ? publicSearchResult(r, aboveThreshold[i]._score) : null,
      )
      .filter(
        (r): r is SearchResult =>
          r !== null &&
          (r.entryId as unknown as string) !== sourceEntryIdStr,
      )
      .slice(0, limit);

    const resultEntryIds = new Set(results.map((r) => r.entryId));

    return {
      results,
      entries: (entries as Infer<typeof vEntry>[]).filter((e) =>
        resultEntryIds.has(e.entryId),
      ),
    };
  },
});

function publicSearchResult(
  r: Infer<typeof vContentResult> | null,
  score: number,
): SearchResult | null {
  if (r === null) {
    return null;
  }
  return {
    entryId: r.entryId as unknown as EntryId,
    content: r.content,
    score,
  };
}
