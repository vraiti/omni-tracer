export interface TraceObject {
  ref: string;
  owns: Record<string, string> | string[];
  process: string;
  created_by?: string;
  created_in?: string;
  attrs?: Record<string, string>;
}

export type TraceData = Record<string, TraceObject>;

export type ParentMap = Record<string, string[]>;

export type CreationOrder = Record<string, number>;

export type EffectiveParentMap = Record<string, string[]>;

export interface TraceFunction {
  ref: string;
  invokes: string[];
  instantiates: string[];
  process: string;
  bound_to?: string;
  coroutine?: string;
}

export type FunctionData = Record<string, TraceFunction>;

export interface FuncCallNode {
  ref: string;
  name: string;
  count: number;
  boundTo: string | null;
  children: FuncCallNode[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgePath {
  pts: Point[];
  targetId: string;
  id: string;
}

export interface EdgeInfo {
  refEl: Element;
  targetEl: Element;
  targetId: string;
  srcRoot: Element;
  tgtRoot: Element;
  sameRoot: boolean;
  refRect: Rect;
  tgtRect: Rect;
  srcRootRect: Rect;
  tgtRootRect: Rect;
}
