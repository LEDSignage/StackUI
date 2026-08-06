# Stack UI — a linear front end for ComfyUI

A standalone web client that drives an existing ComfyUI server. It replaces the
node canvas with an ordered vertical stack of module tiles, for pipelines that
are mostly linear.

It generates nothing itself. All execution is ComfyUI's, using ComfyUI's own
installed nodes. This client presents a stack, compiles it to API-format JSON,
POSTs it, and shows progress and results.

The full design is in [`spec/stack-ui-spec.md`](spec/stack-ui-spec.md); section
numbers below refer to it.

## Run it

```bash
npm install
npm run dev
```

`http://localhost:5174` — Vite, with `/api` and `/comfy` proxied to the Node
server on `:8790`.

| Var | Default | Meaning |
|---|---|---|
| `COMFY_URL` | `http://10.130.91.138:8188` | The ComfyUI box |
| `PORT` | `8790` | Stack UI server port |

```bash
npm test        # compiler tests
npm run build   # typecheck + production bundle into dist/
```

For production, `npm run build` then `npm run dev:server` — the server serves
`dist/` itself, so it is the only process.

## Why there is a server at all

The client is standalone (spec §2) — ComfyUI does not know it exists. But a
browser talking straight to ComfyUI hits CORS, and stacks and modules need to
live on disk. So a small Node server does two things:

1. **Proxies `/comfy/*` to ComfyUI**, HTTP and websocket. The browser only ever
   talks to one origin, so ComfyUI needs no `--enable-cors-header` and no
   reverse proxy in front of it.
2. **Reads and writes `modules/` and `stacks/`** as plain JSON. Editing a module
   in a text editor is a supported workflow — you will do it constantly early on.

## Layout

```
shared/
  types.ts       the whole data model — Stack, Line, Tile, Module, Param
  compile.ts     Stack + library → API-format JSON + node_id→tile_id map
  validate.ts    drop validity, issue indexing, collapsed-tile summaries
server/
  index.ts       ComfyUI proxy + modules/stacks file API
web/src/
  App.tsx        wiring: load, compile on every edit, drop validity, queue
  lib/comfy.ts   /object_info /prompt /history /view /upload/image, websocket
  lib/useRun.ts  websocket run state, attributed to tiles
  lib/stackOps.ts  immutable stack edits
  components/    StackView (lines + drop targets), TileView, ParamControl,
                 ModuleLibraryPanel, OutputPanel
modules/         one JSON file per module — the library
stacks/          one JSON file per stack, autosaved
test/            compiler tests
```

## The compile step

Spec §5, and the whole project. `shared/compile.ts` walks the stack keeping a
**carry** — a map of what is currently available, by port name. Names
accumulate; a later tile emitting an existing name overwrites it, everything
else stays. That is what makes a mask emitted on line one still resolvable on
line six, without wires.

`parallel` vs `wired` is one conditional: a parallel line's tiles all see the
line's starting carry, a wired line's tiles see what their left-hand neighbours
just produced.

Port references resolve **by name first**. If the name is absent, the compiler
falls back to a *unique* type match in the carry — one IMAGE in scope and a
module wanting an IMAGE is unambiguous. Two IMAGEs is ambiguous, and ambiguity
is treated as unresolved rather than guessed (spec §6).

Everything the compiler cannot resolve becomes a `CompileIssue` carrying the
**tile id**, so it renders on the tile rather than as a global banner. Same for
`node_errors` off a rejected `POST /prompt`, and for `execution_error` over the
websocket — the `tileMap` is what makes all three attributable.

Compile runs on every edit, not just on queue.

## Bypass and mode are per line, not per tile

A line is a unit: everything on it is either skipped or not. Mixing bypassed and
live tiles on one line expresses nothing that splitting the line does not
express more clearly, so the switch lives in the line rail.

