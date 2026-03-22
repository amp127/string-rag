import {
  embed,
  embedMany,
  generateText,
  type EmbeddingModel,
  type EmbeddingModelUsage,
  type ModelMessage,
} from "ai";
import { assert } from "convex-helpers";
import {
  createFunctionHandle,
  FunctionReference,
  internalActionGeneric,
  internalMutationGeneric,
  type FunctionArgs,
  type FunctionHandle,
  type FunctionReturnType,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type PaginationOptions,
  type PaginationResult,
  type RegisteredAction,
  type RegisteredMutation,
} from "convex/server";
import { type Value } from "convex/values";
import { ComponentApi } from "../component/_generated/component.js";
import type { NamedFilter } from "../component/filters.js";
import {
  filterNamesContain,
  OnCompleteArgs,
  vBatchTextProcessorArgs,
  vContentProcessorArgs,
  vEntryId,
  vNamespaceId,
  vOnCompleteArgs,
  vSearchType,
  type BatchTextProcessorAction,
  type ContentProcessorAction,
  type CreateContentArgs,
  type Entry,
  type EntryFilter,
  type EntryId,
  type Namespace,
  type NamespaceId,
  type OnComplete,
  type OnCompleteNamespace,
  type SearchEntry,
  type SearchResult,
  type SearchType,
  type Status,
} from "../shared.js";

export { hybridRank } from "./hybridRank.js";
export { vEntryId, vNamespaceId, vSearchType };
export type {
  BatchTextProcessorAction,
  ContentProcessorAction,
  Entry,
  EntryId,
  NamespaceId,
  OnComplete,
  OnCompleteNamespace,
  SearchEntry,
  SearchResult,
  SearchType,
  Status,
};

export {
  vEntry,
  vOnCompleteArgs,
  vSearchEntry,
  vSearchResult,
  type EntryFilter,
  type VEntry,
  type VSearchEntry,
} from "../shared.js";
export {
  contentHashFromArrayBuffer,
  guessMimeTypeFromContents,
  guessMimeTypeFromExtension,
} from "./fileUtils.js";

const DEFAULT_SEARCH_LIMIT = 10;

/** Max entries per addMany/deleteMany to stay within Convex mutation limits. */
export const DEFAULT_ADD_MANY_BATCH_SIZE = 100;

type DoEmbedResult = {
  embeddings: number[][];
  usage?: { tokens: number };
};

export type BatchTextProcessorOutput = { content: CreateContentArgs };

/**
 * Embed a single value via the AI SDK's `embed` (one request).
 */
async function embedSafe(params: {
  model: EmbeddingModel;
  value: string;
}): Promise<{ embedding: number[]; usage?: EmbeddingModelUsage }> {
  const { embedding, usage } = await embed({
    model: params.model,
    value: params.value,
  });
  return {
    embedding: Array.isArray(embedding) ? embedding : Array.from(embedding),
    usage,
  };
}

/**
 * Embed multiple values: uses the model's `doEmbed` when present, otherwise
 * `embedMany` so the provider gets one batched request (with chunking if the
 * model has per-call limits) instead of N parallel `embed` calls.
 */
async function embedManySafe(params: {
  model: EmbeddingModel;
  values: string[];
}): Promise<{
  embeddings: number[][];
  usage?: EmbeddingModelUsage;
}> {
  const { model, values } = params;
  if (values.length === 0) {
    return { embeddings: [], usage: { tokens: 0 } };
  }
  if (typeof model === "object" && model !== null && "doEmbed" in model) {
    const result = await (
      model as { doEmbed(options: { values: string[] }): PromiseLike<DoEmbedResult> }
    ).doEmbed({ values });
    return {
      embeddings: result.embeddings,
      usage: result.usage ?? { tokens: 0 },
    };
  }
  const { embeddings, usage } = await embedMany({ model, values });
  return {
    embeddings: embeddings.map((e) =>
      Array.isArray(e) ? e : Array.from(e),
    ),
    usage,
  };
}

// This is 0-1 with 1 being the most important and 0 being totally irrelevant.
// Used for vector search weighting.
type Importance = number;

export class StringRAG<
  FitlerSchemas extends Record<string, Value> = Record<string, Value>,
  EntryMetadata extends Record<string, Value> = Record<string, Value>,
