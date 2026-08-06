/**
 * The whole data model. Three types for the document, two for the library.
 * Spec §4.
 */

/** 2: bypass moved from the tile to the line. */
export const SCHEMA_VERSION = 2;

// ── Document ────────────────────────────────────────────────────────────────

export type Stack = {
  schemaVersion: number;
  id: string;
  name: string;
  /**
   * What this pipeline is for — "Make a video". Several stacks can share a job
   * and differ only by `model`, which is what the model selector switches
   * between.
   */
  job?: string;
  /** Which model this version uses — "LTX 2.3", "MiniMax H3". */
  model?: string;
  lines: Line[];
  /**
   * The handful of settings worth surfacing on the simple screen, so a finished
   * stack can be driven as a plain form — load an image, type a prompt, press
   * go — with no tiles in sight.
   */
  controls?: StackControl[];
  /** What to do to the finished file, after ComfyUI is done with it. */
  output?: StackOutput;
  /** A repeatable input — keyframes, reference images — with an Add button. */
  inputs?: InputList;
  /** A shot-by-shot prompt, assembled into one string. */
  script?: Script;
};

/**
 * A structured prompt.
 *
 * H3 expects a small screenplay, not a sentence — ComfyUI's own template ships a
 * prompt with an overall look, a timecoded shot list, transition rules, an audio
 * description and a set of constraints, all in one text field. Editing that as a
 * single blob is miserable, so it is edited in parts and assembled on the way
 * out. `text` on each part is what the user typed; `compose()` in shared/script
 * turns the lot into the string the model sees.
 */
export type Script = {
  /** Where the assembled prompt is written. */
  target: { tileId: string; param: string };
  /** The overall vision — look, palette, mood. */
  vision: string;
  /** One entry per shot, in order. */
  shots: Shot[];
  /** What the soundtrack should do. */
  audio?: string;
  /** Rules and things to avoid — "hard cuts only", "no dissolves". */
  rules?: string;
};

export type Shot = {
  /** Start and end in seconds. */
  from: number;
  to: number;
  text: string;
};

/**
 * The inputs a job accepts, each kind separately addable.
 *
 * Not just images. A guide input takes an IMAGE, and in ComfyUI an IMAGE is a
 * batch of frames — so a still and a video clip go into the same port, they just
 * need different nodes to load them. Each kind here is one of those routes.
 */
export type InputList = {
  /** Heading for the bar — "Inputs". */
  label: string;
  kinds: InputKind[];
  /**
   * Ceiling across every kind combined.
   *
   * H3's Omni Reference mode allows 9 images, 3 videos and 3 audio clips — but
   * no more than 12 files in total. The per-kind limits alone would happily let
   * you build 15.
   */
  maxTotal?: number;
  /** Shown under the bar when it matters — "at most 12 files in total". */
  note?: string;
};

export type InputKind = {
  /** Short id, used in tile names. Keep it alphanumeric. */
  id: string;
  /** What one of these is called — "frame", "video", "audio". */
  label: string;
  /** Ceiling. Absent means no limit; H3's reference images cap at 9. */
  max?: number;
  /** New lines are inserted before the line holding this tile. */
  beforeTile: string;
  /** The tiles that make up one input, in order, each on its own line. */
  template: { moduleId: string; params?: Record<string, unknown> }[];
  /**
   * Replaces `template[0].moduleId` for the nth input added.
   *
   * Needed where each slot must publish a differently-named output: H3's nine
   * reference images are addressed individually as `ref_image_0` … `_8`, so slot
   * three has to load through a module that publishes `ref_image_2`. One button,
   * nine loaders behind it.
   */
  loaderByIndex?: string[];
  /** Which template tile and param takes the file. */
  file: { index: number; param: string };
  /** Which template tile and param sets where it sits, if it has one. */
  position?: { index: number; param: string; label: string };
};

export type StackOutput = {
  /**
   * Re-time the video to this frame rate with motion-compensated interpolation.
   *
   * Some models only generate at their own rate — H3 is 24fps — and an integer
   * frame multiplier cannot reach 30. This runs ffmpeg's `minterpolate` on the
   * finished file, which synthesises frames at arbitrary timestamps and so can
   * hit any target. Absent or 0 means leave the file alone.
   *
   * The frames it adds are invented, which on fast motion can smear. That is
   * why this is a switch and not automatic.
   */
  convertFps?: number;
};

export type StackControl = {
  /** Friendly label. "Start frame", not "image". */
  label: string;
  tileId: string;
  /** Which of that tile's params this drives. */
  param: string;
  /**
   * Other params this control writes at the same time.
   *
   * Some values legitimately appear twice in a pipeline and must agree — a
   * frame rate is set on the conditioning *and* when the file is written, and a
   * mismatch gives you a clip that plays at the wrong speed. One control, both
   * params, no way to get them out of step.
   */
  also?: { tileId: string; param: string }[];
  /** Shown under the control. */
  hint?: string;
  /**
   * Section heading to file this under — "What to make", "Size and timing".
   * Controls are grouped by this on the job page, in the order the groups first
   * appear. Anything without one goes to a trailing "Settings" section.
   */
  group?: string;
  /**
   * Show this frame-count parameter as seconds instead.
   *
   * Nobody thinks in frames, but every video model counts in them, and each one
   * only accepts frame counts on its own grid — LTX takes 8n+1, MiniMax H3
   * takes 17n+5. So the page asks for seconds and snaps to the nearest legal
   * frame count, reporting what it landed on.
   */
  seconds?: {
    /** Frames per second: a fixed rate, or read from another control. */
    fps: number | { tileId: string; param: string };
    /** The model's grid: step × n + offset. */
    step: number;
    offset: number;
  };
};

