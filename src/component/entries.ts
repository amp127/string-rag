import {
  vResultValidator,
  vWorkIdValidator,
  Workpool,
} from "@convex-dev/workpool";
import { assert, omit } from "convex-helpers";
import { mergedStream, stream } from "convex-helpers/server/stream";
import { doc } from "convex-helpers/validators";
import {
  createFunctionHandle,
  paginationOptsValidator,
  PaginationResult,
} from "convex/server";
import { v, type Infer, type Value } from "convex/values";
import type {
  BatchTextProcessorAction,
  ContentProcessorAction,
  EntryFilter,
  OnComplete,
} from "../shared.js";
import {
  statuses,
  vActiveStatus,
  vBatchTextProcessorArgs,
  vCreateContentArgs,
  vContentProcessorArgs,
  vEntry,
  vPaginationResult,
  vStatus,
  type Entry,
} from "../shared.js";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import {
  deleteContentHandler,
  insertContent,
  replaceContentHandler,
} from "./content.js";
import {
  getCompatibleNamespaceHandler,
  getPreviousEntry,
  publicEntry,
  publicNamespace,
  vNamespaceLookupArgs,
} from "./helpers.js";
import schema, { type StatusWithOnComplete } from "./schema.js";

const workpool = new Workpool(components.workpool, {
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 3,
    initialBackoffMs: 1000,
    base: 2,
  },
  maxParallelism: 10,
});

/** Entries deleted per workpool job when cleaning up replaced rows. */
const REPLACED_CLEANUP_BATCH_SIZE = 10;

/** Internal: add a single entry asynchronously via content processor. Used by addAsync and addManyAsync. */
async function addAsyncOneEntryHandler(
  ctx: MutationCtx,
  args: {
    entry: {
      namespaceId: Id<"namespaces">;
      key?: string;
      title?: string;
      metadata?: Record<string, Value>;
      importance: number;
      filterValues: EntryFilter[];
      contentHash?: string;
    };
    onComplete?: string;
    contentProcessor: string;
    insertContentHandle: string;
  },
): Promise<{
  entryId: Id<"entries">;
  status: "pending" | "ready";
  created: boolean;
}> {
  const { namespaceId, key } = args.entry;
  const namespace = await ctx.db.get(namespaceId);
  assert(namespace, `Namespace ${namespaceId} not found`);
  const existing = await findExistingEntry(ctx, namespaceId, key);
  if (
    existing?.status.kind === "ready" &&
    entryIsSame(existing, args.entry)
  ) {
    return {
      entryId: existing._id,
      status: existing.status.kind,
      created: false,
    };
  }
  const version = existing ? existing.version + 1 : 0;
  const status: StatusWithOnComplete = {
    kind: "pending",
    onComplete: args.onComplete,
  };
  const entryId = await ctx.db.insert("entries", {
    ...args.entry,
    version,
    status,
  });
  const contentProcessorAction = args.contentProcessor as unknown as ContentProcessorAction;
  await workpool.enqueueAction(
    ctx,
    contentProcessorAction,
    {
      namespace: publicNamespace(namespace),
      entry: publicEntry({
        ...args.entry,
        _id: entryId,
        status: status,
      }),
      insertContent: args.insertContentHandle,
    },
    {
      name: workpoolName(namespace.namespace, args.entry.key, entryId),
      onComplete: internal.entries.addAsyncOnComplete,
      context: entryId,
    },
  );
  return { entryId, status: status.kind, created: true };
}

/** Create pending entry for async add without enqueueing workpool (for batch path). */
async function addAsyncOneEntryPendingOnly(
  ctx: MutationCtx,
  args: {
    entry: {
      namespaceId: Id<"namespaces">;
      key?: string;
      title?: string;
      metadata?: Record<string, Value>;
      importance: number;
      filterValues: EntryFilter[];
      contentHash?: string;
    };
    onComplete?: string;
  },
): Promise<{
  entryId: Id<"entries">;
  status: "pending" | "ready";
  created: boolean;
  needsBatchWork: boolean;
}> {
  const { namespaceId, key } = args.entry;
  const namespace = await ctx.db.get(namespaceId);
  assert(namespace, `Namespace ${namespaceId} not found`);
  const existing = await findExistingEntry(ctx, namespaceId, key);
  if (
    existing?.status.kind === "ready" &&
    entryIsSame(existing, args.entry)
  ) {
    return {
      entryId: existing._id,
      status: existing.status.kind,
      created: false,
      needsBatchWork: false,
    };
  }
  const version = existing ? existing.version + 1 : 0;
  const status: StatusWithOnComplete = {
    kind: "pending",
    onComplete: args.onComplete,
  };
  const entryId = await ctx.db.insert("entries", {
    ...args.entry,
    version,
    status,
  });
  return {
    entryId,
    status: "pending",
    created: true,
    needsBatchWork: true,
  };
}