> {
  /**
   * A component to use for Retrieval-Augmented Generation.
   * Create one for each model and embedding dimension you want to use.
   * When migrating between models / embedding lengths, create multiple
   * instances and do your `add`s with the appropriate instance, and searches
   * against the appropriate instance to get results with those parameters.
   *
   * The filterNames need to match the names of the filters you provide when
   * adding and when searching. Use the type parameter to make this type safe.
   * Order matters: it defines which internal slot each name maps to (filter0,
   * filter1, …). Keep the same order for a given namespace; see docs/filters.md.
   *
   * The second type parameter makes the entry metadata type safe. E.g. you can
   * do rag.add(ctx, {
   *   namespace: "my-namespace",
   *   metadata: {
   *     source: "website" as const,
   *   },
   * })
   * and then entry results will have the metadata type `{ source: "website" }`.
   */
  constructor(
    public component: ComponentApi,
    public options: {
      embeddingDimension: number;
      textEmbeddingModel: EmbeddingModel;
      /** Ordered list of filter names for this RAG. Order is fixed per namespace (see docs/filters.md). */
      filterNames?: FilterNames<FitlerSchemas>;
    },
  ) {}

  /**
   * Add an entry to the store. The text is embedded with the default model
   * and stored as a single content row.
   *
   * If you provide a key, it will replace an existing entry with the same key.
   * If you don't provide a key, it will always create a new entry.
   * If you provide a contentHash, it will deduplicate the entry if it already exists.
   * The filterValues you provide can be used later to search for it.
   */
  async add(
    ctx: CtxWith<"runMutation">,
    args: NamespaceSelection &
      EntryArgs<FitlerSchemas, EntryMetadata> &
      (
        | {
            /** Text to embed and store. */
            text: string;
            content?: undefined;
          }
        | {
            /** Pre-computed content with embedding (e.g. from your own embedder). */
            content: CreateContentArgs;
            text?: undefined;
          }
      ),
  ): Promise<{
    entryId: EntryId;
    status: Status;
    created: boolean;
    replacedEntry: Entry<FitlerSchemas, EntryMetadata> | null;
    usage: EmbeddingModelUsage;
  }> {
    let namespaceId: NamespaceId;
    if ("namespaceId" in args) {
      namespaceId = args.namespaceId;
    } else {
      const namespace = await this.getOrCreateNamespace(ctx, {
        namespace: args.namespace,
        status: "ready",
      });
      namespaceId = namespace.namespaceId;
    }

    validateAddFilterValues(args.filterValues, this.options.filterNames);

    let contentArg: CreateContentArgs;
    const totalUsage: EmbeddingModelUsage = { tokens: 0 };
    if (args.content) {
      contentArg = args.content;
    } else {
      const embedResult = await embedSafe({
        model: this.options.textEmbeddingModel,
        value: args.text,
      });
      totalUsage.tokens += embedResult.usage?.tokens ?? 0;
      contentArg = {
        content: { text: args.text },
        embedding: embedResult.embedding,
        searchableText: args.text,
      };
    }

    const onComplete =
      args.onComplete && (await createFunctionHandle(args.onComplete));

    const { entryId, status, created } = await ctx.runMutation(
      this.component.entries.add,
      {
        entry: {
          key: args.key,
          namespaceId,
          title: args.title,
          metadata: args.metadata,
          filterValues: args.filterValues ?? [],
          importance: args.importance ?? 1,
          contentHash: args.contentHash,
        },
        onComplete,
        content: contentArg,
      },
    );
    if (status === "ready") {
      return {
        entryId: entryId as EntryId,
        status,
        created,
        replacedEntry: null,
        usage: totalUsage,
      };
    }

    const replaceResult = await ctx.runMutation(
      this.component.content.replaceContent,
      { entryId },
    );
    if (replaceResult.status === "replaced") {
      return {
        entryId: entryId as EntryId,
        status: "replaced" as const,
        created: false,
        replacedEntry: null,
        usage: totalUsage,
      };
    }

    const promoted = await ctx.runMutation(
      this.component.entries.promoteToReady,
      { entryId },
    );
    return {
      entryId: entryId as EntryId,
      status: "ready" as const,
      replacedEntry: promoted.replacedEntry as Entry<
        FitlerSchemas,
        EntryMetadata
      > | null,
      created: true,
      usage: totalUsage,
    };
  }

  /**
   * Add multiple entries to the store in one namespace with a single
   * namespace lookup and a single batch embedding call when using text.
   * Reduces function calls and database bandwidth compared to calling
   * `add` repeatedly. Limited to one namespace; all items use the same
   * namespace. Batch size is capped at `DEFAULT_ADD_MANY_BATCH_SIZE`.
   *
   * Each item can have `text` (embedded in one batch) or pre-computed
   * `content`. Optional `onComplete` per item is supported.
   */
  async addMany(
    ctx: CtxWith<"runMutation">,
    args: (NamespaceSelection & { maxBatchSize?: number }) & {
      items: Array<
        EntryArgs<FitlerSchemas, EntryMetadata> &
          (
            | { text: string; content?: undefined }
            | { content: CreateContentArgs; text?: undefined }
          ) & { onComplete?: OnComplete }
      >;
    },
  ): Promise<{
    entryIds: EntryId[];
    statuses: Status[];
    created: boolean[];
    replacedEntries: (Entry<FitlerSchemas, EntryMetadata> | null)[];
    usage: EmbeddingModelUsage;
  }> {
    if (args.items.length === 0) {
      return {
        entryIds: [],
        statuses: [],
        created: [],
        replacedEntries: [],
        usage: { tokens: 0 },
      };
    }
    const maxBatchSize =
      args.maxBatchSize ?? DEFAULT_ADD_MANY_BATCH_SIZE;
    if (args.items.length > maxBatchSize) {
      throw new Error(
        `addMany: items length ${args.items.length} exceeds maxBatchSize ${maxBatchSize}. Split into smaller batches.`,
      );
    }

    let namespaceId: NamespaceId;
    if ("namespaceId" in args) {
      namespaceId = args.namespaceId;
    } else {
      const namespace = await this.getOrCreateNamespace(ctx, {
        namespace: args.namespace,
        status: "ready",
      });
      namespaceId = namespace.namespaceId;
    }

    for (const item of args.items) {
      validateAddFilterValues(item.filterValues, this.options.filterNames);
    }

    const textsToEmbed = args.items
      .map((item) => ("text" in item && item.text !== undefined ? item.text : null))
      .filter((t): t is string => t !== null);
    let embedResult: { embeddings: number[][]; usage?: EmbeddingModelUsage } = {
      embeddings: [],
      usage: { tokens: 0 },
    };
    if (textsToEmbed.length > 0) {
      embedResult = await embedManySafe({
        model: this.options.textEmbeddingModel,
        values: textsToEmbed,
      });
    }
    let embedIndex = 0;
    const contentArgs: (CreateContentArgs | undefined)[] = args.items.map(
      (item) => {
        if (item.content) return item.content;
        if ("text" in item && item.text !== undefined) {
          const embedding = embedResult.embeddings[embedIndex];
          if (!embedding) {
            throw new Error("embedMany returned fewer embeddings than texts");
          }
          embedIndex++;
          return {
            content: { text: item.text },
            embedding,
            searchableText: item.text,
          };
        }
        return undefined;
      },
    );

    const onCompleteHandles = await Promise.all(
      args.items.map((item) =>
        item.onComplete ? createFunctionHandle(item.onComplete) : undefined,
      ),
    );

    const itemsForMutation = args.items.map((item, i) => ({
      entry: {
        key: item.key,
        title: item.title,
        metadata: item.metadata,
        filterValues: item.filterValues ?? [],
        importance: item.importance ?? 1,
        contentHash: item.contentHash,
      },
      content: contentArgs[i],
      onComplete: onCompleteHandles[i],
    }));

    const addManyRef = this.component.entries as unknown as Record<
      string,
      FunctionReference<"mutation", "internal", any, any>
    >;
    const rawResult = (await ctx.runMutation(addManyRef.addMany, {
      namespaceId: namespaceId as unknown as string,
      items: itemsForMutation,
    })) as {
      entryIds: string[];
      statuses: Status[];
      created: boolean[];
    };

    return {
      entryIds: rawResult.entryIds as EntryId[],
      statuses: rawResult.statuses,
      created: rawResult.created,
      replacedEntries: rawResult.entryIds.map(() => null) as (Entry<
        FitlerSchemas,
        EntryMetadata
      > | null)[],
      usage: { tokens: embedResult.usage?.tokens ?? 0 },
    };
  }

  /**
   * Add an entry to the store asynchronously.
   *
   * This is useful if you want to produce content in a separate process (e.g.
   * fetch and embed text). The contentProcessor is a function that returns
   * content for the entry. Pass as internal.foo.myContentProcessor
   * e.g.
   * ```ts
   * export const myContentProcessor = rag.defineContentProcessor(async (ctx, args) => {
   *   // ...
   *   return { content: await fetchAndEmbed(args.entry) };
   * });
   *
   * // in your mutation
   *   const entryId = await rag.addAsync(ctx, {
   *     key: "myfile.txt",
   *     namespace: "my-namespace",
   *     contentProcessor: internal.foo.myContentProcessor,
   *   });
   * ```
   */
  async addAsync(
    ctx: CtxWith<"runMutation">,
    args: NamespaceSelection &
      EntryArgs<FitlerSchemas, EntryMetadata> & {
        /**
         * A function that produces content for the entry (e.g. fetches and embeds text).
         * Pass as internal.foo.myContentProcessor
         * e.g.
         * ```ts
         * export const myContentProcessor = rag.defineContentProcessor(async (ctx, args) => {
         *   return { content: await fetchAndEmbed(args.entry) };
         * });
         * await rag.addAsync(ctx, { key: "doc", namespace: "ns", contentProcessor: internal.foo.myContentProcessor });
         * ```
         */
        contentProcessor: ContentProcessorAction;
      },
  ): Promise<{ entryId: EntryId; status: "ready" | "pending" }> {
    let namespaceId: NamespaceId;
    if ("namespaceId" in args) {
      namespaceId = args.namespaceId;
    } else {
      const namespace = await this.getOrCreateNamespace(ctx, {
        namespace: args.namespace,
        status: "ready",
      });
      namespaceId = namespace.namespaceId;
    }

    validateAddFilterValues(args.filterValues, this.options.filterNames);

    const onComplete = args.onComplete
      ? await createFunctionHandle(args.onComplete)
      : undefined;
    const contentProcessor = await createFunctionHandle(args.contentProcessor);

    const { entryId, status } = await ctx.runMutation(
      this.component.entries.addAsync,
      {
        entry: {
          key: args.key,
          namespaceId,
          title: args.title,
          metadata: args.metadata,
          filterValues: args.filterValues ?? [],
          importance: args.importance ?? 1,
          contentHash: args.contentHash,
        },
        onComplete,
        contentProcessor,
      },
    );
    return { entryId: entryId as EntryId, status };
  }

  /**
   * Add multiple entries asynchronously via content processors. One namespace
   * lookup; each item is processed in the background by its contentProcessor.
   * Returns entry ids and statuses immediately; content is produced later.
   * Limited to one namespace. Batch size is capped at `DEFAULT_ADD_MANY_BATCH_SIZE`.
   */
  async addManyAsync(
    ctx: CtxWith<"runMutation">,
    args: (NamespaceSelection & { maxBatchSize?: number }) & {
      items: Array<
        EntryArgs<FitlerSchemas, EntryMetadata> & {
          contentProcessor: ContentProcessorAction;
          onComplete?: OnComplete;
        }
      >;
    },
  ): Promise<{
    entryIds: EntryId[];
    statuses: ("pending" | "ready")[];
    created: boolean[];
  }> {
    if (args.items.length === 0) {
      return { entryIds: [], statuses: [], created: [] };
    }
    const maxBatchSize =
      args.maxBatchSize ?? DEFAULT_ADD_MANY_BATCH_SIZE;
    if (args.items.length > maxBatchSize) {
      throw new Error(
        `addManyAsync: items length ${args.items.length} exceeds maxBatchSize ${maxBatchSize}. Split into smaller batches.`,
      );
    }

    let namespaceId: NamespaceId;
    if ("namespaceId" in args) {
      namespaceId = args.namespaceId;
    } else {
      const namespace = await this.getOrCreateNamespace(ctx, {
        namespace: args.namespace,
        status: "ready",
      });
      namespaceId = namespace.namespaceId;
    }

    for (const item of args.items) {
      validateAddFilterValues(item.filterValues, this.options.filterNames);
    }

    const onCompleteHandles = await Promise.all(
      args.items.map((item) =>
        item.onComplete ? createFunctionHandle(item.onComplete) : undefined,
      ),
    );
    const contentProcessorHandles = await Promise.all(
      args.items.map((item) => createFunctionHandle(item.contentProcessor)),
    );

    const itemsForMutation = args.items.map((item, i) => ({
      entry: {
        key: item.key,
        title: item.title,
        metadata: item.metadata,
        filterValues: item.filterValues ?? [],
        importance: item.importance ?? 1,
        contentHash: item.contentHash,
      },
      onComplete: onCompleteHandles[i],
      contentProcessor: contentProcessorHandles[i],
    }));

    const addManyAsyncRef = this.component.entries as unknown as Record<
      string,
      FunctionReference<"mutation", "internal", any, any>
    >;
    const rawResult = (await ctx.runMutation(addManyAsyncRef.addManyAsync, {
      namespaceId: namespaceId as unknown as string,
      items: itemsForMutation,
    })) as {
      entryIds: string[];
      statuses: ("pending" | "ready")[];
      created: boolean[];
    };

    return {
      entryIds: rawResult.entryIds as EntryId[],
      statuses: rawResult.statuses,
      created: rawResult.created,
    };
  }

  /**
   * Add many entries with **one workpool job**.
   * Your `batchTextProcessor` returns one full content object per entry (same
   * order as pending entries), matching `defineContentProcessor`.
   * Skips embedding for items that short-circuit as already-ready duplicates
   * (same as `addManyAsync`).
   */
  async addManyAsyncBatch(
    ctx: CtxWith<"runMutation">,
    args: (NamespaceSelection & { maxBatchSize?: number }) & {
      items: Array<
        EntryArgs<FitlerSchemas, EntryMetadata> & { onComplete?: OnComplete }
      >;
      batchTextProcessor: BatchTextProcessorAction;
    },
  ): Promise<{
    entryIds: EntryId[];
    statuses: ("pending" | "ready")[];
    created: boolean[];
  }> {
    if (args.items.length === 0) {
      return { entryIds: [], statuses: [], created: [] };
    }
    const maxBatchSize =
      args.maxBatchSize ?? DEFAULT_ADD_MANY_BATCH_SIZE;
    if (args.items.length > maxBatchSize) {
      throw new Error(
        `addManyAsyncBatch: items length ${args.items.length} exceeds maxBatchSize ${maxBatchSize}. Split into smaller batches.`,
      );
    }

    let namespaceId: NamespaceId;
    if ("namespaceId" in args) {
      namespaceId = args.namespaceId;
    } else {
      const namespace = await this.getOrCreateNamespace(ctx, {
        namespace: args.namespace,
        status: "ready",
      });
      namespaceId = namespace.namespaceId;
    }

    for (const item of args.items) {
      validateAddFilterValues(item.filterValues, this.options.filterNames);
    }

    const onCompleteHandles = await Promise.all(
      args.items.map((item) =>
        item.onComplete ? createFunctionHandle(item.onComplete) : undefined,
      ),
    );
    const batchTextProcessor = await createFunctionHandle(
      args.batchTextProcessor,
    );

    const itemsForMutation = args.items.map((item, i) => ({
      entry: {
        key: item.key,
        title: item.title,
        metadata: item.metadata,
        filterValues: item.filterValues ?? [],
        importance: item.importance ?? 1,
        contentHash: item.contentHash,
      },
      onComplete: onCompleteHandles[i],
    }));

    const addManyAsyncBatchRef = this.component.entries as unknown as Record<
      string,
      FunctionReference<"mutation", "internal", any, any>
    >;
    const rawResult = (await ctx.runMutation(
      addManyAsyncBatchRef.addManyAsyncBatch,
      {
        namespaceId: namespaceId as unknown as string,
        items: itemsForMutation,
        batchTextProcessor,
      },
    )) as {
      entryIds: string[];
      statuses: ("pending" | "ready")[];
      created: boolean[];
    };

    return {
      entryIds: rawResult.entryIds as EntryId[],
      statuses: rawResult.statuses,
      created: rawResult.created,
    };
  }

  /**
   * Search for entries in a namespace with configurable filters.
   * You can provide a query string or target embedding, as well as search
   * parameters to filter and constrain the results.
   */
  async search(
    ctx: CtxWith<"runAction">,
    args: {
      /**
       * The namespace to search in. e.g. a userId if entries are per-user.
       * Note: it will only match entries in the namespace that match the
       * modelId, embedding dimension, and filterNames of the StringRAG instance.
       */
      namespace: string;
      /**
       * The query to search for. Optional if embedding is provided.
       */
      query: string | Array<number>;
    } & SearchOptions<FitlerSchemas>,
  ): Promise<{
    results: SearchResult[];
    text: string;
    entries: SearchEntry<FitlerSchemas, EntryMetadata>[];
    usage: EmbeddingModelUsage;
  }> {
    const {
      namespace,
      filters = [],
      limit = DEFAULT_SEARCH_LIMIT,
      vectorScoreThreshold,
      searchType = "vector",
      textWeight,
      vectorWeight,
    } = args;

    const needsEmbedding = searchType !== "text";
    let needsTextQuery = searchType !== "vector";

    if (needsTextQuery && Array.isArray(args.query)) {
      if (searchType === "text") {
        throw new Error('searchType "text" requires a string query.');
      }
      console.warn(
        `searchType "${searchType}" requires a string query. Falling back to vector-only search for embedding array queries.`,
      );
      needsTextQuery = false;
    }

    let embedding: number[] | undefined;
    let usage: EmbeddingModelUsage = { tokens: 0 };
    if (needsEmbedding) {
      if (Array.isArray(args.query)) {
        embedding = args.query;
      } else {
        const embedResult = await embedSafe({
          model: this.options.textEmbeddingModel,
          value: args.query,
        });
        embedding = embedResult.embedding;
        usage = embedResult.usage ?? { tokens: 0 };
      }
    }

    const textQuery =
      needsTextQuery && typeof args.query === "string" ? args.query : undefined;

    const { results, entries } = await ctx.runAction(
      this.component.search.search,
      {
        embedding,
        dimension: this.options.embeddingDimension,
        namespace,
        modelId: getModelId(this.options.textEmbeddingModel),
        filters,
        limit,
        vectorScoreThreshold,
        textQuery,
        textWeight,
        vectorWeight,
      },
    );
    const entriesWithTexts = entries.map((e) => {
      const entryResults = results.filter((r) => r.entryId === e.entryId);
      const text = entryResults.map((r) => r.content.text).join("\n");
      return { ...e, text } as SearchEntry<FitlerSchemas, EntryMetadata>;
    });

    return {
      results: results as SearchResult[],
      text: entriesWithTexts
        .map((e) => (e.title ? `## ${e.title}:\n\n${e.text}` : e.text))
        .join(`\n\n---\n\n`),
      entries: entriesWithTexts,
      usage,
    };
  }

  /**
   * Search for entries similar to a given entry, using its stored embedding
   * vector directly. More efficient than `search` when you have an existing
   * entry, as it skips the embedding model API call entirely.
   *
   * Searches within the entry's own namespace using vector similarity only.
   * The source entry is automatically excluded from results.
   *
   * Returns empty `results` and `entries` when the entry does not exist, has
   * no content, or has no usable stored embedding yet.
   */
  async searchWithEntryId(
    ctx: CtxWith<"runAction">,
    args: {
      /** The entry to find similar entries for. */
      entryId: EntryId;
    } & Pick<
      SearchOptions<FitlerSchemas>,
      "filters" | "limit" | "vectorScoreThreshold"
    >,
  ): Promise<{
    results: SearchResult[];
    text: string;
    entries: SearchEntry<FitlerSchemas, EntryMetadata>[];
  }> {
    const {
      entryId,
      filters = [],
      limit = DEFAULT_SEARCH_LIMIT,
      vectorScoreThreshold,
    } = args;

    const { results, entries } = await ctx.runAction(
      this.component.search.searchWithEntryId,
      {
        entryId,
        filters,
        limit,
        vectorScoreThreshold,
      },
    );
    const entriesWithTexts = entries.map((e) => {
      const entryResults = results.filter((r) => r.entryId === e.entryId);
      const text = entryResults.map((r) => r.content.text).join("\n");
      return { ...e, text } as SearchEntry<FitlerSchemas, EntryMetadata>;
    });

    return {
      results: results as SearchResult[],
      text: entriesWithTexts
        .map((e) => (e.title ? `## ${e.title}:\n\n${e.text}` : e.text))
        .join(`\n\n---\n\n`),
      entries: entriesWithTexts,
    };
  }

  /**
   * Search for entries similar to the entry with the given key, using its
   * stored embedding. Like `searchWithEntryId` but identified by key so you
   * don't need to look up the entry first. Avoids the embedding process
   * entirely by using the existing vector.
   *
   * Searches within the entry's namespace. The source entry is excluded from
   * results. If no ready entry exists for the key or it has no usable embedding,
   * returns empty `results` and `entries`.
   */
  async searchSimilar(
    ctx: CtxWith<"runAction">,
    args: {
      /** The namespace to search in (e.g. a userId). */
      namespace: string;
      /** The key of the entry to find similar entries for. */
      key: string;
    } & Pick<
      SearchOptions<FitlerSchemas>,
      "filters" | "limit" | "vectorScoreThreshold"
    >,
  ): Promise<{
    results: SearchResult[];
    text: string;
    entries: SearchEntry<FitlerSchemas, EntryMetadata>[];
  }> {
    const {
      namespace,
      key,
      filters = [],
      limit = DEFAULT_SEARCH_LIMIT,
      vectorScoreThreshold,
    } = args;

    const { results, entries } = await ctx.runAction(
      this.component.search.searchSimilar,
      {
        namespace,
        key,
        modelId: getModelId(this.options.textEmbeddingModel),
        dimension: this.options.embeddingDimension,
        filters,
        limit,
        vectorScoreThreshold,
      },
    );
    const entriesWithTexts = entries.map((e) => {
      const entryResults = results.filter((r) => r.entryId === e.entryId);
      const text = entryResults.map((r) => r.content.text).join("\n");
      return { ...e, text } as SearchEntry<FitlerSchemas, EntryMetadata>;
    });

    return {
      results: results as SearchResult[],
      text: entriesWithTexts
        .map((e) => (e.title ? `## ${e.title}:\n\n${e.text}` : e.text))
        .join(`\n\n---\n\n`),
      entries: entriesWithTexts,
    };
  }

  /**
   * Generate text based on Retrieval-Augmented Generation.
   *
   * This will search for entries in the namespace based on the prompt and use
   * the results as context to generate text, using the search options args.
   * You can override the default "system" message to provide instructions on
   * using the context and answering in the appropriate style.
   * You can provide "messages" in addition to the prompt to provide
   * extra context / conversation history.
   */
  async generateText(
    ctx: CtxWith<"runAction">,
    args: {
      /**
       * The search options to use for context search, including the namespace.
       */
      search: SearchOptions<FitlerSchemas> & {
        /**
         * The namespace to search in. e.g. a userId if entries are per-user.
         */
        namespace: string;
        /**
         * The text or embedding to search for. If provided, it will be used
         * instead of the prompt for vector search.
         */
        query?: string | Array<number>;
      };
      /**
       * Required. The prompt to use for context search, as well as the final
       * message to the LLM when generating text.
       * Can be used along with "messages"
       */
      prompt: string;
      /**
       * Additional messages to add to the context. Can be provided in addition
       * to the prompt, in which case it will precede the prompt.
       */
      messages?: ModelMessage[];
    } & Parameters<typeof generateText>[0],
  ): Promise<
    Awaited<ReturnType<typeof generateText>> & {
      context: {
        results: SearchResult[];
        text: string;
        entries: SearchEntry<FitlerSchemas, EntryMetadata>[];
      };
    }
  > {
    const {
      search: { namespace, ...searchOpts },
      prompt,
      ...aiSdkOpts
    } = args;
    const context = await this.search(ctx, {
      namespace,
      query: prompt,
      ...searchOpts,
    });
    let contextHeader =
      "Use the following context to respond to the user's question:\n";
    let contextContents = context.text;
    let contextFooter = "\n--------------------------------\n";
    let userQuestionHeader = "";
    let userQuestionFooter = "";
    let userPrompt = prompt;
    switch (getModelCategory(aiSdkOpts.model)) {
      case "openai":
        userQuestionHeader = '**User question:**\n"""';
        userQuestionFooter = '"""';
        break;
      case "meta":
        userQuestionHeader = "**User question:**\n";
        break;
      case "google":
        userQuestionHeader = "<question>";
        userQuestionFooter = "</question>";
        contextHeader = "<context>";
        contextContents = context.entries
          .map((e) =>
            e.title
              ? `<document title="${e.title}">${e.text}</document>`
              : `<document>${e.text}</document>`,
          )
          .join("\n");
        contextFooter = "</context>";
        userPrompt = prompt.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        break;
      case "anthropic":
        contextHeader = "<context>";
        contextContents = context.entries
          .map((e) =>
            e.title
              ? `<document title="${e.title}">${e.text}</document>`
              : `<document>${e.text}</document>`,
          )
          .join("\n");
        contextFooter = "</context>";
        userPrompt = prompt.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        break;
      default:
    }
    const promptWithContext = [
      contextHeader,
      contextContents,
      contextFooter,
      "\n",
      userQuestionHeader,
      userPrompt,
      userQuestionFooter,
    ]
      .join("\n")
      .trim();

    const result = (await generateText({
      system:
        "You use the context provided only to produce a response. Do not preface the response with acknowledgement of the context.",
      ...aiSdkOpts,
      messages: [
        ...(args.messages ?? []),
        {
          role: "user",
          content: promptWithContext,
        },
      ],
    })) as Awaited<ReturnType<typeof generateText>> & {
      context: {
        results: SearchResult[];
        text: string;
        entries: SearchEntry<FitlerSchemas, EntryMetadata>[];
      };
    };
    result.context = context;
    return result;
  }

  /**
   * List all entries in a namespace.
   */
  async list(
    ctx: CtxWith<"runQuery">,
    args: {
      namespaceId?: NamespaceId;
      order?: "desc" | "asc";
      status?: Status;
    } & ({ paginationOpts: PaginationOptions } | { limit: number }),
  ): Promise<PaginationResult<Entry<FitlerSchemas, EntryMetadata>>> {
    const paginationOpts =
      "paginationOpts" in args
        ? args.paginationOpts
        : { cursor: null, numItems: args.limit };
    const results = await ctx.runQuery(this.component.entries.list, {
      namespaceId: args.namespaceId,
      paginationOpts,
      order: args.order ?? "asc",
      status: args.status ?? "ready",
    });
    return results as PaginationResult<Entry<FitlerSchemas, EntryMetadata>>;
  }

  /**
   * Get entry metadata by its id.
   */
  async getEntry(
    ctx: CtxWith<"runQuery">,
    args: {
      entryId: EntryId;
    },
  ): Promise<Entry<FitlerSchemas, EntryMetadata> | null> {
    const entry = await ctx.runQuery(this.component.entries.get, {
      entryId: args.entryId,
    });
    return entry as Entry<FitlerSchemas, EntryMetadata> | null;
  }

  /**
   * Get multiple entries by id in one query. Reduces round-trips when
   * loading many entries. Returns null for missing entry ids.
   */
  async getEntries(
    ctx: CtxWith<"runQuery">,
    args: { entryIds: EntryId[] },
  ): Promise<(Entry<FitlerSchemas, EntryMetadata> | null)[]> {
    if (args.entryIds.length === 0) return [];
    const entriesRef = this.component.entries as unknown as Record<
      string,
      FunctionReference<"query", "internal", any, any>
    >;
    const result = (await ctx.runQuery(entriesRef.getMany, {
      entryIds: args.entryIds as unknown as string[],
    })) as (Entry<FitlerSchemas, EntryMetadata> | null)[];
    return result;
  }

  /**
   * Find an existing entry by its content hash, which you can use to copy
   * new results into a new entry when migrating, or avoiding duplicating work
   * when updating content.
   */
  async findEntryByContentHash(
    ctx: CtxWith<"runQuery">,
    args: {
      namespace: string;
      key: string;
      /** The hash of the entry contents to try to match. */
      contentHash: string;
    },
  ): Promise<Entry<FitlerSchemas, EntryMetadata> | null> {
    const entry = await ctx.runQuery(this.component.entries.findByContentHash, {
      namespace: args.namespace,
      dimension: this.options.embeddingDimension,
      filterNames: this.options.filterNames ?? [],
      modelId: getModelId(this.options.textEmbeddingModel),
      key: args.key,
      contentHash: args.contentHash,
    });
    return entry as Entry<FitlerSchemas, EntryMetadata> | null;
  }

  /**
   * Get a namespace that matches the modelId, embedding dimension, and
   * filterNames of the StringRAG instance. If it doesn't exist, it will be created.
   */
  async getOrCreateNamespace(
    ctx: CtxWith<"runMutation">,
    args: {
      /**
       * The namespace to get or create. e.g. a userId if entries are per-user.
       */
      namespace: string;
      /**
       * If it isn't in existence, what the new namespace status should be.
       */
      status?: "pending" | "ready";
      /**
       * This will be called when then namespace leaves the "pending" state.
       * Either if the namespace is created or if the namespace is replaced
       * along the way.
       */
      onComplete?: OnCompleteNamespace;
    },
  ): Promise<{
    namespaceId: NamespaceId;
    status: "pending" | "ready";
  }> {
    const onComplete = args.onComplete
      ? await createFunctionHandle(args.onComplete)
      : undefined;
    assert(
      !onComplete || args.status === "pending",
      "You can only supply an onComplete handler for pending namespaces",
    );
    const { namespaceId, status } = await ctx.runMutation(
      this.component.namespaces.getOrCreate,
      {
        namespace: args.namespace,
        status: args.status ?? "ready",
        onComplete,
        modelId: getModelId(this.options.textEmbeddingModel),
        dimension: this.options.embeddingDimension,
        filterNames: this.options.filterNames ?? [],
      },
    );
    return { namespaceId: namespaceId as NamespaceId, status };
  }

  /**
   * Get a namespace that matches the modelId, embedding dimension, and
   * filterNames of the StringRAG instance. If it doesn't exist, it will return null.
   */
  async getNamespace(
    ctx: CtxWith<"runQuery">,
    args: {
      namespace: string;
    },
  ): Promise<Namespace | null> {
    return ctx.runQuery(this.component.namespaces.get, {
      namespace: args.namespace,
      modelId: getModelId(this.options.textEmbeddingModel),
      dimension: this.options.embeddingDimension,
      filterNames: this.options.filterNames ?? [],
    }) as Promise<Namespace | null>;
  }

  /**
   * Delete an entry and its content in the background using a workpool.
   */
  async deleteAsync(ctx: CtxWith<"runMutation">, args: { entryId: EntryId }) {
    await ctx.runMutation(this.component.entries.deleteAsync, {
      entryId: args.entryId,
    });
  }

  /**
   * Delete multiple entries and their content in one mutation. Reduces
   * function calls and database bandwidth compared to calling `deleteAsync`
   * or `delete` repeatedly.
   */
  async deleteMany(
    ctx: CtxWith<"runMutation">,
    args: { entryIds: EntryId[] },
  ): Promise<void> {
    if (args.entryIds.length === 0) return;
    const deleteManyRef = this.component.entries as unknown as Record<
      string,
      FunctionReference<"mutation", "internal", any, any>
    >;
    await ctx.runMutation(deleteManyRef.deleteMany, {
      entryIds: args.entryIds as unknown as string[],
    });
  }

  /**
   * Schedule deletion of multiple entries in the background. One mutation
   * enqueues a delete job per entry; actual deletes run asynchronously.
   * Use when you want to avoid a long-running mutation.
   */
  async deleteManyAsync(
    ctx: CtxWith<"runMutation">,
    args: { entryIds: EntryId[] },
  ): Promise<void> {
    if (args.entryIds.length === 0) return;
    const deleteManyAsyncRef = this.component.entries as unknown as Record<
      string,
      FunctionReference<"mutation", "internal", any, any>
    >;
    await ctx.runMutation(deleteManyAsyncRef.deleteManyAsync, {
      entryIds: args.entryIds as unknown as string[],
    });
  }

  /**
   * Delete entries in `replaced` status for a namespace in the background.
   * Uses the workpool: each job removes up to 10 entries and chains until none
   * remain.
   */
  async cleanupReplacedEntriesAsync(
    ctx: CtxWith<"runMutation">,
    args: { namespaceId: NamespaceId },
  ): Promise<void> {
    const ref = this.component.entries as unknown as Record<
      string,
      FunctionReference<"mutation", "internal", any, any>
    >;
    await ctx.runMutation(ref.cleanupReplacedEntriesAsync, {
      namespaceId: args.namespaceId as unknown as string,
    });
  }

  /**
   * Delete an entry and its content (synchronously).
   * If you are getting warnings about `ctx` not being compatible,
   * you're likely running this in a mutation.
   * Use `deleteAsync` or run `delete` in an action.
   */
  async delete(
    ctx: CtxWith<"runAction">,
    args: { entryId: EntryId },
  ): Promise<void>;
  /** @deprecated Use `deleteAsync` in mutations. */
  async delete(
    ctx: CtxWith<"runMutation">,
    args: { entryId: EntryId },
  ): Promise<void>;
  async delete(
    ctx: CtxWith<"runMutation"> | CtxWith<"runAction">,
    args: { entryId: EntryId },
  ) {
    if ("runAction" in ctx) {
      await ctx.runAction(this.component.entries.deleteSync, {
        entryId: args.entryId,
      });
    } else {
      console.warn(
        "You are running `rag.delete` in a mutation. This is deprecated. Use `rag.deleteAsync` from mutations, or `rag.delete` in actions.",
      );
      await ctx.runMutation(this.component.entries.deleteAsync, {
        entryId: args.entryId,
      });
    }
  }

  /**
   * Delete all entries with a given key (asynchrounously).
   */
  async deleteByKeyAsync(
    ctx: CtxWith<"runMutation">,
    args: { namespaceId: NamespaceId; key: string; beforeVersion?: number },
  ) {
    await ctx.runMutation(this.component.entries.deleteByKeyAsync, {
      namespaceId: args.namespaceId,
      key: args.key,
      beforeVersion: args.beforeVersion,
    });
  }

  /**
   * Delete all entries with a given key (synchronously).
   * If you are getting warnings about `ctx` not being compatible,
   * you're likely running this in a mutation.
   * Use `deleteByKeyAsync` or run `delete` in an action.
   */
  async deleteByKey(
    ctx: CtxWith<"runAction">,
    args: { namespaceId: NamespaceId; key: string; beforeVersion?: number },
  ) {
    await ctx.runAction(this.component.entries.deleteByKeySync, args);
  }

  /**
   * Define a function that can be provided to the `onComplete` parameter of
   * `add` or `addAsync` like:
   * ```ts
   * const onComplete = rag.defineOnComplete(async (ctx, args) => {
   *   // ...
   * });
   *
   * // in your mutation
   *   await rag.add(ctx, {
   *     namespace: "my-namespace",
   *     onComplete: internal.foo.onComplete,
   *   });
   * ```
   * It will be called when the entry is no longer "pending".
   * This is usually when it's "ready" but it can be "replaced" if a newer
   * entry is ready before this one.
   */
  defineOnComplete<DataModel extends GenericDataModel>(
    fn: (
      ctx: GenericMutationCtx<DataModel>,
      args: OnCompleteArgs<FitlerSchemas, EntryMetadata>,
    ) => Promise<void>,
  ): RegisteredMutation<"internal", FunctionArgs<OnComplete>, null> {
    return internalMutationGeneric({
      args: vOnCompleteArgs,
      handler: fn,
    });
  }

  /**
   * Define a function that can be provided to the `contentProcessor` parameter of
   * `addAsync`. It should produce content (e.g. fetch and embed text) and will
   * be called when the entry is added.
   */
  defineContentProcessor<DataModel extends GenericDataModel>(
    fn: (
      ctx: GenericActionCtx<DataModel>,
      args: {
        namespace: Namespace;
        entry: Entry<FitlerSchemas, EntryMetadata>;
      },
    ) => Promise<{ content: CreateContentArgs }>,
  ): RegisteredAction<
    "internal",
    FunctionArgs<ContentProcessorAction>,
    FunctionReturnType<ContentProcessorAction>
  > {
    return internalActionGeneric({
      args: vContentProcessorArgs,
      handler: async (ctx, args) => {
        const { namespace, entry } = args;
        const modelId = getModelId(this.options.textEmbeddingModel);
        if (namespace.modelId !== modelId) {
          console.error(
            `You are using a different embedding model ${modelId} for asynchronously ` +
              `generating content than the one provided when it was started: ${namespace.modelId}`,
          );
          return;
        }
        if (namespace.dimension !== this.options.embeddingDimension) {
          console.error(
            `You are using a different embedding dimension ${this.options.embeddingDimension} for asynchronously ` +
              `generating content than the one provided when it was started: ${namespace.dimension}`,
          );
          return;
        }
        if (
          !filterNamesContain(
            namespace.filterNames,
            this.options.filterNames ?? [],
          )
        ) {
          console.error(
            `You are using different filters (${this.options.filterNames?.join(", ")}) for asynchronously ` +
              `generating content than the one provided when it was started: ${namespace.filterNames.join(", ")}`,
          );
          return;
        }
        const { content } = await fn(ctx, {
          namespace,
          entry: entry as Entry<FitlerSchemas, EntryMetadata>,
        });
        await ctx.runMutation(
          args.insertContent as FunctionHandle<
            "mutation",
            FunctionArgs<ComponentApi["content"]["insert"]>,
            null
          >,
          {
            entryId: entry.entryId,
            content,
          },
        );
      },
    });
  }

  /**
   * Batch async add: return one item per entry (fetch/synthesize text).
   * Items return full content objects, same shape as `defineContentProcessor`.
   */
  defineBatchTextProcessor<DataModel extends GenericDataModel>(
    fn: (
      ctx: GenericActionCtx<DataModel>,
      args: {
        namespace: Namespace;
        entries: Entry<FitlerSchemas, EntryMetadata>[];
      },
    ) => Promise<BatchTextProcessorOutput[]>,
  ): RegisteredAction<
    "internal",
    FunctionArgs<BatchTextProcessorAction>,
    FunctionReturnType<BatchTextProcessorAction>
  > {
    return internalActionGeneric({
      args: vBatchTextProcessorArgs,
      handler: async (ctx, args) => {
        const { namespace, entries } = args;
        const modelId = getModelId(this.options.textEmbeddingModel);
        if (namespace.modelId !== modelId) {
          console.error(
            `You are using a different embedding model ${modelId} for batch async ` +
              `than the namespace: ${namespace.modelId}`,
          );
          return;
        }
        if (namespace.dimension !== this.options.embeddingDimension) {
          console.error(
            `You are using a different embedding dimension ${this.options.embeddingDimension} for batch async ` +
              `than the namespace: ${namespace.dimension}`,
          );
          return;
        }
        if (
          !filterNamesContain(
            namespace.filterNames,
            this.options.filterNames ?? [],
          )
        ) {
          console.error(
            `Filter names mismatch for batch async vs namespace.`,
          );
          return;
        }
        const outputs = await fn(ctx, {
          namespace,
          entries: entries as Entry<FitlerSchemas, EntryMetadata>[],
        });
        if (outputs.length !== entries.length) {
          throw new Error(
            `batchTextProcessor must return ${entries.length} items, got ${outputs.length}`,
          );
        }
        if (outputs.length === 0) {
          return;
        }
        for (let i = 0; i < entries.length; i++) {
          const output = outputs[i];
          assert(output !== undefined, "output");
          const entry = entries[i];
          assert(entry !== undefined, "entry");
          await ctx.runMutation(
            args.insertContent as FunctionHandle<
              "mutation",
              FunctionArgs<ComponentApi["content"]["insert"]>,
              null
            >,
            {
              entryId: entry.entryId,
              content: output.content,
            },
          );
        }
      },
    });
  }
}

