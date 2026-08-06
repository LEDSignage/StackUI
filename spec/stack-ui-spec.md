# Stack UI — a linear front end for ComfyUI

## 1. What this is

A standalone web client that drives an existing ComfyUI server. It replaces the node canvas with an ordered vertical stack of module tiles, for pipelines that are mostly linear.

It generates nothing itself. All execution is ComfyUI's, using ComfyUI's own installed nodes. The client's only jobs are: present a stack, compile it to API-format JSON, POST it, and show progress and results.

**Non-goals.** Not a replacement for the node editor. Not a workflow authoring tool for arbitrary graphs. Anything genuinely graph-shaped stays in ComfyUI and gets wrapped as a module.

## 2. Architecture

Standalone client on its own port. ComfyUI does not know it exists.

```
Browser (Stack UI)
   │  HTTP  ── /object_info, /prompt, /history, /view, /upload/image
   │  WS    ── /ws?clientId=<uuid>
   ▼
ComfyUI server (default :8188)
```

**Why standalone rather than a ComfyUI extension.** The ComfyUI frontend ships on a fortnightly cadence and its internals change frequently. An extension couples you to that. The HTTP API is far more stable. The data model and compile step are identical either way, so this can be re-wrapped as an extension later if wanted — the hard part carries over.

**Consequence:** CORS. ComfyUI needs `--enable-cors-header` (or serve the client from the same origin via a small static server / reverse proxy). Verify the exact flag against your installed version.

## 3. ComfyUI API surface

Verify each of these against your own install before building on it — response shapes have shifted between versions.

### GET /object_info

Every installed node class. Keyed by `class_type`. Roughly:

```json
{
  "KSampler": {
    "input": {
      "required": {
        "model": ["MODEL"],
        "seed": ["INT", { "default": 0, "min": 0, "max": 18446744073709552000 }],
        "steps": ["INT", { "default": 20, "min": 1, "max": 10000 }],
        "cfg": ["FLOAT", { "default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1 }],
        "sampler_name": [["euler", "euler_ancestral", "dpmpp_2m"]],
        "positive": ["CONDITIONING"],
        "latent_image": ["LATENT"]
      },
      "optional": {}
    },
    "output": ["LATENT"],
    "output_name": ["LATENT"],
    "display_name": "KSampler",
    "category": "sampling"
  }
}
```

Read this at startup and cache it. It is the source of truth for:

- what node classes exist (including every custom pack installed)
- input names, types, defaults, min/max/step
- enum options (a list-of-lists means a dropdown — e.g. `sampler_name` above)
- output types and their order (output index matters when wiring)

Which types are connections versus widgets: a type given as an uppercase string like `MODEL`, `LATENT`, `IMAGE`, `CONDITIONING`, `VAE`, `CLIP` is a connection. `INT`, `FLOAT`, `STRING`, `BOOLEAN` and enum lists are widgets rendered as form controls.

### POST /prompt

```json
{
  "prompt": { "<node_id>": { "class_type": "...", "inputs": { ... } } },
  "client_id": "<uuid>"
}
```

Returns `{ "prompt_id": "...", "number": 3, "node_errors": {} }`. A non-empty `node_errors` means validation failed — surface it against the offending tile rather than as a raw dump.

Inside `inputs`, a widget value is a literal. A connection is a two-element array `[source_node_id, output_index]`. Node ids are strings and only need to be unique within the submitted prompt.

### WS /ws?clientId=&lt;uuid&gt;

Same `client_id` as the POST. Message types to handle:

| type | payload | use |
|---|---|---|
| `execution_start` | `prompt_id` | mark run started |
| `executing` | `node`, `prompt_id` | highlight the owning tile; `node: null` means finished |
| `progress` | `value`, `max`, `node` | per-node progress bar |
| `executed` | `node`, `output` | outputs became available |
| `execution_cached` | `nodes[]` | tiles that were skipped — show as cached |
| `execution_error` | node + message | attribute to the owning tile |
| `status` | queue counts | queue indicator |

Binary frames also arrive for live previews. Optional; handle later.

**You must keep a node_id → tile_id map from the compile step.** Every websocket message identifies a node, and without that map you can't say which tile it belongs to.

### GET /history/{prompt_id}

Final outputs, keyed by node id. Image-producing nodes give `images: [{ filename, subfolder, type }]`. Video nodes vary by pack — commonly `gifs` or `videos` with the same shape. Do not assume the key; iterate whatever is in `outputs`.

### GET /view?filename=&subfolder=&type=output

Fetch a result. Use directly as an `<img>` or `<video>` src.

### POST /upload/image

Multipart, field name `image`. Returns `{ name, subfolder, type }`. The returned `name` is what you put into a `LoadImage`-style node's widget value. This is how drop zones work.

### Also useful

`GET /queue`, `POST /interrupt`, `GET /system_stats`.

## 4. Data model

