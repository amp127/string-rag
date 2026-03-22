# Changelog

## 0.1.11

- **Breaking:** Removed the `RAG` re-export; use `StringRAG` from `"string-rag"`.
- **Fix:** `embeddingCache.lookupBatch` now returns rows in the same order as
  `textHashes` (parallel lookups no longer race on `push`).
- **Fix:** `embeddingCache.clear({ dimension })` without `modelId` now deletes
  only that dimension (was clearing the entire cache). New index `by_dimension`
  on `embeddingCache`.
- **Export:** `componentWithEmbeddingCache` and `EmbeddingCacheApi` for typed
  access to cache internal queries/mutations from app code.

- **Embedding cache (opt-in):** Set `enableEmbeddingCache: true` on `StringRAG`
  to use the component `embeddingCache` table; `add`, `addMany`, and string
  `search` reuse cached vectors per `modelId`, dimension, and content hash.
  `content.insert` accepts `populateEmbeddingCache`; sync adds and
  `defineContentProcessor` / `defineBatchTextProcessor` set it when caching is on.
  `clearEmbeddingCache` no-ops when caching is disabled.
- **Raw entry embeddings:** Component query `search.embeddingForEntry` and
  client `getEmbeddingForEntry` return the stored vector for a ready entry when
  namespace matches the configured model and dimension.

## 0.1.10