/** @deprecated Use StringRAG instead. */
export { StringRAG as RAG };

function validateAddFilterValues(
  filterValues: NamedFilter[] | undefined,
  filterNames: string[] | undefined,
) {
  if (!filterValues) {
    return;
  }
  if (!filterNames?.length) {
    throw new Error(
      "You must provide filter names to StringRAG to add entries with filters.",
    );
  }
  const allowed = new Set(filterNames);
  const seen = new Set<string>();
  for (const filterValue of filterValues) {
    if (seen.has(filterValue.name)) {
      throw new Error(
        `You cannot provide the same filter name twice: ${filterValue.name}.`,
      );
    }
    if (!allowed.has(filterValue.name)) {
      throw new Error(
        `Filter name "${filterValue.name}" is not valid for this namespace. Valid names: ${filterNames.join(", ")}.`,
      );
    }
    seen.add(filterValue.name);
  }
  // Require a value for every filter name (no optional filters)
  for (const filterName of filterNames) {
    if (!seen.has(filterName)) {
      throw new Error(
        `Missing required filter value for "${filterName}". Provide values for all namespace filters: ${filterNames.join(", ")}.`,
      );
    }
  }
}

type FilterNames<FiltersSchemas extends Record<string, Value>> =
  (keyof FiltersSchemas & string)[];

