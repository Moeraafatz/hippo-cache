export { HippoCacheEngine } from './core/engine.js';
export { openStore } from './db/store.js';
export {
  computeBaseLevelActivation,
  updateStabilityOnAccess,
  classifyHealth,
  sampleDecayCurve
} from './core/actr.js';
export { runPersonalizedPageRank } from './core/graph.js';
export { packSubmodularKnapsack } from './core/knapsack.js';
export {
  scrubSecrets,
  estimateTokens,
  embedText,
  cosineSimilarity,
  computeSimHash,
  hammingDistance,
  extractEntities,
  inferSlotKey,
  detectContradictionCue,
  compressMemory
} from './core/text.js';
