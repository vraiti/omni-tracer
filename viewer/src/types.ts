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
  targetUuid: string;
  id: string;
}

export interface EdgeInfo {
  refEl: Element;
  targetEl: Element;
  targetUuid: string;
  srcRoot: Element;
  tgtRoot: Element;
  sameRoot: boolean;
  refRect: Rect;
  tgtRect: Rect;
  srcRootRect: Rect;
  tgtRootRect: Rect;
}