export const addAsync = mutation({
  args: {
    entry: v.object({
      ...omit(schema.tables.entries.validator.fields, ["version", "status"]),
    }),
    onComplete: v.optional(v.string()),
    contentProcessor: v.string(),
  },
  returns: v.object({
    entryId: v.id("entries"),
    status: vActiveStatus,
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{
    entryId: Id<"entries">;
    status: "pending" | "ready";
    created: boolean;
  }> => {
    const insertContentHandle: string = await createFunctionHandle(
      api.content.insert,
    );
    return addAsyncOneEntryHandler(ctx, {
      ...args,
      insertContentHandle,
    });
  },
});

function workpoolName(
  namespace: string,
  key: string | undefined,
  entryId: Id<"entries">,
) {
  return `rag-async-${namespace}-${key ? key + "-" + entryId : entryId}`;
}

/**
 * Test-only: returns a function handle for testContentProcessor so tests can
 * pass it to addManyAsync (which expects a string handle).
 */
export const getTestContentProcessorHandle = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (_ctx): Promise<string> => {
    const handle: string = await createFunctionHandle(
      internal.entries.testContentProcessor,
    );
    return handle;
  },
});

/**
 * Test-only: minimal content processor for addManyAsync tests. Inserts dummy
 * content (128-dim embedding, text "test"). Use internal.entries.testContentProcessor.
 */
export const testContentProcessor = internalAction({
  args: vContentProcessorArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const content = {
      content: { text: "test" },
      embedding: Array.from({ length: 128 }, () => 0.1),
      searchableText: "test",
    };
    await ctx.runMutation(
      args.insertContent as unknown as Parameters<
        ActionCtx["runMutation"]
      >[0],
      {
        entryId: args.entry.entryId,
        content,
      },
    );
    return null;
  },
});

/** Test-only: processes a full batch with one action (dummy content per entry). */
export const testBatchTextProcessor = internalAction({
  args: vBatchTextProcessorArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    for (const entry of args.entries) {
      const content = {
        content: { text: "batch-test" },
        embedding: Array.from({ length: 128 }, () => 0.15),
        searchableText: "batch-test",
      };
      await ctx.runMutation(
        args.insertContent as unknown as Parameters<
          ActionCtx["runMutation"]
        >[0],
        {
          entryId: entry.entryId as unknown as Id<"entries">,
          content,
        },
      );
    }
    return null;
  },
});

export const getTestBatchTextProcessorHandle = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (_ctx): Promise<string> => {
    return createFunctionHandle(internal.entries.testBatchTextProcessor);
  },
});

export const addAsyncBatchOnComplete = internalMutation({
  args: {
    workId: vWorkIdValidator,
    context: v.id("asyncBatchWork"),
    result: vResultValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const batch = await ctx.db.get(args.context);
    if (!batch) {
      console.error(
        `asyncBatchWork ${args.context} not found for batched async add onComplete`,
      );
      return null;
    }
    for (const entryId of batch.entryIds) {
      const entry = await ctx.db.get(entryId);
      if (!entry) continue;
      const namespace = await ctx.db.get(entry.namespaceId);
      assert(namespace, `Namespace ${entry.namespaceId} not found`);
      if (args.result.kind === "success") {
        const replaceStatus = await replaceContentHandler(ctx, entryId);
        if (replaceStatus !== "replaced") {
          await promoteToReadyHandler(ctx, { entryId });
        }
      } else if (
        entry.status.kind === "pending" &&
        entry.status.onComplete
      ) {
        await runOnComplete(
          ctx,
          entry.status.onComplete,
          namespace,
          entry,
          null,
          args.result.kind === "canceled" ? "Canceled" : args.result.error,
        );
      }
    }
    await ctx.db.delete(args.context);
    return null;
  },
});

