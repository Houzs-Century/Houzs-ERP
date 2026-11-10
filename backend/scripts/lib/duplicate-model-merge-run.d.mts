// Types for duplicate-model-merge-run.mjs (see its header).
export type ModelWorld = { models: unknown[]; near: Map<string, string[]>; skus: unknown[]; bindings: unknown[] };

export function readModelWorld(sql: any, w: { co: number; groups: unknown[]; idle: unknown[] }): Promise<ModelWorld>;
export function bindingFill(world: ModelWorld, f: unknown): { kind: string; bindingId: string };
export function writeModelGroup(sql: any, w: { co: number; plan: unknown; world: ModelWorld; log: (m: string) => void }): Promise<string>;
export function verifyModelGroup(v: any, w: { co: number; plan: unknown; modelId: string }): Promise<string[]>;
export const SOFA_KEYED: string[];
export function planModelFold(sql: any, w: { co: number; keep: string; drops: string[]; retiring: Set<string> | null }): Promise<{
  world: ModelWorld; plan: any; keptActive: boolean; refuse: (refusals: string[]) => any;
}>;
export function readFoldInputs(sql: any, w: { co: number; codes: string[] }): Promise<{
  codeModels: Map<string, { model_id: string | null; model_code: string | null; status: string }>;
  activeByModel: Map<string, number>;
}>;
