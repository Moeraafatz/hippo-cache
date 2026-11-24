import { cosineSimilarity } from './text.js';

/**
 * Submodular Marginal-Gain Knapsack Packer with 3-Tier Progressive Disclosure.
 *
 * Grounded in:
 * - Lin & Bilmes (ACL 2011), "A Class of Submodular Functions for Document Summarization"
 * - MIT CSAIL Recursive Language Models (Zhang, Kraska, Khattab, arXiv:2512.24601)
 * - LLMLingua extractive token budgeting (arXiv:2310.05736)
 *
 * Objective:
 *   Maximize sum_{m in S} U(m) - lambda * redundancy(S)
 *   subject to sum_{m in S} tokens_tier(m) <= budgetTokens
 *
 * Greedy approximation achieves (1 - 1/e) optimality guarantee for monotone submodular gains.
 */

export function chooseTierAndPayload(candidate, disclosure, remainingBudget, selectedCount) {
  const mode = (disclosure || 'auto').toLowerCase();

  if (mode === 'l0') {
    return { tier: 'L0', tokens: candidate.tokens_l0, text: candidate.title };
  }
  if (mode === 'l1') {
    return { tier: 'L1', tokens: candidate.tokens_l1, text: candidate.summary };
  }
  if (mode === 'l2') {
    return { tier: 'L2', tokens: candidate.tokens_l2, text: candidate.content };
  }

  // 'auto' progressive disclosure:
  // - Top 1-3 highest-utility memories get L1 (or L2 if verbatim payload is already concise <= 75 tokens).
  // - Remaining budget packs high-coverage L0 handles so the agent sees the full associative graph
  //   and can selectively hydrate verbatim L2 via memory_expand(ids) (MIT RLM pattern).
  if (selectedCount < 3) {
    if (candidate.tokens_l2 <= 75 && candidate.tokens_l2 <= remainingBudget) {
      return { tier: 'L2', tokens: candidate.tokens_l2, text: candidate.content };
    }
    if (candidate.tokens_l1 <= remainingBudget) {
      return { tier: 'L1', tokens: candidate.tokens_l1, text: candidate.summary };
    }
  } else if (selectedCount < 6 && candidate.score >= 0.72 && candidate.tokens_l1 <= remainingBudget * 0.45) {
    return { tier: 'L1', tokens: candidate.tokens_l1, text: candidate.summary };
  }

  return { tier: 'L0', tokens: candidate.tokens_l0, text: candidate.title };
}

export function packSubmodularKnapsack({
  candidates,
  budgetTokens = 600,
  disclosure = 'auto',
  redundancyLambda = 0.42,
  costExponent = 0.55,
  maxItems = 16
}) {
  if (!candidates || candidates.length === 0) {
    return { selected: [], tokensUsed: 0, budgetTokens };
  }

  const remaining = [...candidates];
  const selected = [];
  let tokensUsed = 0;

  while (remaining.length > 0 && selected.length < maxItems) {
    const budgetLeft = budgetTokens - tokensUsed;
    let bestIdx = -1;
    let bestDensity = -Infinity;
    let bestChoice = null;
    let bestGain = 0;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const choice = chooseTierAndPayload(cand, disclosure, budgetLeft, selected.length);

      // Enforce hard token budget (always permit at least 1 top item even if budget is tiny).
      if (selected.length > 0 && choice.tokens > budgetLeft) {
        // In auto mode, downgrade to L0 if L1 didn't fit.
        if ((disclosure || 'auto') === 'auto' && choice.tier !== 'L0' && cand.tokens_l0 <= budgetLeft) {
          choice.tier = 'L0';
          choice.tokens = cand.tokens_l0;
          choice.text = cand.title;
        } else {
          continue;
        }
      }

      // Compute maximum similarity to already-selected memories (submodular diversity penalty).
      let maxSim = 0;
      for (const picked of selected) {
        const sim = cosineSimilarity(cand.vector, picked.vector);
        if (sim > maxSim) maxSim = sim;
      }

      const marginalGain = cand.score * (1 - redundancyLambda * maxSim);
      // Skip near-zero gain redundant candidates once we have core anchors.
      if (selected.length >= 2 && marginalGain <= 0.03) continue;

      const density = marginalGain / Math.pow(Math.max(4, choice.tokens), costExponent);
      if (density > bestDensity) {
        bestDensity = density;
        bestIdx = i;
        bestChoice = choice;
        bestGain = marginalGain;
      }
    }

    if (bestIdx === -1) break;

    const [chosen] = remaining.splice(bestIdx, 1);
    tokensUsed += bestChoice.tokens;
    selected.push({
      ...chosen,
      disclosure_tier: bestChoice.tier,
      tokens_emitted: bestChoice.tokens,
      emitted_text: bestChoice.text,
      marginal_gain: Number(bestGain.toFixed(4))
    });
  }

  return {
    selected,
    tokensUsed,
    budgetTokens
  };
}
