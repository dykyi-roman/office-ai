<script lang="ts">
  import type { AgentState, SubAgentInfo } from "$lib/types/index";
  import {
    getAllAgents,
    getActiveAgents,
    getIdleAgents,
    getTotalTokensIn,
    getTotalTokensOut,
    getTotalSubAgents,
    getAllSubAgents,
  } from "$lib/stores/index.svelte";
  import { formatTokens, formatUptime, tierColor, statusLabel } from "./utils";
  import { t } from "$lib/i18n/index";

  // Reactive store values
  const allAgents = $derived(getAllAgents());
  const activeAgents = $derived(getActiveAgents());
  const idleAgents = $derived(getIdleAgents());
  const totalIn = $derived(getTotalTokensIn());
  const totalOut = $derived(getTotalTokensOut());
  const totalSubAgents = $derived(getTotalSubAgents());
  const subAgentsList = $derived(getAllSubAgents());

  // App uptime (seconds since page load)
  const startTime = Date.now();
  let uptimeSeconds = $state(0);

  $effect(() => {
    const interval = setInterval(() => {
      uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    }, 10000);
    return () => clearInterval(interval);
  });

  interface TooltipState {
    visible: boolean;
    agents: AgentState[];
    x: number;
    y: number;
  }

  let tooltip = $state<TooltipState>({
    visible: false,
    agents: [],
    x: 0,
    y: 0,
  });

  const TOOLTIP_MIN_WIDTH = 160;
  const TOOLTIP_MARGIN = 16;

  function clampTooltipX(centerX: number): number {
    const halfWidth = TOOLTIP_MIN_WIDTH / 2;
    return Math.max(TOOLTIP_MARGIN + halfWidth, centerX);
  }

  function showTooltip(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    tooltip = {
      visible: true,
      agents: allAgents,
      x: clampTooltipX(centerX),
      y: rect.top - 8,
    };
  }

  function showTooltipFromFocus(event: FocusEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    tooltip = {
      visible: true,
      agents: allAgents,
      x: clampTooltipX(centerX),
      y: rect.top - 8,
    };
  }

  function hideTooltip(): void {
    tooltip = { ...tooltip, visible: false };
  }

  interface SubTooltipState {
    visible: boolean;
    items: SubAgentInfo[];
    x: number;
    y: number;
  }

  let subTooltip = $state<SubTooltipState>({
    visible: false,
    items: [],
    x: 0,
    y: 0,
  });

  function showSubTooltip(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    subTooltip = {
      visible: true,
      items: subAgentsList,
      x: clampTooltipX(centerX),
      y: rect.top - 8,
    };
  }

  function showSubTooltipFromFocus(event: FocusEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    subTooltip = {
      visible: true,
      items: subAgentsList,
      x: clampTooltipX(centerX),
      y: rect.top - 8,
    };
  }

  function hideSubTooltip(): void {
    subTooltip = { ...subTooltip, visible: false };
  }
</script>

<aside class="status-bar" aria-label={t("statusBar.agentStatusBar")}>
  <!-- Left: agent count -->
  <div class="section section--left">
    <button
      class="agents-pill"
      aria-label="{t('statusBar.agents')}: {allAgents.length}"
      onmouseenter={(e) => showTooltip(e as MouseEvent)}
      onmouseleave={hideTooltip}
      onfocus={(e) => showTooltipFromFocus(e)}
      onblur={hideTooltip}
    >
      <span class="agents-label">{t("statusBar.agents")}</span>
      <span class="agents-count">{allAgents.length}</span>
    </button>
    <button
      class="agents-pill sub-agents-pill"
      aria-label="{t('statusBar.subAgents')}: {totalSubAgents}"
      onmouseenter={(e) => showSubTooltip(e as MouseEvent)}
      onmouseleave={hideSubTooltip}
      onfocus={(e) => showSubTooltipFromFocus(e)}
      onblur={hideSubTooltip}
    >
      <span class="agents-label sub-label">{t("statusBar.subAgents")}</span>
      <span class="agents-count sub-count">{totalSubAgents}</span>
    </button>
  </div>

  <!-- Center: activity summary -->
  <div class="section section--center" aria-live="polite">
    <span class="activity">
      <span class="count active">{activeAgents.length}</span>
      <span class="activity-label">{t("statusBar.working")}</span>
      <span class="separator">,</span>
      <span class="count idle">{idleAgents.length}</span>
      <span class="activity-label">{t("statusBar.free")}</span>
    </span>
  </div>

  <!-- Right: aggregate stats -->
  <div class="section section--right">
    <span class="stat" title={t("statusBar.totalTokens")}>
      <span class="stat-in mono">{formatTokens(totalIn)} {t("statusBar.in")}</span>
      <span class="stat-separator">/</span>
      <span class="stat-out mono">{formatTokens(totalOut)} {t("statusBar.out")}</span>
    </span>
    <span class="stat-divider" aria-hidden="true">·</span>
    <span class="stat uptime" title={t("statusBar.appUptime")}>
      <span class="stat-label">{t("statusBar.up")}</span>
      <span class="mono">{formatUptime(uptimeSeconds)}</span>
    </span>
  </div>