export const addAsyncOnComplete = internalMutation({
  args: {
    workId: vWorkIdValidator,
    context: v.id("entries"),
    result: vResultValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entryId = args.context;
    const entry = await ctx.db.get(args.context);
    if (!entry) {
      console.error(
        `Entry ${args.context} not found when trying to complete content processor for async add`,
      );
      return;
    }
    if (args.result.kind === "success") {
      const replaceStatus = await replaceContentHandler(ctx, entryId);
      if (replaceStatus !== "replaced") {
        await promoteToReadyHandler(ctx, { entryId });
      }
    } else {
      // await deleteAsyncHandler(ctx, { entryId, startOrder: 0 });
      const namespace = await ctx.db.get(entry.namespaceId);
      assert(namespace, `Namespace ${entry.namespaceId} not found`);
      if (entry.status.kind === "pending" && entry.status.onComplete) {
        await runOnComplete(
          ctx,
          entry.status.onComplete,
          namespace,
          entry,
          null,
          args.result.kind === "canceled" ? "Canceled" : args.result.error,
        );
      }
    }
  },
});

type AddEntryArgs = Pick<
  Doc<"entries">,
  "key" | "contentHash" | "importance" | "filterValues"
>;

async function findExistingEntry(
  ctx: MutationCtx,
  namespaceId: Id<"namespaces">,
  key: string | undefined,
) {
  if (!key) {
    return null;
  }
  const existing = await mergedStream(
    statuses.map((status) =>
      stream(ctx.db, schema)
        .query("entries")
        .withIndex("namespaceId_status_key_version", (q) =>
          q
            .eq("namespaceId", namespaceId)
            .eq("status.kind", status)
            .eq("key", key),
        )
        .order("desc"),
    ),
    ["version"],
  ).first();
  return existing;
}

const vEntryWithoutVersionStatus = v.object({
  ...omit(schema.tables.entries.validator.fields, [
    "version",
    "status",
  ] as const),
});

/** Internal: add a single entry with optional content. Used by add and addMany. */
async function addOneEntryHandler(
  ctx: MutationCtx,
  args: {
    entry: {
      namespaceId: Id<"namespaces">;
      key?: string;
      title?: string;
      metadata?: Record<string, Value>;
      importance: number;
      filterValues: EntryFilter[];
      contentHash?: string;
    };
    onComplete?: string;
    content?: Infer<typeof vCreateContentArgs>;
  },
): Promise<{
  entryId: Id<"entries">;
  status: "pending" | "ready" | "replaced";
  created: boolean;
}> {
  const { namespaceId, key } = args.entry;
  const namespace = await ctx.db.get(namespaceId);
  assert(namespace, `Namespace ${namespaceId} not found`);
  const existing = await findExistingEntry(ctx, namespaceId, key);
  if (
    existing?.status.kind === "ready" &&
    entryIsSame(existing, args.entry)
  ) {
    return {
      entryId: existing._id,
      status: existing.status.kind,
      created: false,
    };
  }
  const version = existing ? existing.version + 1 : 0;
  const entryId = await ctx.db.insert("entries", {
    ...args.entry,
    version,
    status: { kind: "pending", onComplete: args.onComplete },
  });
  if (args.content) {
    const { status } = await insertContent(ctx, {
      entryId,
      content: args.content,
    });
    if (status === "ready") {
      await promoteToReadyHandler(ctx, { entryId });
    }
    return {
      entryId,
      status,
      created: true,
    };
  }
  return {
    entryId,
    status: "pending" as const,
    created: true,
  };
}

const vAddManyItemEntry = v.object({
  ...omit(schema.tables.entries.validator.fields, [
    "namespaceId",
    "version",
    "status",
  ] as const),
});

