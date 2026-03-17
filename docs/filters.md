# Filters

Filters let you tag entries and restrict search to entries that match. This doc covers how filter names, values, and order work.

## Filter names (per namespace)

When you create a StringRAG instance you pass **filterNames**: an ordered list of filter names the namespace supports (e.g. `["type", "category", "ownerId"]`).

- **Order matters** when the namespace is created. The order of `filterNames` defines which internal slot (filter0, filter1, …) each name maps to. Once a namespace exists, that mapping is fixed. Use the same order for all namespaces that share the same logical schema so the same semantic filter lives in the same slot.
- When adding an entry, you must provide a value for **every** filter name on the namespace.
- Maximum **4** filter names per namespace (filter0–filter3 in the schema).

## Filter values when adding (`filterValues`)

When you call `add()`, you can pass **filterValues**: an array of `{ name, value }` pairs.

- **Order does not matter.** Values are looked up by name, so `[{ name: "type", value: "a" }, { name: "category", value: "b" }]` and `[{ name: "category", value: "b" }, { name: "type", value: "a" }]` are equivalent.
- Each name must be one of the namespace’s `filterNames`, and you must include every filter name (no optional filters).

## Filters when searching

When you call `search()` (or similar), you can pass **filters**: same shape as `filterValues`.

- **Order does not matter.** As with `filterValues`, filters are matched by name.
- Search combines multiple filter conditions with OR logic (unless you use a single filter with a composite value for AND).

## Limit

At most **4** filter names per namespace. If you need more, you’d have to extend the component schema (e.g. add filter4, filter5, …).