type NamespaceSelection =
  | {
      /**
       * A namespace is an isolated search space - no search can access entities
       * in other namespaces. Often this is used to segment user documents from
       * each other, but can be an arbitrary delineation. All filters apply
       * within a namespace.
       */
      namespace: string;
    }
  | {
      /**
       * The namespaceId, which is returned when creating a namespace
       * or looking it up.
       * There can be multiple namespaceIds for the same namespace, e.g.
       * one for each modelId, embedding dimension, and filterNames.
       * Each of them have a separate "status" and only one is ever "ready" for
       * any given "namespace" (e.g. a userId).
       */
      namespaceId: NamespaceId;
    };

type EntryArgs<
  FitlerSchemas extends Record<string, Value>,
  EntryMetadata extends Record<string, Value>,
> = {
  /**
   * This key allows replacing an existing entry by key.
   * Within a namespace, there will only be one "ready" entry per key.
   * When adding a new one, it will start as "pending" and after content
   * is added, it will be promoted to "ready".
   */
  key?: string | undefined;
  /**
   * The title of the entry. Used for default prompting to contextualize
   * the entry results. Also may be used for keyword search in the future.
   */
  title?: string;
  /**
   * Metadata about the entry that is not indexed or filtered or searched.
   * Provided as a convenience to store associated information, such as
   * the storageId or url to the source material.
   */
  metadata?: EntryMetadata;
  /**
   * Filters to apply to the entry. These can be OR'd together in search.
   * To represent AND logic, your filter can be an object or array with
   * multiple values. e.g. saving the result with:
   * `{ name: "categoryAndPriority", value: ["articles", "high"] }`
   * and searching with the same value will return entries that match that
   * value exactly.
   * Order of items in this array does not matter. You must provide a value
   * for every filter name on the namespace. See docs/filters.md.
   */
  filterValues?: EntryFilter<FitlerSchemas>[];
  /**
   * The importance of the entry. This is used to scale the vector search
   * score of the content.
   */
  importance?: Importance;
  /**
   * The hash of the entry contents. This is used to deduplicate entries.
   * You can look up existing entries by content hash within a namespace.
   * It will also return an existing entry if you add an entry with the
   * same content hash.
   */
  contentHash?: string;
  /**
   * A function that is called when the entry is added.
   */
  onComplete?: OnComplete;
};