Same reasoning for `mode`. A line is entirely `parallel` or entirely `wired`. A
per-pair mode would add no expressive power — "these two are sequential, this
one is independent" is just two lines — and it would break the invariant that
makes a stack readable at a glance: **vertical means sequence, side by side
means concurrent** (spec §10).

`schemaVersion` 2 moved `bypassed` from `Tile` to `Line`. `shared/migrate.ts`
upgrades older stacks on load; a v1 line counts as bypassed if any tile on it
was. `stacks/example-txt2img.json` is deliberately left at v1 so the migration
stays exercised.

## Writing a module

A module is the encapsulated unit a tile instantiates. One JSON file in
`modules/`. Its format is ours, not ComfyUI's — blueprints are a frontend-side
concern whose on-disk shape is not a stable public API (spec §4).

```json
{
  "id": "decode",
  "name": "Decode",
  "category": "latent",
  "inPorts":  [{ "name": "latent", "type": "LATENT" },
               { "name": "vae",    "type": "VAE" }],
  "outPorts": [{ "name": "image",  "type": "IMAGE" }],
  "outputs":  { "image": { "node": "vd", "out": 0 } },
  "params": [],
  "nodes": {
    "vd": {
      "class_type": "VAEDecode",
      "inputs": { "samples": { "$port": "latent" }, "vae": { "$port": "vae" } }
    }
  }
}
```

Two reference forms inside `nodes[].inputs`:

- `{ "$port": "image" }` — bind to one of the module's in-ports, resolved from
  the carry at compile time.
- `{ "$node": "local_id", "out": 0 }` — bind to another node in the same module.
  Forward references are fine; ids are allocated before inputs are resolved.

Anything else is a literal.

Beyond the spec's minimum, a module may also set:

| Field | Effect |
|---|---|
| `outputs` | Which local node and output index backs each out-port. Optional for a single-node module — that case is unambiguous. |
| `passThrough` | `inPort → outPort`. When the tile is bypassed the carry entry is aliased, so downstream still resolves. Without it, bypassing warns. |
| `summary` | Which params compose the collapsed one-line summary. Defaults to the first three. |
| `terminal` | Marks a SaveImage/PreviewImage/video-combine style module, which suppresses the no-terminal warning. |
| `description` | Shown in the expanded tile footer. |

A `Param` says where its value lands (`target: { node, input }`) — which need
not be the node holding the ports. `Canvas` exposes `width` on its
`EmptyLatentImage`; `Sample` exposes six params on its `KSampler`.

For an enum whose options depend on what is installed on the box, use
`optionsFrom` rather than baking a list into the file:

```json
{ "name": "ckpt_name", "type": "ENUM", "default": "",
  "optionsFrom": { "class_type": "CheckpointLoaderSimple", "input": "ckpt_name" },
  "target": { "node": "ckpt", "input": "ckpt_name" } }
```

The dropdown is then filled from `/object_info` at load time. Hit **reload** in
the library panel after installing a new node pack.

`IMAGE_UPLOAD` renders a drop zone that POSTs to `/upload/image` and stores the
returned `name` — exactly what a `LoadImage` widget wants.

## Build order

From spec §9. Where things stand:

| # | Step | |
|---|---|---|
| 1 | Connect — `/object_info`, node count | done — 827 node classes on ComfyUI 0.30.1 |
| 2 | Compile one stack, diff against a known-good API graph | **done — see below** |
| 3 | POST, poll `/history`, show the image | done — verified end to end against the real box |
| 4 | Websocket progress, attributed to the tile | done |
| 5 | Module library from JSON files | done |
| 6 | Multi-tile lines, parallel | done |
| 7 | Drag and drop, three targets, validation | done (targets 1 and 2; replace-on-body deferred as the spec allows) |
| 8 | Bypass, collapse, persistence | done |
| 9 | Image upload drop zones | done |
| 10 | The `wired` line mode | done |

### Step 2, the diff

`test/fixtures/zimage_t2i.api.json` is the Z-Image Turbo graph that has been
driving real generation in the LTX Automation pipeline — a known-good API-format
document, not something written for this test.