export const addMany = mutation({
  args: {
    namespaceId: v.id("namespaces"),
    items: v.array(
      v.object({
        entry: vAddManyItemEntry,
        onComplete: v.optional(v.string()),
        content: v.optional(vCreateContentArgs),
      }),
    ),
  },
  returns: v.object({
    entryIds: v.array(v.id("entries")),
    statuses: v.array(vStatus),
    created: v.array(v.boolean()),
  }),
  handler: async (ctx, args) => {
    const namespace = await ctx.db.get(args.namespaceId);
    assert(
      namespace,
      `Namespace ${args.namespaceId} not found for addMany`,
    );
    const entryIds: Id<"entries">[] = [];
    const statuses: ("pending" | "ready" | "replaced")[] = [];
    const created: boolean[] = [];
    for (const item of args.items) {
      const result = await addOneEntryHandler(ctx, {
        entry: { ...item.entry, namespaceId: args.namespaceId },
        onComplete: item.onComplete,
        content: item.content,
      });
      entryIds.push(result.entryId);
      statuses.push(result.status);
      created.push(result.created);
    }
    // Promote any pending entries (had content but previous entry existed).
    for (let i = 0; i < statuses.length; i++) {
      if (statuses[i] !== "pending") continue;
      const replaceStatus = await replaceContentHandler(ctx, entryIds[i]);
      if (replaceStatus === "replaced") {
        statuses[i] = "replaced";
        continue;
      }
      await promoteToReadyHandler(ctx, { entryId: entryIds[i] });
      statuses[i] = "ready";
    }
    return { entryIds, statuses, created };
  },
});

export const addManyAsync = mutation({
  args: {
    namespaceId: v.id("namespaces"),
    items: v.array(
      v.object({
        entry: vAddManyItemEntry,
        onComplete: v.optional(v.string()),
        contentProcessor: v.string(),
      }),
    ),
  },
  returns: v.object({
    entryIds: v.array(v.id("entries")),
    statuses: v.array(vActiveStatus),
    created: v.array(v.boolean()),
  }),
  handler: async (ctx, args) => {
    const namespace = await ctx.db.get(args.namespaceId);
    assert(
      namespace,
      `Namespace ${args.namespaceId} not found for addManyAsync`,
    );
    const insertContentHandle = await createFunctionHandle(api.content.insert);
    const entryIds: Id<"entries">[] = [];
    const statuses: ("pending" | "ready")[] = [];
    const created: boolean[] = [];
    for (const item of args.items) {
      const result = await addAsyncOneEntryHandler(ctx, {
        entry: { ...item.entry, namespaceId: args.namespaceId },
        onComplete: item.onComplete,
        contentProcessor: item.contentProcessor,
        insertContentHandle,
      });
      entryIds.push(result.entryId);
      statuses.push(result.status);
      created.push(result.created);
    }
    return { entryIds, statuses, created };
  },
});

/**
 * One workpool job for the whole batch. Use with a batch text processor that
 * returns texts in entry order; the client runs embedMany once then inserts all.
 */
export const addManyAsyncBatch = mutation({
  args: {
    namespaceId: v.id("namespaces"),
    items: v.array(
      v.object({
        entry: vAddManyItemEntry,
        onComplete: v.optional(v.string()),
      }),
    ),
    batchTextProcessor: v.string(),
  },
  returns: v.object({
    entryIds: v.array(v.id("entries")),
    statuses: v.array(vActiveStatus),
    created: v.array(v.boolean()),
  }),
  handler: async (ctx, args) => {
    const namespace = await ctx.db.get(args.namespaceId);
    assert(
      namespace,
      `Namespace ${args.namespaceId} not found for addManyAsyncBatch`,
    );
    const insertContentHandle = await createFunctionHandle(api.content.insert);
    const entryIds: Id<"entries">[] = [];
    const statuses: ("pending" | "ready")[] = [];
    const created: boolean[] = [];
    const batchEntryIds: Id<"entries">[] = [];
    for (const item of args.items) {
      const result = await addAsyncOneEntryPendingOnly(ctx, {
        entry: { ...item.entry, namespaceId: args.namespaceId },
        onComplete: item.onComplete,
      });
      entryIds.push(result.entryId);
      statuses.push(result.status);
      created.push(result.created);
      if (result.needsBatchWork) {
        batchEntryIds.push(result.entryId);
      }
    }
    if (batchEntryIds.length === 0) {
      return { entryIds, statuses, created };
    }
    const batchId = await ctx.db.insert("asyncBatchWork", {
      entryIds: batchEntryIds,
    });
    const entriesPayload = await Promise.all(
      batchEntryIds.map(async (id) => {
        const doc = await ctx.db.get(id);
        assert(doc, `Entry ${id} not found`);
        return publicEntry(doc);
      }),
    );
    const batchTextProcessorAction =
      args.batchTextProcessor as unknown as BatchTextProcessorAction;
    await workpool.enqueueAction(
      ctx,
      batchTextProcessorAction,
      {
        namespace: publicNamespace(namespace),
        entries: entriesPayload,
        insertContent: insertContentHandle,
      },
      {
        name: `rag-async-batch-${namespace.namespace}-${batchId}`,
        onComplete: internal.entries.addAsyncBatchOnComplete,
        context: batchId,
      },
    );
    return { entryIds, statuses, created };
  },
});

