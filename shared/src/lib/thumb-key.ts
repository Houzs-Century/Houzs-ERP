/** Deterministic sibling suffix for thumbnail objects in R2 (imagePipeline.ts
 *  re-exports it; kept in its own DOM-free file so the Worker-bundled PDF code
 *  can read it). The backend mirrors this constant. */
export const THUMB_KEY_SUFFIX = ".thumb";
