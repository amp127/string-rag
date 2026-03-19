# Convex StringRAG Component

[![npm version](https://badge.fury.io/js/string-rag.svg)](https://badge.fury.io/js/string-rag)

<!-- START: Include on https://convex.dev/components -->

A component for semantic search, usually used to look up context for LLMs. Use
with an Agent for Retrieval-Augmented Generation (RAG). One content per entry.

[![Use AI to search HUGE amounts of text with the RAG Component](https://thumbs.video-to-markdown.com/1ff18153.jpg)](https://youtu.be/dGmtAmdAaFs)

## ✨ Key Features

- **Add Content**: Add or replace content with text and embeddings (one content
  per entry).
- **Semantic Search**: Vector-based search using configurable embedding models
- **Namespaces**: Organize content into namespaces for per-user search.
- **Custom Filtering**: Filter content with custom indexed fields.
- **Importance Weighting**: Weight content by providing a 0 to 1 "importance".
- **Graceful Migrations**: Migrate content or whole namespaces without
  disruption.

Found a bug? Feature request?
[File it here](https://github.com/amp127/string-rag/issues).

## Installation

Create a `convex.config.ts` file in your app's `convex/` folder and install the
component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import rag from "string-rag/convex.config.js";

const app = defineApp();
app.use(rag);

export default app;
```

Run `npx convex codegen` if `npx convex dev` isn't already running.

## Basic Setup

```ts
// convex/example.ts
import { components } from "./_generated/api";
import { StringRAG } from "string-rag";
// Any AI SDK model that supports embeddings will work.
import { openai } from "@ai-sdk/openai";

const rag = new StringRAG(components.rag, {
  textEmbeddingModel: openai.embedding("text-embedding-3-small"),
  embeddingDimension: 1536, // Needs to match your embedding model
});
```

## Add context to RAG

Add content with text. Each call to `add` will create a new **entry** with a
single content. The component will embed the text automatically if you don't
provide an embedding.

```ts
export const add = action({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    // Add the text to a namespace shared by all users.
    await rag.add(ctx, {
      namespace: "all-users",
      text,
    });
  },
});
```

See below for adding content asynchronously, e.g. to handle large files.

## Semantic Search

Search across content with vector similarity

- `text` is a string with the full content of the results, for convenience. It
  is in order of the entries, with titles at each entry boundary, and
  separators between entries. See below for more details.
- `results` is an array of matching content with scores and metadata.
- `entries` is an array of the entries that matched the query. Each result has a
  `entryId` referencing one of these source entries.
- `usage` contains embedding token usage information. Will be `{ tokens: 0 }` if
  no embedding was performed (e.g. when passing pre-computed embeddings).

```ts
export const search = action({
  args: {
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const { results, text, entries, usage } = await rag.search(ctx, {
      namespace: "global",
      query: args.query,
      limit: 10,
      vectorScoreThreshold: 0.5, // Only return results with a score >= 0.5
    });

    return { results, text, entries, usage };
  },
});
```

### Search for similar entries

When you already have an entry (e.g. from a previous search or from `rag.add`), you can find similar entries using its stored embedding—no query string or embedding API call needed. The source entry is excluded from results. Same filters, limit, and `vectorScoreThreshold` as `search`.

**By entry ID** (`searchWithEntryId`):

```ts
export const findSimilar = action({
  args: { entryId: v.string() },
  handler: async (ctx, args) => {
    const { results, text, entries } = await rag.searchWithEntryId(ctx, {
      entryId: args.entryId,
      limit: 5,
      filters: [{ name: "category", value: "articles" }], // optional
    });
    return { results, text, entries };
  },
});
```

**By key** (`searchSimilar`): when you have the entry key and namespace, you can skip looking up the entry and use the stored embedding directly:

```ts
export const findSimilarByKey = action({
  args: { namespace: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const { results, text, entries } = await rag.searchSimilar(ctx, {
      namespace: args.namespace,
      key: args.key,
      limit: 5,
      filters: [{ name: "category", value: "articles" }], // optional
    });
    return { results, text, entries };
  },
});
```

## Generate a response based on RAG context

Once you have searched for the context, you can use it with an LLM.

Generally you'll already be using something to make LLM requests, e.g. the
[Agent Component](https://www.convex.dev/components/agent), which tracks the
message history for you. See the
[Agent Component docs](https://docs.convex.dev/agents) for more details on doing
RAG with the Agent Component.

However, if you just want a one-off response, you can use the `generateText`
function as a convenience.

This will automatically search for relevant entries and use them as context for
the LLM, using default formatting.

The arguments to `generateText` are compatible with all arguments to
`generateText` from the AI SDK.

```ts
export const askQuestion = action({
  args: {
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const { text, context } = await rag.generateText(ctx, {
      search: { namespace: userId, limit: 10 },
      prompt: args.prompt,
      model: openai.chat("gpt-4o-mini"),
    });
    return { answer: text, context };
  },
```

Note: You can specify any of the search options available on `rag.search`.

## Filtered Search

You can provide filters when adding content and use them to search. To do this,
you'll need to give the RAG component a list of the filter names. You can
optionally provide a type parameter for type safety (no runtime validation).

Note: these filters can be OR'd together when searching. In order to get an AND,
you provide a filter with a more complex value, such as `categoryAndType` below.

```ts
// convex/example.ts
import { components } from "./_generated/api";
import { RAG } from "string-rag";
// Any AI SDK model that supports embeddings will work.
import { openai } from "@ai-sdk/openai";

// Optional: Add type safety to your filters.
type FilterTypes = {
  category: string;
  contentType: string;
  categoryAndType: { category: string; contentType: string };
};

const rag = new StringRAG<FilterTypes>(components.rag, {
  textEmbeddingModel: openai.embedding("text-embedding-3-small"),
  embeddingDimension: 1536, // Needs to match your embedding model
  filterNames: ["category", "contentType", "categoryAndType"],
});
```

Adding content with filters:

```ts
await rag.add(ctx, {
  namespace: "global",
  text,
  filterValues: [
    { name: "category", value: "news" },
    { name: "contentType", value: "article" },
    {
      name: "categoryAndType",
      value: { category: "news", contentType: "article" },
    },
  ],
});
```

Search with metadata filters:

```ts
export const searchForNewsOrSports = action({
  args: {
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const results = await rag.search(ctx, {
      namespace: userId,
      query: args.query,
      filters: [
        { name: "category", value: "news" },
        { name: "category", value: "sports" },
      ],
      limit: 10,
    });

    return results;
  },
});
```

<!-- END: Include on https://convex.dev/components -->

## Formatting results

By default, results are sorted by score. For convenience, the `text` field of
the search results is a string formatted with `---` separating entries and
`## Title:` at each entry boundary (if titles are available).

```ts
const { text } = await rag.search(ctx, { ... });
console.log(text);
```

```txt
## Title 1:
Content from entry 1

---

## Title 2:
Content from entry 2
```

There is also a `text` field on each entry with the content for that entry. For
a custom format, use the `results` and `entries` fields directly:

```ts
const { results, text, entries } = await rag.search(ctx, {
  namespace: args.userId,
  query: args.query,
  limit: 5,
  vectorScoreThreshold: 0.5,
});

const contexts = entries.map((e) =>
  e.title ? `# ${e.title}:\n${e.text}` : e.text,
);

await generateText({
  model: openai.chat("gpt-4o-mini"),
  prompt:
    "Use the following context:\n\n" +
    contexts.join("\n---\n") +
    "\n\n---\n\nBased on the context, answer the question:\n\n" +
    args.query,
});
```

## Using keys to gracefully replace content

When you add content to a namespace, you can provide a `key` to uniquely
identify the content. If you add content with the same key, it will make a new
entry to replace the old one.

```ts
await rag.add(ctx, { namespace: userId, key: "my-file.txt", text });
```

When a new entry is added, it will start with a status of "pending" while it
embeds and inserts the content into the database. Once the content is inserted,
it will swap the old content embedding with the new one and update the status to
"ready", marking the previous version as "replaced".

The old content is kept around by default, so in-flight searches will get
results for old vector search results. See below for more details on deleting.

This means that if searches are happening while the document is being added,
they will see the old content results This is useful if you want to add content
to a namespace and then immediately search for it, or if you want to add content
to a namespace and then immediately add more content to the same namespace.

## Providing custom content or embeddings

You can pass a single `text` string to `add` (the component will embed it), or
pass pre-computed `content` with your own embedding and optional metadata:

```ts
await rag.add(ctx, {
  namespace: "global",
  key: "doc-1",
  text: "Your document text",
});
// Or with pre-computed embedding:
await rag.add(ctx, {
  namespace: "global",
  key: "doc-1",
  content: {
    content: { text: "Your document text", metadata: {} },
    embedding: myEmbedding,
    searchableText: "Your document text",
  },
});
```

## Add Entries Asynchronously using File Storage

For large files, you can upload them to file storage, then use a content
processor action to extract text, embed it, and index a single content row per
entry.

In `convex/http.ts`:

```ts
import { corsRouter } from "convex-helpers/server/cors";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api.js";
import { DataModel } from "./_generated/dataModel.js";
import { httpAction } from "./_generated/server.js";
import { rag } from "./example.js";

const cors = corsRouter(httpRouter());

cors.route({
  path: "/upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const storageId = await ctx.storage.store(await request.blob());
    await rag.addAsync(ctx, {
      namespace: "all-files",
      contentProcessor: internal.http.contentProcessor,
      onComplete: internal.foo.docComplete, // See next section
      metadata: { storageId },
    });
    return new Response();
  }),
});

export const contentProcessor = rag.defineContentProcessor(async (ctx, args) => {
  const storageId = args.entry.metadata!.storageId;
  const file = await ctx.storage.get(storageId);
  const text = await new TextDecoder().decode(await file!.arrayBuffer());
  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text,
  });
  return {
    content: {
      content: { text, metadata: args.entry.metadata ?? {} },
      embedding,
      searchableText: text,
    },
  };
});

export default cors.http;
```

You can upload files directly to a Convex action, httpAction, or upload url. See
the [docs](https://docs.convex.dev/file-storage/upload-files) for details.

### OnComplete Handling

You can register an `onComplete` handler when adding content that will be called
when the entry was created and is ready, or if there was an error or it was
replaced before it finished.

```ts
// in an action
await rag.add(ctx, { namespace, text, onComplete: internal.foo.docComplete });

// in convex/foo.ts
export const docComplete = rag.defineOnComplete<DataModel>(
  async (ctx, { replacedEntry, entry, namespace, error }) => {
    if (error) {
      await rag.delete(ctx, { entryId: entry.entryId });
      return;
    }
    if (replacedEntry) {
      await rag.delete(ctx, { entryId: replacedEntry.entryId });
    }
    // You can associate the entry with your own data here. This will commit
    // in the same transaction as the entry becoming ready.
  },
);
```

Note: The `onComplete` callback is only triggered when new content is processed.
If you add content that already exists (`contentHash` did not change for the
same `key`), `onComplete` will not be called. To handle this case, you can check
the return value of `rag.add()`:

```ts
const { status, created } = await rag.add(ctx, {
  namespace,
  text,
  key: "my-key",
  contentHash: "...",
  onComplete: internal.foo.docComplete,
});

if (status === "ready" && !created) {
  // Entry already existed - onComplete will not be called
  // Handle this case if needed
}
```

### Batch operations (addMany, getEntries, deleteMany)

To reduce function call count and database bandwidth, use the batch APIs when
operating on many entries in the same namespace:

- **`addMany(ctx, { namespace, items, maxBatchSize? })`** — Add multiple entries
  in one namespace with a single namespace lookup. When using `text`, all texts
  are embedded in one batch call when the model supports it (`doEmbed({ values })`).
  Optional `maxBatchSize` (default 100) caps the batch to stay within Convex
  mutation limits.
- **`getEntries(ctx, { entryIds })`** — Load multiple entries by id in one query.
- **`deleteMany(ctx, { entryIds })`** — Delete multiple entries and their
  content in one mutation.

Async batch variants (return immediately; work runs in the background):

- **`addManyAsync(ctx, { namespace, items, maxBatchSize? })`** — Like `addMany`,
  but each item has a `contentProcessor` (same as `addAsync`). One namespace
  lookup; **each entry is its own workpool job** (and typically its own embed
  call unless your processor batches internally).
- **`addManyAsyncBatch(ctx, { namespace, items, batchTextProcessor })`** — **One
  workpool job** for the whole batch. Define `batchTextProcessor` with
  `rag.defineBatchTextProcessor(async (ctx, { entries }) => { ... })`: return
  one item per entry (same order as `entries`), where each item is
  `{ content: { content: { text, metadata? }, embedding, searchableText? } }`
  (same shape as `defineContentProcessor` return). Duplicates that short-circuit
  as already-ready (same as `addManyAsync`) are omitted from the batch. Same
  `maxBatchSize` cap (default 100).
- **`deleteManyAsync(ctx, { entryIds })`** — Schedules one background delete per
  entry (via workpool). Use when you want to avoid a long-running mutation.

All batch operations are limited to a single namespace (e.g. one `namespace` or
`namespaceId` for the whole batch).

### Add Entries with filters from a URL

Here's a simple example fetching content from a URL to add.

It also adds filters to the entry, so you can search for it later by category,
contentType, or both.

```ts
export const add = action({
  args: { url: v.string(), category: v.string() },
  handler: async (ctx, { url, category }) => {
    const response = await fetch(url);
    const content = await response.text();
    const contentType = response.headers.get("content-type");

    const { entryId } = await rag.add(ctx, {
      namespace: "global", // namespace can be any string
      key: url,
      text: content,
      filterValues: [
        { name: "category", value: category },
        { name: "contentType", value: contentType },
        // To get an AND filter, use a filter with a more complex value.
        { name: "categoryAndType", value: { category, contentType } },
      ],
    });

    return { entryId };
  },
});
```

### Lifecycle Management

You can delete the old content by calling `rag.delete` with the entryId of the
old version.

Generally you'd do this:

1. When using `rag.add` with a key returns a `replacedEntry`.
1. When your `onComplete` handler provides a non-null `replacedEntry` argument.
1. Periodically by querying:

```ts
// in convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import { rag } from "./example.js";
import { assert } from "convex-helpers";

const WEEK = 7 * 24 * 60 * 60 * 1000;

export const deleteOldContent = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const toDelete = await rag.list(ctx, {
      status: "replaced",
      paginationOpts: { cursor: args.cursor ?? null, numItems: 100 },
    });

    for (const entry of toDelete.page) {
      assert(entry.status === "replaced");
      if (entry.replacedAt >= Date.now() - WEEK) {
        return; // we're done when we catch up to a week ago
      }
      await rag.delete(ctx, { entryId: entry.entryId });
    }
    if (!toDelete.isDone) {
      await ctx.scheduler.runAfter(0, internal.example.deleteOldContent, {
        cursor: toDelete.continueCursor,
      });
    }
  },
});