export const add = mutation({
  args: {
    entry: vEntryWithoutVersionStatus,
    onComplete: v.optional(v.string()),
    content: v.optional(vCreateContentArgs),
  },
  returns: v.object({
    entryId: v.id("entries"),
    status: vStatus,
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    return addOneEntryHandler(ctx, args);
  },
});

async function runOnComplete(
  ctx: MutationCtx,
  onComplete: string,
  namespace: Doc<"namespaces">,
  entry: Doc<"entries">,
  replacedEntry: Doc<"entries"> | null,
  error?: string,
) {
  await ctx.runMutation(onComplete as unknown as OnComplete, {
    namespace: publicNamespace(namespace),
    entry: publicEntry(entry),
    replacedEntry: replacedEntry ? publicEntry(replacedEntry) : undefined,
    error,
  });
}

function entryIsSame(existing: Doc<"entries">, newEntry: AddEntryArgs) {
  if (!existing.contentHash || !newEntry.contentHash) {
    return false;
  }
  if (existing.contentHash !== newEntry.contentHash) {
    return false;
  }
  if (existing.importance !== newEntry.importance) {
    return false;
  }
  if (newEntry.filterValues.length !== existing.filterValues.length) {
    return false;
  }
  if (
    !existing.filterValues.every((filter) =>
      newEntry.filterValues.some(
        (f) => f.name === filter.name && f.value === filter.value,
      ),
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Lists entries in order of their most recent change
 */
export const list = query({
  args: {
    namespaceId: v.optional(v.id("namespaces")),
    order: v.optional(v.union(v.literal("desc"), v.literal("asc"))),
    status: vStatus,
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vEntry),
  handler: async (ctx, args): Promise<PaginationResult<Entry>> => {
    const { namespaceId } = args;
    const results = await stream(ctx.db, schema)
      .query("entries")
      .withIndex("status_namespaceId", (q) =>
        namespaceId
          ? q.eq("status.kind", args.status).eq("namespaceId", namespaceId)
          : q.eq("status.kind", args.status),
      )
      .order(args.order ?? "asc")
      .paginate(args.paginationOpts);
    return {
      ...results,
      page: results.page.map(publicEntry),
    };
  },
});

/**
 * Gets a entry by its id.
 */
export const get = query({
  args: { entryId: v.id("entries") },
  returns: v.union(vEntry, v.null()),
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) {
      return null;
    }
    return publicEntry(entry);
  },
});

/**
 * Gets multiple entries by id in one query. Reduces round-trips when loading
 * many entries. Returns null for missing entry ids.
 */
export const getMany = query({
  args: { entryIds: v.array(v.id("entries")) },
  returns: v.array(v.union(vEntry, v.null())),
  handler: async (ctx, args): Promise<(Entry | null)[]> => {
    return Promise.all(
      args.entryIds.map(async (entryId) => {
        const entry = await ctx.db.get(entryId);
        if (!entry) return null;
        return publicEntry(entry);
      }),
    );
  },
});

/**
 * Finds a entry by its key and content hash.
 */
export const findByContentHash = query({
  args: {
    ...vNamespaceLookupArgs,
    key: v.string(),
    contentHash: v.string(),
  },
  returns: v.union(vEntry, v.null()),
  handler: async (ctx, args) => {
    const namespace = await getCompatibleNamespaceHandler(ctx, args);
    if (!namespace) {
      return null;
    }
    let attempts = 0;
    for await (const entry of mergedStream(
      statuses.map((status) =>
        stream(ctx.db, schema)
          .query("entries")
          .withIndex("namespaceId_status_key_version", (q) =>
            q
              .eq("namespaceId", namespace._id)
              .eq("status.kind", status)
              .eq("key", args.key),
          )
          .order("desc"),
      ),
      ["version"],
    )) {
      attempts++;
      if (attempts > 20) {
        console.debug(
          `Giving up after checking ${attempts} entries for ${args.key} content hash ${args.contentHash}, returning null`,
        );
        return null;
      }
      if (
        entryIsSame(entry, {
          key: args.key,
          contentHash: args.contentHash,
          filterValues: entry.filterValues,
          importance: entry.importance,
        })
      ) {
        return publicEntry(entry);
      }
    }
    return null;
  },
});

/**
 * Promotes a entry to ready, replacing any existing ready entry by key.
 * It will also call the associated onComplete function if it was pending.
 * Note: this will not replace the content automatically, so you should first
 * call `replaceContent` on its content.
 * Edge case: if the entry has already been replaced, it will return the
 * same entry (replacedEntry.entryId === args.entryId).
 */
export const promoteToReady = mutation({
  args: v.object({
    entryId: v.id("entries"),
  }),
  returns: v.object({
    replacedEntry: v.union(vEntry, v.null()),
  }),
  handler: promoteToReadyHandler,
});

async function promoteToReadyHandler(
  ctx: MutationCtx,
  args: { entryId: Id<"entries"> },
) {
  const entry = await ctx.db.get(args.entryId);
  assert(entry, `Entry ${args.entryId} not found`);
  const namespace = await ctx.db.get(entry.namespaceId);
  assert(namespace, `Namespace for ${entry.namespaceId} not found`);
  if (entry.status.kind === "ready") {
    console.debug(`Entry ${args.entryId} is already ready, skipping...`);
    return { replacedEntry: null };
  } else if (entry.status.kind === "replaced") {
    console.debug(
      `Entry ${args.entryId} is already replaced, returning the current version...`,
    );
    return { replacedEntry: publicEntry(entry) };
  }
  const previousEntry = await getPreviousEntry(ctx, entry);
  // First mark the previous entry as replaced,
  // so there are never two "ready" entries.
  if (previousEntry) {
    previousEntry.status = { kind: "replaced", replacedAt: Date.now() };
    await ctx.db.replace(previousEntry._id, previousEntry);
  }
  const previousStatus = entry.status;
  entry.status = { kind: "ready" };
  // Only then mark the current entry as ready,
  // so there are never two "ready" entries.
  await ctx.db.replace(args.entryId, entry);
  // Then run the onComplete function where it can observe itself as "ready".
  if (previousStatus.kind === "pending" && previousStatus.onComplete) {
    await runOnComplete(
      ctx,
      previousStatus.onComplete,
      namespace,
      entry,
      previousEntry,
    );
  }
  // Then mark all previous pending entries as replaced,
  // so they can observe the new entry and onComplete side-effects.
  if (entry.key) {
    const previousPendingEntries = await ctx.db
      .query("entries")
      .withIndex("namespaceId_status_key_version", (q) =>
        q
          .eq("namespaceId", entry.namespaceId)
          .eq("status.kind", "pending")
          .eq("key", entry.key)
          .lt("version", entry.version),
      )
      .collect();
    await Promise.all(
      previousPendingEntries.map(async (entry) => {
        const previousStatus = entry.status;
        entry.status = { kind: "replaced", replacedAt: Date.now() };
        await ctx.db.replace(entry._id, entry);
        if (previousStatus.kind === "pending" && previousStatus.onComplete) {
          await runOnComplete(
            ctx,
            previousStatus.onComplete,
            namespace,
            entry,
            null,
          );
        }
      }),
    );
  }
  return {
    replacedEntry: previousEntry ? publicEntry(previousEntry) : null,
  };
}

export const deleteAsync = mutation({
  args: v.object({
    entryId: v.id("entries"),
  }),
  returns: v.null(),
  handler: deleteAsyncHandler,
});

/**
 * Delete multiple entries and their content in one mutation. Reduces
 * function calls and database round-trips when removing many entries.
 * All entries must exist; throws if any entryId is not found.
 */
export const deleteMany = mutation({
  args: v.object({
    entryIds: v.array(v.id("entries")),
  }),
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const entryId of args.entryIds) {
      await deleteAsyncHandler(ctx, { entryId });
    }
    return null;
  },
});