export type LineMode = 'parallel' | 'wired';

export type Line = {
  id: string;
  /** Only meaningful with 2+ tiles. Default 'parallel'. */
  mode: LineMode;
  /** Skip the whole line. One switch per line, not per tile. */
  bypassed: boolean;
  tiles: Tile[];
};

export type Tile = {
  id: string;
  moduleId: string;
  /** User override of the module's name. */
  label?: string;
  /** Overrides of the module's exposed params. */
  params: Record<string, unknown>;
  collapsed: boolean;
};

// ── Library ─────────────────────────────────────────────────────────────────

export type Port = {
  name: string;
  type: string;
  /**
   * An input the node can run without. Start/end-frame images are the case that
   * matters: ComfyUI declares them optional, so a module must be droppable
   * before they exist and simply leave them unwired.
   */
  optional?: boolean;
};

export type ParamType =
  | 'INT'
  | 'FLOAT'
  | 'STRING'
  | 'BOOLEAN'
  | 'ENUM'
  | 'IMAGE_UPLOAD';

export type Param = {
  name: string;
  label: string;
  type: ParamType;
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Multiline text box rather than a single-line input. STRING only. */
  multiline?: boolean;
  /** Pull `options` from /object_info at load time: the enum on this node input. */
  optionsFrom?: { class_type: string; input: string };
  /** Where the value lands in the module's partial graph. */
  target: { node: string; input: string };
};

/** A node inside a module's partial graph. */
export type ModuleNode = {
  class_type: string;
  inputs: Record<string, ModuleInputValue>;
};

/** Bind to one of the module's in-ports, resolved from the carry at compile time. */
export type PortRef = { $port: string };
/** Bind to another node inside the same module. */
export type NodeRef = { $node: string; out?: number };

export type ModuleInputValue = PortRef | NodeRef | string | number | boolean | null | unknown[];

export type Module = {
  id: string;
  name: string;
  category: string;
  /** Shown in the expanded tile footer — what this wraps. */
  description?: string;

  inPorts: Port[];
  outPorts: Port[];
  /** inPort name → outPort name, same type. Used when the tile is bypassed. */
  passThrough?: Record<string, string>;

  params: Param[];

  nodes: Record<string, ModuleNode>;

  /**
   * Which local node + output index backs each out-port.
   * Keyed by out-port name. Defaults to the sole node when the module has one node.
   */
  outputs?: Record<string, { node: string; out?: number }>;

  /** Collapsed-tile summary: param names to show, e.g. ['width','frames']. */
  summary?: string[];

  /** True if this module ends in a SaveImage/PreviewImage/video-combine style node. */
  terminal?: boolean;
};

export type ModuleLibrary = Record<string, Module>;

// ── Type guards ─────────────────────────────────────────────────────────────

export function isPortRef(v: unknown): v is PortRef {
  return typeof v === 'object' && v !== null && '$port' in v;
}

export function isNodeRef(v: unknown): v is NodeRef {
  return typeof v === 'object' && v !== null && '$node' in v;
}

// ── Compile output ──────────────────────────────────────────────────────────

/** A connection in API format: [source_node_id, output_index]. */
export type Link = [string, number];

export type PromptNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

/** ComfyUI API-format prompt: node id → node. */
export type ApiPrompt = Record<string, PromptNode>;

export type CarryEntry = {
  nodeId: string;
  outIndex: number;
  type: string;
  /** Which tile produced this, so a consumer can say where its input came from. */
  tileId?: string;
};
export type Carry = Map<string, CarryEntry>;
/** A carry entry with its port name, for serialising a carry out of the compiler. */
export type NamedCarryEntry = CarryEntry & { name: string };

export type CompileIssue = {
  /** Which tile to surface this against. Absent = stack-level (e.g. no terminal). */
  tileId?: string;
  severity: 'error' | 'warning';
  code:
    | 'unknown-module'
    | 'unresolved-port'
    | 'bypass-unsafe'
    | 'no-terminal'
    | 'bad-node-ref'
    | 'missing-output'
    | 'empty-file';
  message: string;
};

export type CompileResult = {
  prompt: ApiPrompt;
  /** node id → tile id. Every websocket message identifies a node; this maps it back. */
  tileMap: Record<string, string>;
  /** The carry as it stood at the start of each line, by line id. Drives drop validity. */
  carryAtLine: Record<string, NamedCarryEntry[]>;
  /** The carry after the whole stack ran. */
  finalCarry: NamedCarryEntry[];
  issues: CompileIssue[];
  ok: boolean;
};