// See example/convex/crons.ts for a complete example.
const crons = cronJobs();
crons.interval(
  "deleteOldContent",
  { hours: 1 },
  internal.crons.deleteOldContent,
  {},
);
export default crons;
```

## Working with types

You can use the provided types to validate and store data.
`import { ... } from "string-rag";`

Types for the various elements:

`Entry`, `EntryFilter`, `SearchEntry`, `SearchResult`

- `SearchEntry` is an `Entry` with a `text` field containing the content for that
  entry, whereas a `SearchResult` is a single content result with score and
  metadata.

`EntryId`, `NamespaceId`

- While the `EntryId` and `NamespaceId` are strings under the hood, they are
  given more specific types to make it easier to use them correctly.

Validators can be used in `args` and schema table definitions: `vEntry`,
`vEntryId`, `vNamespaceId`, `vSearchEntry`, `vSearchResult`

e.g. `defineTable({ myDocTitle: v.string(), entryId: vEntryId })`

The validators for the branded IDs will only validate they are strings, but will
have the more specific types, to provide type safety.

## Utility Functions

In addition to the function on the `rag` instance, there are other utilities
provided:

### `hybridRank`

This is an implementation of "Reciprocal Rank Fusion" for ranking search results
based on multiple scoring arrays. The premise is that if both arrays of results
are sorted by score, the best results show up near the top of both arrays and
should be preferred over results higher in one but much lower in the other.

```ts
import { hybridRank } from "string-rag";

