<script lang="ts">
  import type { Status } from "$lib/types/index";
  import { statusColor, formatTime } from "./utils";
  import { t } from "$lib/i18n/index";

  interface LogEntry {
    timestamp: Date;
    status: Status;
    message: string;
  }

  interface Props {
    entries: LogEntry[];
  }

  let { entries }: Props = $props();

  // Keep last 10 entries
  const visibleEntries = $derived(entries.slice(-10));

  let scrollEl = $state<HTMLDivElement | null>(null);

  // Auto-scroll to bottom when entries change
  $effect(() => {
    // Reference visibleEntries to create reactivity dependency
    if (visibleEntries.length >= 0 && scrollEl) {
      // Use microtask to scroll after DOM update
      Promise.resolve().then(() => {
        if (scrollEl) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
        }
      });
    }
  });
</script>

<div class="mini-log custom-scrollbar" bind:this={scrollEl}>
  {#if visibleEntries.length === 0}
    <p class="empty">{t("miniLog.noEvents")}</p>
  {:else}
    {#each visibleEntries as entry (entry.timestamp.getTime())}
      <div class="log-entry">
        <span class="timestamp mono">[{formatTime(entry.timestamp)}]</span>
        <span
          class="status-text"
          style:color={statusColor(entry.status)}
        >{entry.message}</span>
      </div>
    {/each}
  {/if}
</div>

<style>
  .mini-log {
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 160px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .log-entry {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 11px;
    line-height: 1.5;
  }

  .timestamp {
    color: var(--color-text-muted);
    flex-shrink: 0;
    font-size: 10px;
  }

  .status-text {
    word-break: break-word;
  }

  .empty {
    font-size: 11px;
    color: var(--color-text-muted);
    margin: 0;
    padding: 4px 0;
  }
</style>
