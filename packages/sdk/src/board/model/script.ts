import type {
  BoardItem,
  BoardPatch,
  BoardScript,
  BoardVec2,
} from "@cohub/protocol";

export type BoardScriptView = {
  camera: { x: number; y: number; zoom: number };
  width: number;
  height: number;
  safeRect: { x: number; y: number; width: number; height: number };
};

export type BoardScriptAnchor = {
  item: string;
  point?: BoardVec2;
};

export type BoardScriptSceneOptions = {
  space?: "world" | "screen";
  anchor?: BoardScriptAnchor;
};

export type BoardScriptEvent = {
  type: string;
  target?: string;
  relatedTarget?: string;
  relatedOwner?: string;
  point?: BoardVec2;
  pointerId?: number;
  pointerType?: string;
  buttons?: number;
  key?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  data?: unknown;
};

export type BoardScriptHostEvents = {
  viewchange: BoardScriptView;
  selectionchange: { ids: string[] };
  transformend: { ids: string[]; operation: "move" | "resize" | "rotate" | "arrow"; cancelled: boolean };
};

export type BoardScriptEventOf<Type extends string> = BoardScriptEvent & {
  type: Type;
} & (Type extends keyof BoardScriptHostEvents ? { data: BoardScriptHostEvents[Type] } : unknown);

export type BoardScriptFrame = {
  t: number;
  dt: number;
  width: number;
  height: number;
  seed: string;
  params: BoardScript["params"];
  state: Record<string, unknown>;
};

export type BoardScriptItemPatch = Partial<
  Pick<BoardItem, "position" | "scale" | "rotation" | "opacity" | "style">
> & {
  size?: { width?: number; height?: number };
  props?: Record<string, unknown>;
};
export type BoardScriptHit = ({
  x: number;
  y: number;
  width: number;
  height: number;
} | { target: "self" } | { item: string }) & {
  label?: string;
  cursor?: string;
};
export type BoardScriptSnapshot = {
  state: Record<string, unknown>;
  time: number;
  random: number;
  configuration?: string;
  effects?: Pick<BoardScriptOutput, "patches" | "items" | "hits" | "space" | "anchor">;
};
export type BoardScriptParameter = {
  type: "number" | "boolean" | "string" | "color";
  label?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
};

export type BoardScriptOutput = {
  parameters?: Record<string, BoardScriptParameter>;
  space?: "world" | "screen";
  anchor?: BoardScriptAnchor;
  patches: Record<string, Record<string, unknown>>;
  items: Record<string, unknown>;
  hits: Record<string, BoardScriptHit>;
  listens: string[];
  animated: boolean;
  updating?: boolean;
  version: number;
};

export type BoardScriptContext = {
  readonly self: {
    readonly id: string;
    readonly base: BoardItem;
    present(patch: BoardScriptItemPatch | null): void;
  };
  readonly params: BoardScript["params"];
  readonly targets: Readonly<Record<string, string>>;
  emit(target: string, type: string, data?: unknown): Promise<void>;
  readonly state: Record<string, unknown>;
  readonly frame: BoardScriptFrame;
  readonly view: BoardScriptView | null;
  random(): number;
  on<Type extends string>(type: Type, handler: (event: BoardScriptEventOf<Type>) => void): () => void;
  onFrame(handler: (frame: BoardScriptFrame) => void): () => void;
  onDispose(handler: () => void): void;
  invalidate(): void;
  get(id: string): BoardItem | undefined;
  present(id: string, patch: BoardScriptItemPatch | null): void;
  scene(
    items: Record<string, unknown>,
    options?: BoardScriptSceneOptions,
  ): void;
  hitRegions(hits: Record<string, BoardScriptHit>): void;
  commit(patch: BoardPatch): Promise<void>;
  capabilities: {
    has(name: string): boolean;
    call(name: string, input?: unknown): Promise<unknown>;
  };
};

export type BoardScriptModule = {
  parameters?: Record<string, BoardScriptParameter>;
  default?:
    | ((context: BoardScriptContext) => void)
    | ((context: BoardScriptContext) => () => void);
  draw?: (context: CanvasRenderingContext2D, frame: BoardScriptFrame) => void;
  animated?: boolean;
};