const textSearchResults = [id1, id2, id3];
const vectorSearchResults = [id2, id3, id1];
const results = hybridRank([textSearchResults, vectorSearchResults]);
// results = [id2, id1, id3]
```

It can take more than two arrays, and you can provide weights for each array.

```ts
const recentSearchResults = [id5, id4, id3];
const results = hybridRank(
  [textSearchResults, vectorSearchResults, recentSearchResults],
  {
    weights: [2, 1, 3], // prefer recent results more than text or vector
  },
);
// results = [ id3, id5, id1, id2, id4 ]
```

To have it more biased towards the top few results, you can set the `k` value to
a lower number (10 by default).

```ts
const results = hybridRank(
  [textSearchResults, vectorSearchResults, recentSearchResults],
  { k: 1 },
);
// results = [ id5, id1, id3, id2, id4 ]
```

### `contentHashFromArrayBuffer`

This generates the hash of a file's contents, which can be used to avoid adding
the same file twice.

Note: doing `blob.arrayBuffer()` will consume the blob's data, so you'll need to
make a new blob to use it after calling this function.

```ts
import { contentHashFromArrayBuffer } from "string-rag";

export const addFile = action({
  args: { bytes: v.bytes() },
  handler: async (ctx, { bytes }) => {
    const hash = await contentHashFromArrayBuffer(bytes);

    const existing = await rag.findEntryByContentHash(ctx, {
      namespace: "global",
      key: "my-file.txt",
      contentHash: hash,
    });
    if (existing) {
      console.log("File contents are the same, skipping");
      return;
    }
    const blob = new Blob([bytes], { type: "text/plain" });
    //...
  },
});
```

### `guessMimeTypeFromExtension`

This guesses the mime type of a file from its extension.

```ts
import { guessMimeTypeFromExtension } from "string-rag";

const mimeType = guessMimeTypeFromExtension("my-file.mjs");
console.log(mimeType); // "text/javascript"
```

### `guessMimeTypeFromContents`

This guesses the mime type of a file from the first few bytes of its contents.

```ts
import { guessMimeTypeFromContents } from "string-rag";

const mimeType = guessMimeTypeFromContents(await file.arrayBuffer());
```

### Example Usage

See more example usage in [example.ts](./example/convex/example.ts).

### Running the example

Run the example with `npm run setup && npm run dev`.