type SearchOptions<FitlerSchemas extends Record<string, Value>> = {
  /**
   * Filters to apply to the search. These are OR'd together. To represent
   * AND logic, your filter can be an object or array with multiple values.
   * e.g. `[{ category: "articles" }, { priority: "high" }]` will return
   * entries that have "articles" category OR "high" priority.
   * `[{ category_priority: ["articles", "high"] }]` will return
   * entries that have "articles" category AND "high" priority.
   * This requires inserting the entries with these filter values exactly.
   * e.g. if you insert a entry with
   * `{ team_user: { team: "team1", user: "user1" } }`, it will not match
   * `{ team_user: { team: "team1" } }` but it will match
   * Order of items in this array does not matter. See docs/filters.md.
   */
  filters?: EntryFilter<FitlerSchemas>[];
  /**
   * The maximum number of results to fetch. Default is 10.
   */
  limit?: number;
  /**
   * The minimum score to return a result.
   */
  vectorScoreThreshold?: number;
  /**
   * The search mode to use.
   * - "vector": Vector similarity search only (default). Returns cosine
   *   similarity scores.
   * - "text": Full-text search only. No embedding is computed. Returns
   *   position-based scores.
   * - "hybrid": Combines vector and full-text search using Reciprocal Rank
   *   Fusion. Returns position-based scores (1.0 for top result, decreasing
   *   linearly).
   *
   * Text and hybrid modes require the query to be a string (not an embedding
   * array).
   */
  searchType?: SearchType;
  /**
   * Weight for text search results in hybrid ranking (RRF).
   * Higher values give more influence to text search matches.
   * Only used when searchType is "hybrid".
   * Default: 1
   */
  textWeight?: number;
  /**
   * Weight for vector search results in hybrid ranking (RRF).
   * Higher values give more influence to vector search matches.
   * Only used when searchType is "hybrid".
   * Default: 1
   */
  vectorWeight?: number;
};

