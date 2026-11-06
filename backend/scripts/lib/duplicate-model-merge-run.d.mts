// Types for duplicate-model-merge-run.mjs (see its header).
export type ModelWorld = { models: unknown[]; near: Map<string, string[]>; skus: unknown[]; bindings: unknown[] };

export function readModelWorld(sql: any, w: { co: number; groups: unknown[]; idle: unknown[] }): Promise<ModelWorld>;
export function bindingFill(world: ModelWorld, f: unknown): { kind: string; bindingId: string };
export function writeModelGroup(sql: any, w: { co: number; plan: unknown; world: ModelWorld; log: (m: string) => void }): Promise<string>;
export function verifyModelGroup(v: any, w: { co: number; plan: unknown; modelId: string }): Promise<string[]>;
