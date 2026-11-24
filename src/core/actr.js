/**
 * ACT-R Base-Level Activation + Ebbinghaus Spaced-Repetition Stability Model.
 *
 * Grounded in:
 * - Anderson & Schooler (1991), "Reflections of the Environment in Memory", Psychological Science.
 * - Ebbinghaus (1885), Power-law / Spacing forgetting dynamics.
 * - Park et al. (2023), "Generative Agents" (arXiv:2304.03442).
 *
 * Formula:
 *   B_i(t) = ln( sum_{j=1..n} max((t - t_j) / (tau * S_i), eps)^(-d) ) + beta_kind + gamma * I_i
 *   A_i(t) = sigmoid(B_i(t)) in (0, 1)
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export const KIND_PRIORS = {
  working: -0.75,    // Ephemeral scratchpad decays fast unless promoted
  episodic: -0.15,   // Specific session logs fade over days unless reinforced
  semantic: 0.45,    // Architecture facts & decisions resist rapid decay
  procedural: 0.70   // Learned playbooks & bug-fix rules retain longest
};

export const KIND_DECAY_RATES = {
  working: 0.72,
  episodic: 0.52,
  semantic: 0.36,
  procedural: 0.28
};

export function sigmoid(x) {
  if (x >= 20) return 1;
  if (x <= -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function computeBaseLevelActivation({
  accessTimestamps,
  nowMs = Date.now(),
  kind = 'semantic',
  importance = 0.6,
  stability = 1.0,
  tauMs = 12 * MS_PER_HOUR
}) {
  const d = KIND_DECAY_RATES[kind] ?? 0.45;
  const beta = KIND_PRIORS[kind] ?? 0.0;
  const effTau = Math.max(MS_PER_HOUR, tauMs * Math.max(0.25, stability));
  const timestamps = accessTimestamps && accessTimestamps.length > 0 ? accessTimestamps : [nowMs];

  let powerSum = 0;
  for (const ts of timestamps) {
    const dt = Math.max(0, nowMs - ts);
    const scaled = Math.max(dt / effTau, 0.02);
    powerSum += Math.pow(scaled, -d);
  }

  const rawB = Math.log(Math.max(powerSum, 1e-9)) + beta + 1.15 * (importance - 0.5);
  const activation = sigmoid(rawB);
  return { rawB, activation };
}

/**
 * Spacing Effect (Ebbinghaus / FSRS):
 * Re-accessing a memory after a meaningful time gap increases stability S_i significantly;
 * rapid back-to-back hits within seconds yield tiny stability gains (anti-spam).
 */
export function updateStabilityOnAccess(currentStability, lastAccessedAt, nowMs = Date.now()) {
  const gapHours = Math.max(0, (nowMs - (lastAccessedAt || nowMs)) / MS_PER_HOUR);
  // Logarithmic spacing bonus saturating smoothly up to 12x base stability.
  const gain = gapHours < 0.05 ? 0.02 : 0.18 * Math.log1p(gapHours);
  return Math.min(12.0, Number((Math.max(0.5, currentStability) + gain).toFixed(4)));
}

/**
 * Strict 3-indicator health classification (Green / Yellow / Red).
 */
export function classifyHealth(activation, status = 'active') {
  if (status === 'superseded') {
    return { color: 'yellow', label: 'SUPERSEDED', code: 'superseded' };
  }
  if (status === 'archived') {
    return { color: 'red', label: 'ARCHIVED', code: 'archived' };
  }
  if (activation >= 0.55) {
    return { color: 'green', label: 'ACTIVE', code: 'active' };
  }
  if (activation >= 0.25) {
    return { color: 'yellow', label: 'DECAYING', code: 'decaying' };
  }
  return { color: 'red', label: 'STALE', code: 'stale' };
}

export function sampleDecayCurve({
  accessTimestamps,
  kind = 'semantic',
  importance = 0.6,
  stability = 1.0,
  startMs = Date.now(),
  horizonDays = 30,
  steps = 30
}) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const day = (horizonDays * i) / steps;
    const t = startMs + day * MS_PER_DAY;
    const relevantAccesses = accessTimestamps.filter((ts) => ts <= t);
    const { activation } = computeBaseLevelActivation({
      accessTimestamps: relevantAccesses.length > 0 ? relevantAccesses : [startMs],
      nowMs: t,
      kind,
      importance,
      stability
    });
    points.push({ day: Number(day.toFixed(2)), activation: Number(activation.toFixed(4)) });
  }
  return points;
}