</aside>

<!-- Agents tooltip -->
{#if tooltip.visible && tooltip.agents.length > 0}
  <div
    class="agents-tooltip panel"
    style:left="{tooltip.x}px"
    style:bottom="calc(100vh - {tooltip.y}px + 4px)"
    style:transform="translateX(-50%)"
    role="tooltip"
  >
    <div class="tooltip-header">{t("statusBar.agents")}</div>
    {#each tooltip.agents as agent}
      <div class="tooltip-agent">
        <span class="tooltip-dot" style:background={tierColor(agent.tier)}></span>
        <span class="tooltip-name">{agent.name}</span>
        <span class="tooltip-status">{statusLabel(agent.status)}</span>
      </div>
    {/each}
  </div>
{/if}

<!-- Sub-agents tooltip -->
{#if subTooltip.visible && subTooltip.items.length > 0}
  <div
    class="agents-tooltip sub-tooltip panel"
    style:left="{subTooltip.x}px"
    style:bottom="calc(100vh - {subTooltip.y}px + 4px)"
    style:transform="translateX(-50%)"
    role="tooltip"
  >
    <div class="tooltip-header">{t("statusBar.subAgents")}</div>
    {#each subTooltip.items as sub}
      <div class="tooltip-agent">
        <span class="tooltip-dot sub-dot"></span>
        <span class="tooltip-name sub-name">{sub.description}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .status-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    background: var(--color-bg-panel);
    backdrop-filter: var(--blur-panel);
    -webkit-backdrop-filter: var(--blur-panel);
    border-top: 1px solid var(--color-border);
    z-index: var(--z-statusbar);
    pointer-events: all;
    font-size: 12px;
    color: var(--color-text-secondary);
    gap: 16px;
  }

  .section {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }

  .section--center {
    justify-content: center;
  }

  .section--right {
    justify-content: flex-end;
  }

  /* Agents pill button */
  .agents-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 12px;
    cursor: pointer;
    transition:
      background var(--transition-fast),
      border-color var(--transition-fast);
    color: var(--color-text-secondary);
    font-size: 11px;
  }

  .agents-pill:hover,
  .agents-pill:focus {
    background: var(--color-bg-hover);
    border-color: rgba(255, 255, 255, 0.2);
    outline: none;
  }

  .agents-label {
    color: #f59e0b;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .agents-count {
    color: #f59e0b;
    font-weight: 700;
    font-size: 13px;
  }

  /* Activity summary */
  .activity {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .count {
    font-weight: 700;
    font-size: 13px;
  }

  .count.active {
    color: var(--color-accent-green);
  }

  .count.idle {
    color: var(--color-text-secondary);
  }

  .activity-label {
    color: var(--color-text-secondary);
  }

  .separator {
    color: var(--color-text-muted);
  }

  /* Stats */
  .stat {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
  }

  .stat-in {
    color: var(--color-accent-green);
  }

  .stat-out {
    color: var(--color-accent-blue);
  }

  .stat-separator {
    color: var(--color-text-muted);
  }

  .stat-divider {
    color: var(--color-text-muted);
    margin: 0 4px;
  }

  .stat-label {
    color: var(--color-text-muted);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.05em;
  }

  /* Agents tooltip */
  .agents-tooltip {
    position: fixed;
    padding: 8px 12px;
    min-width: 160px;
    pointer-events: none;
    z-index: var(--z-tooltip);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tooltip-header {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 4px;
    color: var(--color-text-muted);
  }

  .tooltip-agent {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .tooltip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .tooltip-name {
    color: var(--color-text-primary);
    font-weight: 500;
  }

  .tooltip-status {
    color: var(--color-text-muted);
    margin-left: auto;
    font-size: 10px;
  }

  /* Sub-agents pill */
  .sub-agents-pill {
    border-color: rgba(168, 85, 247, 0.15);
  }

  .sub-agents-pill:hover,
  .sub-agents-pill:focus {
    border-color: rgba(168, 85, 247, 0.35);
  }

  .sub-label {
    color: var(--color-accent-purple);
  }

  .sub-count {
    color: var(--color-accent-purple);
  }

  /* Sub-agents tooltip */
  .sub-tooltip {
    max-width: 360px;
    max-height: 240px;
    overflow-y: auto;
  }

  .sub-dot {
    background: var(--color-accent-purple);
  }

  .sub-name {
    color: var(--color-text-secondary);
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