/**
 * Schedule deletion of multiple entries in the background (one workpool job
 * per entry). Returns immediately; actual deletes run asynchronously.
 * Use when you want to avoid holding a long mutation.
 */
export const deleteManyAsync = mutation({
  args: v.object({
    entryIds: v.array(v.id("entries")),
  }),
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const entryId of args.entryIds) {
      await workpool.enqueueMutation(ctx, api.entries.deleteAsync, {
        entryId,
      });
    }
    return null;
  },
});

/**
 * Deletes replaced entries (and their content) for a namespace in the
 * background. Each workpool job removes up to 10 entries; another job is
 * enqueued while a full batch was deleted.
 */
export const cleanupReplacedEntriesBatch = internalMutation({
  args: v.object({
    namespaceId: v.id("namespaces"),
  }),
  returns: v.object({
    deleted: v.number(),
    scheduledMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query("entries")
      .withIndex("status_namespaceId", (q) =>
        q.eq("status.kind", "replaced").eq("namespaceId", args.namespaceId),
      )
      .take(REPLACED_CLEANUP_BATCH_SIZE);
    for (const row of entries) {
      await deleteAsyncHandler(ctx, { entryId: row._id });
    }
    if (entries.length === REPLACED_CLEANUP_BATCH_SIZE) {
      await workpool.enqueueMutation(
        ctx,
        internal.entries.cleanupReplacedEntriesBatch,
        { namespaceId: args.namespaceId },
      );
    }
    return {
      deleted: entries.length,
      scheduledMore: entries.length === REPLACED_CLEANUP_BATCH_SIZE,
    };
  },
});

export const cleanupReplacedEntriesAsync = mutation({
  args: v.object({
    namespaceId: v.id("namespaces"),
  }),
  returns: v.null(),
  handler: async (ctx, args) => {
    await workpool.enqueueMutation(
      ctx,
      internal.entries.cleanupReplacedEntriesBatch,
      { namespaceId: args.namespaceId },
    );
    return null;
  },
});

async function deleteAsyncHandler(
  ctx: MutationCtx,
  args: { entryId: Id<"entries"> },
) {
  const { entryId } = args;
  const entry = await ctx.db.get(entryId);
  if (!entry) {
    throw new Error(`Entry ${entryId} not found`);
  }
  await deleteContentHandler(ctx, { entryId });
  await ctx.db.delete(entryId);
}

export const deleteSync = action({
  args: { entryId: v.id("entries") },
  returns: v.null(),
  handler: async (ctx, { entryId }) => deleteEntrySync(ctx, entryId),
});

export async function deleteEntrySync(ctx: ActionCtx, entryId: Id<"entries">) {
  await ctx.runMutation(internal.content.deleteContent, { entryId });
  await ctx.runMutation(internal.entries._del, { entryId });
}

export const _del = internalMutation({
  args: { entryId: v.id("entries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.entryId);
  },
});

export const deleteByKeyAsync = mutation({
  args: v.object({
    namespaceId: v.id("namespaces"),
    key: v.string(),
    beforeVersion: v.optional(v.number()),
  }),
  returns: v.null(),
  handler: async (ctx, args) => {
    const entries = await getEntriesByKey(ctx, args);
    for await (const entry of entries) {
      await workpool.enqueueMutation(ctx, api.entries.deleteAsync, {
        entryId: entry._id,
      });
    }
    if (entries.length === 100) {
      await workpool.enqueueMutation(ctx, api.entries.deleteByKeyAsync, {
        namespaceId: args.namespaceId,
        key: args.key,
        beforeVersion: entries[entries.length - 1].version,
      });
    }
  },
});

async function getEntriesByKey(
  ctx: QueryCtx,
  args: { namespaceId: Id<"namespaces">; key: string; beforeVersion?: number },
): Promise<Doc<"entries">[]> {
  return mergedStream(
    statuses.map((status) =>
      stream(ctx.db, schema)
        .query("entries")
        .withIndex("namespaceId_status_key_version", (q) =>
          q
            .eq("namespaceId", args.namespaceId)
            .eq("status.kind", status)
            .eq("key", args.key)
            .lt("version", args.beforeVersion ?? Infinity),
        )
        .order("desc"),
    ),
    ["version"],
  ).take(100);
}

export const getEntriesForNamespaceByKey = internalQuery({
  args: {
    namespaceId: v.id("namespaces"),
    key: v.string(),
    beforeVersion: v.optional(v.number()),
  },
  returns: v.array(doc(schema, "entries")),
  handler: getEntriesByKey,
});

export const deleteByKeySync = action({
  args: {
    namespaceId: v.id("namespaces"),
    key: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    while (true) {
      const entries: Doc<"entries">[] = await ctx.runQuery(
        internal.entries.getEntriesForNamespaceByKey,
        { namespaceId: args.namespaceId, key: args.key },
      );
      for await (const entry of entries) {
        await deleteEntrySync(ctx, entry._id);
      }
      if (entries.length <= 100) {
        break;
      }
    }
  },
});