- Merged upstream [get-convex/rag](https://github.com/get-convex/rag) through
  v0.7.2: `deleteNamespaceSync` deletes entries for every entry status with
  correct pagination; shared `deleteEntrySync` helper (here implemented for the
  single-content model via `deleteContent` + entry removal, not chunks); shared
  helpers module; namespace sync-delete test; CI circular-dependency check;
  lockfile and tooling updates from upstream where applicable.

## 0.1.9

- **Bugfix:** `addAsyncOnComplete` and `addAsyncBatchOnComplete` now call
  `replaceContent` before `promoteToReady`, matching sync `add`, so pending
  content is promoted and `pendingContentEmbeddings` rows are removed.
- **`cleanupReplacedEntriesAsync`:** Background cleanup of `replaced` entries
  per namespace via the workpool (10 entries per job, chained until done).
  Component: `entries.cleanupReplacedEntriesAsync` / internal
  `cleanupReplacedEntriesBatch`; client: `rag.cleanupReplacedEntriesAsync`.

## 0.1.8

- **Breaking (`addManyAsyncBatch` contract):** `defineBatchTextProcessor` now
  returns full content payloads per entry (same shape as
  `defineContentProcessor`), i.e. `{ content: CreateContentArgs }`.
- Batch processors no longer return plain strings and the client no longer runs
  internal `embedMany` for this path; embedding is now owned by user code for
  parity with `addAsync` / `addManyAsync`.
- Batch content now supports `content.metadata` the same way as non-batch async
  processors.
- README updated to document the new batch return shape.

## 0.1.6

- **`addManyAsyncBatch` + `defineBatchTextProcessor`:** One workpool action per
  batch; user returns texts per entry, library calls **`embedMany` once** then
  inserts. Component: `asyncBatchWork` table, `addManyAsyncBatch`,
  `addAsyncBatchOnComplete`, test helpers `testBatchTextProcessor` /
  `getTestBatchTextProcessorHandle`.
- **Breaking (component schema):** Pending content `state` is now only
  `{ kind: "pending", searchableText? }` (no inline embedding/importance).
  Vectors are stored in `pendingContentEmbeddings` until `replaceContent`
  runs. Existing DB rows in the old pending shape must be migrated or
  re-written.

## 0.1.5

- **Batch client APIs** (single namespace per call): `addMany` (one namespace
  lookup; batched embedding when the model supports `doEmbed({ values })`),
  `getEntries` (one query), `deleteMany` (one mutation).
- **Async batch APIs:** `addManyAsync` (content processor per item, workpool),
  `deleteManyAsync` (schedules background deletes).
- **Component:** `entries.addMany`, `getMany`, `addManyAsync`, `deleteMany`,
  `deleteManyAsync`; shared `addAsyncOneEntryHandler` for `addAsync` /
  `addManyAsync`; `content.replaceContentHandler` reused for batch add promotion.
- Exported `DEFAULT_ADD_MANY_BATCH_SIZE` (default 100) for batch size limits.
- README: batch and async batch documentation.
- Test-only helpers: `testContentProcessor`, `getTestContentProcessorHandle`
  (component); client tests register workpool for async flows.
- TypeScript: explicit handler return types to fix circular inference on
  `addAsync`, `getTestContentProcessorHandle`, and `testContentProcessor`.

## 0.1.4

- Added `searchSimilar(ctx, { namespace, key, ... })` to find similar entries
  by entry key, using the stored embedding. Like `searchWithEntryId` but
  identified by key so you don't need to look up the entry first; avoids the
  embedding process entirely.

## 0.1.1

- Changelog and dependency cleanup for 0.7.1 → 0.1.x conversion.
- Removed unused `@langchain/textsplitters` devDependency.

## 0.1.0

- **Breaking:** Package simplified to a single content source per entry (no
  chunking). One text/embedding per entry instead of multiple chunks.
- Renamed main export from `RAG` to `StringRAG` (a `RAG` alias existed until
  it was removed in a later release).
- Added `searchWithEntryId(ctx, { entryId, ... })` to find similar entries using
  stored embeddings, without embedding a query string.
- Removed chunk context and chunking from the API and docs; README and types
  updated for the single-content-per-entry model.
- Version reset to 0.1.x to reflect the simplified scope post-conversion from
  0.7.1.

## 0.7.1

- Adds hybrid text/vector search (credit:richardsolomou)

## 0.7.0

- AI SDK v6 support

## 0.6.1

- Track bandwidth more accurately to avoid going over the limits while deleting
  chunks.

## 0.6.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API

## 0.5.4

- Support gateway string IDs for models

## 0.5.3

- Return usage data from embedding for search/add

## 0.5.2

- Support text embedding models as a string

## 0.5.1

- Fix orphaned embeddings when replacing content

## 0.5.0 AI SDK v5 support

- Adds support for AI SDK v5

## 0.3.5

- Fix orphaned embeddings when replacing content

## 0.3.4

- ai is a regular dependency
- namespaces can be deleted if there are no entries left in them
- namespaces can be synchronously deleted from an action if there are entries in
  them

## 0.3.3

- Allow deleting an entry by key asynchronously or sync
- Deprecated: `.delete` from mutations is deprecated. `.delete` is now
  synchronous for an entry. Use `.deleteAsync` from mutations instead.
- Fix: Delete embeddings when deleting entry
- Fix: Replacing small documents by key no longer leaves them in "pending"
  state.

## 0.3.2

- query can be a string or array, instead of separate embedding argument.
- nicer examples & UI to play with
- default chunk sizes are smaller
- EntryFilterValue is now called EntryFilter
- Fixes chunker handling of empty lines
- supports sha-1 content hashing in utility
- default context formatting separates content better for LLMs
- list can take a limit instead of paginationOpts
- findExistingEntryByContentHash is renamed to drop the Existing

## 0.3.1

- Demote document titles to h2 when auto-generating prompt template
- Rename replacedVersion -> replaced{Entry,Namespace} to match onComplete
- Allow listing documents by status without specifying a namespace (e.g.
  vacuuming)
- Return replacedAt when listing documents

## 0.1.7/0.3.0

- Renamed to RAG
- Adds a default chunker, so you can pass `text` to `add[Async]`
- Adds a `generateText` with default prompt formatting for one-off generation.
- OnComplete handler now has updated status for the replaced & new
  entry/namespace
- Example showcases prompting as well as searching.

## 0.1.6

- Add VSearchEntry type for casing vSearchEntry to a type-safe version

## 0.1.5

- Add SearchEntry type with type-safe access to metadata & filter values

## 0.1.4

- Allow adding files asynchronously
- Allow passing an onComplete handler to creating entries or namespaces, that is
  called when they are no longer pending.
- Support generic type-safe metadata to be stored on the entry.
- Updated the example to also show uploading files via http.

## 0.1.3

- Renamed doc to entry
- Allows passing vectorScoreThreshold to search
- More convenient `text` returned from search
- Enables passing in your own embedding parameter to add -> Allows adding (a few
  chunks) from a mutation.

## 0.1.2

- Snips console logs

## 0.1.1

- Vector search over chunked content, with namespaces, search filters, etc.
- You can also gracefully transition between models, embedding lengths, chunking
  strategies, and versions, with automatically versioned namespaces.
- See the example for injesting pdfs, images, audio, and text!
- List namespaces by status, entries by namespace/status, and chunks by entry
- Find older versions by content hash to restore.
- Add metadata filters for searching.