function getModelCategory(model: string | { provider: string }) {
  if (typeof model !== "string") {
    return model.provider;
  }
  if (
    model.startsWith("openai") ||
    model.startsWith("gpt") ||
    model.startsWith("o1")
  ) {
    return "openai";
  }
  if (model.startsWith("anthropic") || model.startsWith("claude")) {
    return "anthropic";
  }
  if (model.startsWith("gemini") || model.startsWith("gemma")) {
    return "google";
  }
  if (model.startsWith("ollama")) {
    return "meta";
  }
  if (model.startsWith("grok")) {
    return "xai";
  }
  return model;
}

// fetch metadata from either a string or EmbeddingModelV2 or LanguageModelV2
export type ModelOrMetadata =
  | string
  | ({ provider: string } & ({ modelId: string } | { model: string }));

export function getModelId(embeddingModel: ModelOrMetadata): string {
  if (typeof embeddingModel === "string") {
    if (embeddingModel.includes("/")) {
      return embeddingModel.split("/").slice(1).join("/");
    }
    return embeddingModel;
  }
  return "modelId" in embeddingModel
    ? embeddingModel.modelId
    : embeddingModel.model;
}

export function getProviderName(embeddingModel: ModelOrMetadata): string {
  if (typeof embeddingModel === "string") {
    const part = embeddingModel.split("/").at(0);
    return part ?? embeddingModel;
  }
  return embeddingModel.provider;
}

type CtxWith<T extends "runQuery" | "runMutation" | "runAction"> = Pick<
  {
    runQuery: <Query extends FunctionReference<"query", "internal">>(
      query: Query,
      args: FunctionArgs<Query>,
    ) => Promise<FunctionReturnType<Query>>;
    runMutation: <Mutation extends FunctionReference<"mutation", "internal">>(
      mutation: Mutation,
      args: FunctionArgs<Mutation>,
    ) => Promise<FunctionReturnType<Mutation>>;
    runAction: <Action extends FunctionReference<"action", "internal">>(
      action: Action,
      args: FunctionArgs<Action>,
    ) => Promise<FunctionReturnType<Action>>;
  },
  T
>;
