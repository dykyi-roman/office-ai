<script lang="ts">
  import {
    getTotalTokensIn,
    getTotalTokensOut,
    getTotalSubAgents,
    getAgentCount,
    getSelectedAgent,
    getSetting,
  } from "$lib/stores/index.svelte";
  import { formatTokens } from "./utils";
  import { t } from "$lib/i18n/index";

  // Reactive derived values from stores
  const tokensIn = $derived(() => {
    const selected = getSelectedAgent();
    return selected ? selected.tokensIn : getTotalTokensIn();
  });

  const tokensOut = $derived(() => {
    const selected = getSelectedAgent();
    return selected ? selected.tokensOut : getTotalTokensOut();
  });

  const agentCount = $derived(() => getAgentCount());

  const subAgents = $derived(() => {
    const selected = getSelectedAgent();
    return selected ? selected.subAgents.length : getTotalSubAgents();
  });

  const label = $derived(() => {
    const selected = getSelectedAgent();
    return selected ? selected.name : t("metrics.metrics");
  });

  const showAgentMetrics = $derived(getSetting("showAgentMetrics"));

  // Animated display values
  let displayIn = $state(0);
  let displayOut = $state(0);
  let displaySub = $state(0);

  // Animate token counts toward target values
  $effect(() => {
    const targetIn = tokensIn();
    animateValue("in", targetIn);
  });

  $effect(() => {
    const targetOut = tokensOut();
    animateValue("out", targetOut);
  });

  $effect(() => {
    const targetSub = subAgents();
    animateValue("sub", targetSub);
  });

  let animInId: ReturnType<typeof requestAnimationFrame> | null = null;
  let animOutId: ReturnType<typeof requestAnimationFrame> | null = null;
  let animSubId: ReturnType<typeof requestAnimationFrame> | null = null;

  function animateValue(which: "in" | "out" | "sub", target: number): void {
    const getCurrent = () => which === "in" ? displayIn : which === "out" ? displayOut : displaySub;
    const setCurrent = (v: number) => {
      if (which === "in") displayIn = v;
      else if (which === "out") displayOut = v;
      else displaySub = v;
    };
    const getAnimId = () => which === "in" ? animInId : which === "out" ? animOutId : animSubId;
    const setAnimId = (id: ReturnType<typeof requestAnimationFrame> | null) => {
      if (which === "in") animInId = id;
      else if (which === "out") animOutId = id;
      else animSubId = id;
    };

    const currentAnimId = getAnimId();
    if (currentAnimId !== null) cancelAnimationFrame(currentAnimId);

    const start = getCurrent();
    const diff = target - start;
    if (Math.abs(diff) < 1) {
      setCurrent(target);
      return;
    }
    const startTime = performance.now();
    const duration = 600;
    function step(now: number): void {
      const elapsed = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - elapsed, 3);
      setCurrent(Math.round(start + diff * ease));
      if (elapsed < 1) {
        setAnimId(requestAnimationFrame(step));
      } else {
        setCurrent(target);
      }
    }
    setAnimId(requestAnimationFrame(step));
  }
</script>

{#if showAgentMetrics}
  <div class="agent-metrics panel" role="status" aria-label={t("metrics.agentMetrics")}>
    <div class="hud-label">{label()}</div>
    <div class="metric-row">
      <span class="metric-badge in" aria-label={t("metrics.tokensIn")}>IN</span>
      <span class="metric-value mono">{formatTokens(displayIn)}</span>
    </div>
    <div class="metric-row">
      <span class="metric-badge out" aria-label={t("metrics.tokensOut")}>OUT</span>
      <span class="metric-value mono">{formatTokens(displayOut)}</span>
    </div>
    <hr class="metric-divider" />
    <div class="metric-row">
      <span class="metric-badge agn" aria-label={t("metrics.agentCount")}>AGN</span>
      <span class="metric-value mono">{agentCount()}</span>
    </div>
    <div class="metric-row">
      <span class="metric-badge sub" aria-label={t("sidebar.subAgents")}>SUB</span>
      <span class="metric-value mono">{displaySub}</span>
    </div>
  </div>
{/if}

<style>
  .agent-metrics {
    padding: 10px 14px;
    min-width: 130px;
    pointer-events: all;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .hud-label {
    font-size: 10px;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 2px;
  }

  .metric-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .metric-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .metric-badge.in {
    color: var(--color-accent-green);
    background: rgba(34, 197, 94, 0.12);
  }

  .metric-badge.out {
    color: var(--color-accent-blue);
    background: rgba(74, 158, 255, 0.12);
  }

  .metric-divider {
    border: none;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    margin: 2px 0;
  }

  .metric-badge.agn {
    color: var(--color-accent-orange, #f59e0b);
    background: rgba(245, 158, 11, 0.12);
  }

  .metric-badge.sub {
    color: var(--color-accent-purple);
    background: rgba(168, 85, 247, 0.12);
  }

  .metric-value {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-primary);
    text-align: right;
  }
</style>
