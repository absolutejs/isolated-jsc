# FFI/JSC snapshot research

Last updated: 2026-05-28.

## Decision

Do not promise a V8-style heap snapshot or pause/resume primitive on top of
JavaScriptCore's public C API.

`Context.snapshot()` should stay a data checkpoint API:

- capture structured-cloneable own properties from a context;
- restore them into a fresh context with `createContext({ snapshot, seed })`;
- keep functions, host `Reference`s, symbols, closures, prototypes, pending
  promises, and JSC internal execution state out of the checkpoint.

The product language should call this a **checkpoint** or **data snapshot**, not
a **heap snapshot**.

## What the public API exposes

The public JavaScriptCore C API is enough for the current implementation:

- create a context group with `JSContextGroupCreate()`;
- create global contexts with `JSGlobalContextCreateInGroup()`;
- get the global object with `JSContextGetGlobalObject()`;
- enumerate own property names with `JSObjectCopyPropertyNames()`;
- read/write properties with `JSObjectGetProperty()` and
  `JSObjectSetProperty()`;
- serialize JSON-compatible values with `JSValueCreateJSONString()` and restore
  them with `JSValueMakeFromJSONString()`.

Sources:

- Apple/WebKit `JSContextRef.h` documents context groups, global context
  creation, global object lookup, and the fact that sharing values across
  different context groups is undefined behavior:
  https://raw.githubusercontent.com/WebKit/WebKit/main/Source/JavaScriptCore/API/JSContextRef.h
- WebKit `JSObjectRef.h` documents property get/set, property enumeration, and
  function invocation through `JSObjectCallAsFunction()`:
  https://raw.githubusercontent.com/WebKit/WebKit/main/Source/JavaScriptCore/API/JSObjectRef.h
- WebKit `JSValueRef.h` documents JSON conversion through
  `JSValueCreateJSONString()` / `JSValueMakeFromJSONString()`:
  https://raw.githubusercontent.com/WebKit/WebKit/main/Source/JavaScriptCore/API/JSValueRef.h

## What it does not expose

The public C API does not expose a stable operation to serialize:

- a whole `JSGlobalContextRef`;
- a `JSContextGroupRef`;
- the heap graph with object identity, prototypes, closures, and internal
  slots;
- suspended call stacks or pending promise/microtask state;
- JIT tiering/profile state;
- reusable bytecode cache blobs through a public embedder API comparable to a
  source-independent module cache.

WebKit's own documentation and engineering posts describe JSC as an optimizing
VM with LLInt, Baseline, DFG, and FTL tiers. They also describe internal
bytecode and bytecode-cache work, but those details are engine internals, not a
portable C API for heap or context serialization.

Sources:

- WebKit's JavaScriptCore deep dive describes the engine tiers and source-tree
  location:
  https://docs.webkit.org/Deep%20Dive/JSC/JavaScriptCore.html
- WebKit's bytecode-format post says JSC bytecode is the engine's source of
  truth and was redesigned to be cacheable on disk, but this is bytecode/cache
  infrastructure, not heap checkpointing:
  https://webkit.org/blog/9329/a-new-bytecode-format-for-javascriptcore/
- WebKit's speculation post describes bytecode as internal common IR feeding
  the execution tiers:
  https://webkit.org/blog/10308/speculation-in-javascriptcore/

## Product implication

There are three distinct features, and only the first is shippable on public JSC
today:

| Feature                       | Public JSC status                                                                                 | Recommendation                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Data checkpoint               | Supported through property enumeration and JSON/structured-clone-compatible marshalling           | Keep and improve                            |
| Bytecode/source compile cache | JSC has internal bytecode-cache machinery, but no stable public C API for this package to consume | Track as upstream/private-API research only |
| Heap pause/resume             | No public context/group/heap serializer                                                           | Do not promise                              |

## Implemented checkpoint API

`0.8.19` adds a stronger checkpoint API around the existing
`Context.snapshot()` contract, without changing the meaning:

```ts
const checkpoint = await context.checkpoint({
  include: ["counter", "conversation"],
  maxBytes: 64 * 1024,
});

const resumed = await isolate.createContext({
  checkpoint,
  seed: conversationRuntimeSource,
});
```

This should be a typed, bounded, receipt-friendly wrapper around data state:

- `schemaVersion: 1`;
- `backend`;
- `byteLength`;
- included/skipped key counts;
- skipped key reasons: `not-clonable`, `over-max-bytes`, `excluded`;
- restore through `createContext({ checkpoint, seed })`, with checkpoint data
  installed before `seed` runs.

This gives users a credible "resume tenant/agent state" primitive while staying
honest about JavaScriptCore's public API.

## Non-goals

- No private WebKit C++ API dependency.
- No ABI poking into JSC heap internals.
- No promise that closures, functions, prototypes, pending promises, or stack
  frames survive a checkpoint.
- No cross-process portable heap image.
