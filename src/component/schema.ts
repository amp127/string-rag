import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import embeddingsTables, { vVectorId } from "./embeddings/tables.js";
import { typedV } from "convex-helpers/validators";
import {
  allFilterFieldNames,
  vAllFilterFields,
  vNamedFilter,
} from "./filters.js";

export const vStatusWithOnComplete = v.union(
  v.object({
    kind: v.literal("pending"),
    // Callback function handle for when the namespace/entry is ready/failed.
    onComplete: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("ready"),
  }),
  v.object({
    kind: v.literal("replaced"),
    replacedAt: v.number(),
  }),
);

export type StatusWithOnComplete = Infer<typeof vStatusWithOnComplete>;

export const schema = defineSchema({
  namespaces: defineTable({
    // user-specified id, eg. userId or "documentation"
    namespace: v.string(),
    version: v.number(),
    modelId: v.string(),
    dimension: v.number(),
    filterNames: v.array(v.string()),
    status: vStatusWithOnComplete,
  }).index("status_namespace_version", ["status.kind", "namespace", "version"]),
  entries: defineTable({
    key: v.optional(v.string()),
    namespaceId: v.id("namespaces"),
    version: v.number(),
    importance: v.number(),
    filterValues: v.array(vNamedFilter),
    // To avoid re-creating/ updating the same entry
    contentHash: v.optional(v.string()),
    // conveneient metadata
    title: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
    status: vStatusWithOnComplete,
  })
    .index("namespaceId_status_key_version", [
      "namespaceId",
      "status.kind",
      "key",
      "version",
    ])
    // To look up most recently changed entries
    .index("status_namespaceId", ["status.kind", "namespaceId"]),
  content: defineTable({
    entryId: v.id("entries"),
    text: v.string(),
    metadata: v.optional(v.record(v.string(), v.any())),
    state: v.union(
      v.object({
        kind: v.literal("pending"),
        embedding: v.array(v.number()),
        importance: v.number(),
        pendingSearchableText: v.optional(v.string()),
      }),
      v.object({
        kind: v.literal("ready"),
        embeddingId: vVectorId,
        searchableText: v.optional(v.string()),
      }),
      v.object({
        kind: v.literal("replaced"),
        embeddingId: vVectorId,
        vector: v.array(v.number()),
        pendingSearchableText: v.optional(v.string()),
      }),
    ),
    ...vAllFilterFields,
  })
    .index("entryId", ["entryId"])
    .index("embeddingId", ["state.embeddingId"])
    .searchIndex("searchableText", {
      searchField: "state.searchableText",
      filterFields: allFilterFieldNames,
    }),

  ...embeddingsTables,
});

export const vv = typedV(schema);
export { vv as v };

export default schema;
