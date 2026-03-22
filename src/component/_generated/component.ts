/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    content: {
      insert: FunctionReference<
        "mutation",
        "internal",
        {
          content: {
            content: { metadata?: Record<string, any>; text: string };
            embedding: Array<number>;
            searchableText?: string;
          };
          entryId: string;
          populateEmbeddingCache?: boolean;
        },
        { status: "pending" | "ready" | "replaced" },
        Name
      >;
      replaceContent: FunctionReference<
        "mutation",
        "internal",
        { entryId: string },
        { status: "pending" | "ready" | "replaced" },
        Name
      >;
    };
    entries: {
      add: FunctionReference<
        "mutation",
        "internal",
        {
          content?: {
            content: { metadata?: Record<string, any>; text: string };
            embedding: Array<number>;
            searchableText?: string;
          };
          entry: {
            contentHash?: string;
            filterValues: Array<{ name: string; value: any }>;
            importance: number;
            key?: string;
            metadata?: Record<string, any>;
            namespaceId: string;
            title?: string;
          };
          onComplete?: string;
          populateEmbeddingCache?: boolean;
        },
        {
          created: boolean;
          entryId: string;
          status: "pending" | "ready" | "replaced";
        },
        Name
      >;
      addAsync: FunctionReference<
        "mutation",
        "internal",
        {
          contentProcessor: string;
          entry: {
            contentHash?: string;
            filterValues: Array<{ name: string; value: any }>;
            importance: number;
            key?: string;
            metadata?: Record<string, any>;
            namespaceId: string;
            title?: string;
          };
          onComplete?: string;
        },
        { created: boolean; entryId: string; status: "pending" | "ready" },
        Name
      >;
      addMany: FunctionReference<
        "mutation",
        "internal",
        {
          items: Array<{
            content?: {
              content: { metadata?: Record<string, any>; text: string };
              embedding: Array<number>;
              searchableText?: string;
            };
            entry: {
              contentHash?: string;
              filterValues: Array<{ name: string; value: any }>;
              importance: number;
              key?: string;
              metadata?: Record<string, any>;
              title?: string;
            };
            onComplete?: string;
          }>;
          namespaceId: string;
          populateEmbeddingCache?: boolean;
        },
        {
          created: Array<boolean>;
          entryIds: Array<string>;
          statuses: Array<"pending" | "ready" | "replaced">;
        },
        Name
      >;
      addManyAsync: FunctionReference<
        "mutation",
        "internal",
        {
          items: Array<{
            contentProcessor: string;
            entry: {
              contentHash?: string;
              filterValues: Array<{ name: string; value: any }>;
              importance: number;
              key?: string;
              metadata?: Record<string, any>;
              title?: string;
            };
            onComplete?: string;
          }>;
          namespaceId: string;
        },
        {
          created: Array<boolean>;
          entryIds: Array<string>;
          statuses: Array<"pending" | "ready">;
        },
        Name
      >;
      addManyAsyncBatch: FunctionReference<
        "mutation",
        "internal",
        {
          batchTextProcessor: string;
          items: Array<{
            entry: {
              contentHash?: string;
              filterValues: Array<{ name: string; value: any }>;
              importance: number;
              key?: string;
              metadata?: Record<string, any>;
              title?: string;
            };
            onComplete?: string;
          }>;
          namespaceId: string;
        },
        {
          created: Array<boolean>;
          entryIds: Array<string>;
          statuses: Array<"pending" | "ready">;
        },
        Name
      >;
      cleanupReplacedEntriesAsync: FunctionReference<
        "mutation",
        "internal",
        { namespaceId: string },
        null,
        Name
      >;
      deleteAsync: FunctionReference<
        "mutation",
        "internal",
        { entryId: string },
        null,
        Name
      >;
      deleteByKeyAsync: FunctionReference<
        "mutation",
        "internal",
        { beforeVersion?: number; key: string; namespaceId: string },
        null,
        Name
      >;
      deleteByKeySync: FunctionReference<
        "action",
        "internal",
        { key: string; namespaceId: string },
        null,
        Name
      >;
      deleteMany: FunctionReference<
        "mutation",
        "internal",
        { entryIds: Array<string> },
        null,
        Name
      >;
      deleteManyAsync: FunctionReference<
        "mutation",
        "internal",
        { entryIds: Array<string> },
        null,
        Name
      >;
      deleteSync: FunctionReference<
        "action",
        "internal",
        { entryId: string },
        null,
        Name
      >;
      findByContentHash: FunctionReference<
        "query",
        "internal",
        {
          contentHash: string;
          dimension: number;
          filterNames: Array<string>;
          key: string;
          modelId: string;
          namespace: string;
        },
        {
          contentHash?: string;
          entryId: string;
          filterValues: Array<{ name: string; value: any }>;
          importance: number;
          key?: string;
          metadata?: Record<string, any>;
          replacedAt?: number;
          status: "pending" | "ready" | "replaced";
          title?: string;
        } | null,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { entryId: string },
        {
          contentHash?: string;
          entryId: string;
          filterValues: Array<{ name: string; value: any }>;
          importance: number;
          key?: string;
          metadata?: Record<string, any>;
          replacedAt?: number;
          status: "pending" | "ready" | "replaced";
          title?: string;
        } | null,
        Name
      >;
      getMany: FunctionReference<
        "query",
        "internal",
        { entryIds: Array<string> },
        Array<{
          contentHash?: string;
          entryId: string;
          filterValues: Array<{ name: string; value: any }>;
          importance: number;
          key?: string;
          metadata?: Record<string, any>;
          replacedAt?: number;
          status: "pending" | "ready" | "replaced";
          title?: string;
        } | null>,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          namespaceId?: string;
          order?: "desc" | "asc";
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          status: "pending" | "ready" | "replaced";
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            contentHash?: string;
            entryId: string;
            filterValues: Array<{ name: string; value: any }>;
            importance: number;
            key?: string;
            metadata?: Record<string, any>;
            replacedAt?: number;
            status: "pending" | "ready" | "replaced";
            title?: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      promoteToReady: FunctionReference<
        "mutation",
        "internal",
        { entryId: string },
        {
          replacedEntry: {
            contentHash?: string;
            entryId: string;
            filterValues: Array<{ name: string; value: any }>;
            importance: number;
            key?: string;
            metadata?: Record<string, any>;
            replacedAt?: number;
            status: "pending" | "ready" | "replaced";
            title?: string;
          } | null;
        },
        Name
      >;
    };
    namespaces: {
      deleteNamespace: FunctionReference<
        "mutation",
        "internal",
        { namespaceId: string },
        {
          deletedNamespace: null | {
            createdAt: number;
            dimension: number;
            filterNames: Array<string>;
            modelId: string;
            namespace: string;
            namespaceId: string;
            status: "pending" | "ready" | "replaced";
            version: number;
          };
        },
        Name
      >;
      deleteNamespaceSync: FunctionReference<
        "action",
        "internal",
        { namespaceId: string },
        null,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        {
          dimension: number;
          filterNames: Array<string>;
          modelId: string;
          namespace: string;
        },
        null | {
          createdAt: number;
          dimension: number;
          filterNames: Array<string>;
          modelId: string;
          namespace: string;
          namespaceId: string;
          status: "pending" | "ready" | "replaced";
          version: number;
        },
        Name
      >;
      getOrCreate: FunctionReference<
        "mutation",
        "internal",
        {
          dimension: number;
          filterNames: Array<string>;
          modelId: string;
          namespace: string;
          onComplete?: string;
          status: "pending" | "ready";
        },
        { namespaceId: string; status: "pending" | "ready" },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          status: "pending" | "ready" | "replaced";
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            createdAt: number;
            dimension: number;
            filterNames: Array<string>;
            modelId: string;
            namespace: string;
            namespaceId: string;
            status: "pending" | "ready" | "replaced";
            version: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      listNamespaceVersions: FunctionReference<
        "query",
        "internal",
        {
          namespace: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            createdAt: number;
            dimension: number;
            filterNames: Array<string>;
            modelId: string;
            namespace: string;
            namespaceId: string;
            status: "pending" | "ready" | "replaced";
            version: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      lookup: FunctionReference<
        "query",
        "internal",
        {
          dimension: number;
          filterNames: Array<string>;
          modelId: string;
          namespace: string;
        },
        null | string,
        Name
      >;
      promoteToReady: FunctionReference<
        "mutation",
        "internal",
        { namespaceId: string },
        {
          replacedNamespace: null | {
            createdAt: number;
            dimension: number;
            filterNames: Array<string>;
            modelId: string;
            namespace: string;
            namespaceId: string;
            status: "pending" | "ready" | "replaced";
            version: number;
          };
        },
        Name
      >;
    };
    search: {
      embeddingForEntry: FunctionReference<
        "query",
        "internal",
        { dimension: number; entryId: string; modelId: string },
        null | { embedding: Array<number> },
        Name
      >;
      search: FunctionReference<
        "action",
        "internal",
        {
          dimension?: number;
          embedding?: Array<number>;
          filters: Array<{ name: string; value: any }>;
          limit: number;
          modelId: string;
          namespace: string;
          searchType?: "vector" | "text" | "hybrid";
          textQuery?: string;
          textWeight?: number;
          vectorScoreThreshold?: number;
          vectorWeight?: number;
        },
        {
          entries: Array<{
            contentHash?: string;
            entryId: string;
            filterValues: Array<{ name: string; value: any }>;
            importance: number;
            key?: string;
            metadata?: Record<string, any>;
            replacedAt?: number;
            status: "pending" | "ready" | "replaced";
            title?: string;
          }>;
          results: Array<{
            content: { metadata?: Record<string, any>; text: string };
            entryId: string;
            score: number;
          }>;
        },
        Name
      >;
      searchSimilar: FunctionReference<
        "action",
        "internal",
        {
          dimension: number;
          filters: Array<{ name: string; value: any }>;
          key: string;
          limit: number;
          modelId: string;
          namespace: string;
          vectorScoreThreshold?: number;
        },
        {
          entries: Array<{
            contentHash?: string;
            entryId: string;
            filterValues: Array<{ name: string; value: any }>;
            importance: number;
            key?: string;
            metadata?: Record<string, any>;
            replacedAt?: number;
            status: "pending" | "ready" | "replaced";
            title?: string;
          }>;
          results: Array<{
            content: { metadata?: Record<string, any>; text: string };
            entryId: string;
            score: number;
          }>;
        },
        Name
      >;
      searchWithEntryId: FunctionReference<
        "action",
        "internal",
        {
          entryId: string;
          filters: Array<{ name: string; value: any }>;
          limit: number;
          vectorScoreThreshold?: number;
        },
        {
          entries: Array<{
            contentHash?: string;
            entryId: string;
            filterValues: Array<{ name: string; value: any }>;
            importance: number;
            key?: string;
            metadata?: Record<string, any>;
            replacedAt?: number;
            status: "pending" | "ready" | "replaced";
            title?: string;
          }>;
          results: Array<{
            content: { metadata?: Record<string, any>; text: string };
            entryId: string;
            score: number;
          }>;
        },
        Name
      >;
    };
  };