Three types. A stack is a list of lines; a line is a list of tiles.

```ts
type Stack = {
  id: string
  name: string
  lines: Line[]
}

type Line = {
  id: string
  mode: 'parallel' | 'wired'   // default 'parallel'; only meaningful with 2+ tiles
  tiles: Tile[]
}

type Tile = {
  id: string
  moduleId: string             // → Module in the library
  label?: string               // user override of the module's name
  params: Record<string, any>  // overrides of the module's exposed params
  bypassed: boolean
  collapsed: boolean
}
```

That is the entire persisted document, plus a `serverUrl`. It is small, diffable, and trivially versionable — put a `schemaVersion` on `Stack` from day one.

### Modules

A module is the encapsulated unit that a tile instantiates. **Define your own format rather than depending on ComfyUI's subgraph blueprint storage** — blueprints are a frontend-side concern whose on-disk shape is not a stable public API. You can seed modules by hand from workflows you've built, but you own the file format.

```ts
type Module = {
  id: string
  name: string
  category: string

  inPorts:  Port[]   // what it needs from the carry
  outPorts: Port[]   // what it contributes
  passThrough?: Record<string, string>  // inPort → outPort, same type; used when bypassed

  params: Param[]    // what shows in the tile when expanded

  nodes: Record<string, {              // the partial graph
    class_type: string
    inputs: Record<string, any>        // literals, or refs (below)
  }>
}

type Port  = { name: string; type: string }   // type e.g. 'IMAGE', 'LATENT', 'MODEL'
type Param = {
  name: string
  label: string
  type: 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'ENUM' | 'IMAGE_UPLOAD'
  default: any
  min?: number; max?: number; step?: number
  options?: string[]
  target: { node: string; input: string }   // where the value lands
}
```

Two reference forms inside a module's `nodes[].inputs`:

- `{ "$port": "image" }` — bind to the module's named in-port, resolved from the carry at compile time
- `{ "$node": "local_id", "out": 0 }` — bind to another node inside the same module

A trivial module is one node with one in-port and one out-port. A complex one is fifteen nodes exposing three params. Same shape either way, and that recursion is what gives you compactness without a mode switch.

## 5. Compile step

The core of the whole thing. Input: a `Stack` plus the module library. Output: API-format JSON, plus a `node_id → tile_id` map.

### The carry

A map of what is currently available, by port name:

```ts
type Carry = Map<string, { nodeId: string; outIndex: number; type: string }>
```

Names accumulate. A later tile emitting an existing name overwrites it; everything else stays. This is what makes the shared-mask case work without wires — a mask emitted on line one is still in the carry on line six.

### Algorithm

```
nodeCounter = 0
carry = new Map()
prompt = {}
tileMap = {}

for each line in stack.lines:
    lineCarry = clone(carry)      // parallel: everyone sees the same starting state
    pending  = new Map()

    for each tile in line.tiles:
        module = library[tile.moduleId]

        if tile.bypassed:
            for (inName, outName) in module.passThrough:
                src = lineCarry.get(inName)
                if src: pending.set(outName, src)     // alias, emit nothing
            continue

        localToGlobal = {}
        for (localId, node) in module.nodes:
            gid = String(++nodeCounter)
            localToGlobal[localId] = gid
            tileMap[gid] = tile.id

        for (localId, node) in module.nodes:
            gid = localToGlobal[localId]
            inputs = {}
            for (inputName, value) in node.inputs:
                if value is { $port }:
                    src = lineCarry.get(value.$port)
                    if not src: throw UnresolvedPort(tile, value.$port)
                    inputs[inputName] = [src.nodeId, src.outIndex]
                else if value is { $node }:
                    inputs[inputName] = [localToGlobal[value.$node], value.out ?? 0]
                else:
                    inputs[inputName] = value
            prompt[gid] = { class_type: node.class_type, inputs }

        for param in module.params:
            v = tile.params[param.name] ?? param.default
            prompt[localToGlobal[param.target.node]].inputs[param.target.input] = v

        for port in module.outPorts:
            pending.set(port.name, resolve(port, localToGlobal))

        if line.mode == 'wired':
            merge pending into lineCarry     // next tile on this line sees it
            pending.clear()

    merge pending into carry
```

`parallel` versus `wired` is that one conditional. Everything else is shared.

### Bypass

A bypassed tile emits no nodes. If the module declares `passThrough`, the carry entry for the input port is aliased to the output port name, so downstream tiles still resolve. Without `passThrough`, bypassing a tile whose outputs are needed downstream is a validation error — catch it before submitting.

### Output node

The stack needs at least one terminal node (`SaveImage`, `PreviewImage`, a video combine node) or ComfyUI has nothing to execute toward. Either make the final line's module always terminal, or have the compiler append a save node bound to the last `IMAGE` in the carry.

## 6. Validation

Run on every edit, not just on queue. Compute the carry statically at each line boundary — it needs no execution.