`test/reference.test.ts` builds the same pipeline as a stack out of the real
module files in `modules/`, compiles it, and asserts the two graphs are
**structurally identical**. Node ids differ — ours are allocated in stack order,
ComfyUI's come from canvas order — so `test/graphEqual.ts` compares canonical
signatures instead: each node's class_type plus its inputs, with every link
replaced by the recursive signature of what it points at. A node id renaming
passes; anything else fails.

That test passes, and it is the real proof. It also guards the module files —
edit one badly and this fails rather than a run failing later.

**Re-do this per new node pack.** Build the equivalent graph in ComfyUI, export
Save (API Format), drop it in `test/fixtures/`, and add a case.

## Two traps worth remembering

**Body parsers and the proxy.** `express.json()` must be mounted *after* the
`/comfy` proxy. A parser consumes the request stream, and the proxy then
forwards a request whose body is already drained — ComfyUI waits for bytes that
never arrive and `POST /prompt` hangs until the timeout. GETs are unaffected, so
the connection indicator stays green and everything looks fine right up until
you queue something.

**Never make a thin bar the hit target.** Positioning within a line is decided
by which half of a *tile* the cursor is over — the whole row is the drop zone,
and the bar that appears is feedback only. An earlier version made the 8px gap
between tiles the target, then widened it to 56px, and it was still unusable:
between-lines bars are ~20× the area and worked fine, which is what gave it
away. "Past the middle of that tile" carries exactly the same information as
"on the bar to its right" and asks for none of the precision.

Related: dropping a tile either side of *itself* is a no-op, so those positions
are not offered. With three tiles that was two of four targets doing nothing,
which is indistinguishable from a broken drag.

**Drag sources must not be form controls.** Chrome will not reliably start a
native drag from a `<button>` or `<input>` — the control's own mousedown
handling wins and `dragstart` never fires. Both grips are `<div role="button">`
for this reason. The symptom is maddening: the element is there, the handler is
wired, and nothing happens.

**`effectAllowed` must permit the target's `dropEffect`.** If they disagree the
browser cancels the drop silently — `dragover` keeps firing so the target
lights up, but `drop` never arrives. Sources use `copyMove` and no target sets
a `dropEffect`.

Both of the above are guarded by `test/drag.test.ts`, because **synthetic
`DragEvent`s do not enforce either rule** — every in-page test passed while real
dragging was completely broken. Do not trust a synthetic drag test to tell you
drag works.

**Fast Refresh and `useRun`.** Editing `useRun.ts` changes how many hooks it
calls. React Fast Refresh hot-swaps the code but keeps the old component's hook
state, which throws "change in the order of Hooks" and leaves the entire UI
inert — drags do nothing, clicks do nothing, and it looks like a logic bug.
`useRun.ts` forces a full reload on hot update to prevent this. If the UI ever
goes dead after an edit, hard-reload before debugging anything else.

**Websocket messages arrive before the POST returns.** Execution can start
before `POST /prompt` responds, so the first messages land while the client does
not yet know its own prompt id. `useRun` buffers those and replays them once the
id arrives. Without it the first node to execute sits on 'pending' for the whole
run.

## ComfyUI 0.30.1 notes

Verified against the installed box. The `/object_info` shape the spec describes
still holds: input specs are `[type, opts?]` tuples, a list-of-lists first
element means an enum. Two message types exist that the spec does not list:

- `progress_state` — a whole-graph snapshot of every node's state, sent very
  frequently. Ignored; the per-node `progress` and `executing` messages carry
  the same information more cheaply.
- `execution_success` — sent alongside the `executing: null` that ends a run.
  Handled, as a second completion signal.

## Not done

- Binary websocket frames (live previews) are ignored.
- Drop target 3, replace-on-tile-body — optional in the spec, skipped.
- Takes and versioning, batch semantics, partial re-run (spec §11) — all still
  open questions, deliberately out of scope.
