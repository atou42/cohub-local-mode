import type {
  BoardItem,
  BoardPatch,
  BoardScript,
  BoardVec2,
} from "@cohub/protocol";

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
export type BoardScriptHit = {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  cursor?: string;
};
export type BoardScriptSnapshot = {
  state: Record<string, unknown>;
  time: number;
  random: number;
  configuration?: string;
  effects?: Pick<BoardScriptOutput, "patches" | "items" | "hits" | "space">;
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
  random(): number;
  on(type: string, handler: (event: BoardScriptEvent) => void): () => void;
  onFrame(handler: (frame: BoardScriptFrame) => void): () => void;
  onDispose(handler: () => void): void;
  invalidate(): void;
  get(id: string): BoardItem | undefined;
  present(id: string, patch: BoardScriptItemPatch | null): void;
  scene(
    items: Record<string, unknown>,
    options?: { space?: "world" | "screen" },
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