- **Drop validity.** A tile may drop at a position only if every required in-port resolves from the carry there. Show valid drop targets during drag; refuse invalid ones.
- **Type match.** Port names resolve first; if a name is absent, fall back to a unique type match in the carry, and treat ambiguity as unresolved rather than guessing.
- **Bypass safety.** Flag a bypassed tile whose outputs are consumed downstream and which has no `passThrough`.
- **Terminal.** Warn if nothing terminal is present.
- **Reordering.** Moving a tile up can invalidate it. Recompute and mark the tile rather than blocking the drag — let it sit in an error state and be fixed.

Surface errors on the tile, never as a global banner. The point of this UI is that you can see where the problem is.

## 7. UI spec

### Layout

Single column, max ~900px. Header with stack name and server status. Stack body. Output panel pinned at the bottom.

### Tile — collapsed

Drag handle · icon · name · one-line summary of key params · bypass toggle · expand chevron. One row, around 44px.

The summary line is what makes the stack readable at a glance — `wan2.2-i2v · 720p · 81f`, not `Video generation module`. Compose it from two or three of the module's params.

### Tile — expanded

Header row as above, plus a params region: responsive grid, `repeat(auto-fit, minmax(150px, 1fr))`. Controls from `Param.type`. A footer line showing what the module wraps, with a link out to the equivalent workflow in ComfyUI if you keep one.

Expansion state is per tile and persisted. Cheap, and it means the tile you iterate on stays open.

### Lines

Tiles on a line share width evenly (`flex: 1; min-width: 0`). Vertical gap between lines is larger than horizontal gap between tiles — the grouping has to be visible without reading.

**Mode switch.** Appears in a small line-level control strip only when a line holds 2+ tiles. Two states:

- `parallel` — no arrows drawn between tiles
- `wired` — small arrows drawn between tiles, left to right

The arrows are load-bearing. They are what stops the mode being hidden. A single-tile line shows no control at all, because the two modes are identical there.

### Drag and drop

Three drop targets, visually distinct:

1. **Between lines** — a thin horizontal insertion bar. Creates a new line.
2. **On a tile's left or right edge** — a vertical bar. Adds to that existing line.
3. **Onto a tile body** — replace, if module types are compatible. Optional; skip in v1.

Reordering within a line is a plain horizontal sort. Under `parallel` this changes nothing semantically — that is expected and fine.

### Module library

A side panel or modal, grouped by `Module.category`, with search. Drag from library to stack.

### Output panel

Preview (image or video), elapsed time, queue and batch buttons, download. During a run, show the active tile and its progress. On error, jump to and highlight the offending tile.

## 8. Persistence

Stacks as JSON files on disk, one per stack. No database. Include `schemaVersion`.

Modules likewise, one JSON file each in a `modules/` directory, loaded at startup. Editing a module by hand in a text editor should be a supported workflow — you will do it constantly early on.

Cache `/object_info` in memory per session, with a manual refresh button for when you install a new node pack.

## 9. Build order

1. Connect. Fetch `/object_info`, render the node count. Proves CORS and the server URL.
2. Hardcode one module and one single-tile stack. Compile it. Diff your JSON against ComfyUI's own "Save (API Format)" export of the equivalent graph until they match. **Do this before building any UI** — everything downstream depends on the compile step being right.
3. POST it. Get a `prompt_id`. Poll `/history`. Show the image.
4. Websocket progress, attributed to the tile.
5. Module library from JSON files. Render real tiles from real modules.
6. Multi-tile lines, parallel only.
7. Drag and drop, with the three drop targets and validation.
8. Bypass, collapse, persistence.
9. Image upload drop zones.
10. The `wired` line mode. Last, deliberately — you may find you don't want it.

Step 2 is the whole project. If the compiler is correct, the rest is a sortable list with forms in it.

## 10. Decisions already made

- Sequence is vertical. Side by side means concurrent.
- Per-line mode switch is additive and deferred to the end. `Line.mode` exists in the model from day one so nothing needs migrating.
- Compactness comes from collapsing depth into modules, not from wrapping sequences horizontally.
- Modules use your own format, not ComfyUI's blueprint internals.
- Standalone client, not a ComfyUI extension.

## 11. Open questions

- **Takes and versioning.** Every run is expensive and non-deterministic, so you will want "run 4 of line 3, keep it, continue from there." This is a bigger feature than the UI and is deliberately out of scope here — but decide early whether stacks are single-shot documents or carry a run history, because retrofitting it is painful.
- **Batch semantics.** Does "batch 4" mean four seeds through the whole stack, or four variations at one tile? These are different features.
- **Partial re-run.** ComfyUI caches unchanged nodes server-side, so editing a late tile and re-queuing is already fast. Confirm this holds with your node packs before building anything of your own.
- **Video output keys.** `/history` output keys vary by video node pack. Iterate rather than assuming.
