<script lang="ts">
  import { onMount } from "svelte";
  import { initAgentsStore } from "$lib/stores/agents.svelte";
  import { initSettingsStore } from "$lib/stores/settings.svelte";
  import { selectAgent } from "$lib/stores/office.svelte";
  import { OfficeScene } from "$lib/renderer";
  import { initSoundBridge, destroySoundBridge } from "$lib/sound";
  import AgentSidebar from "$lib/ui/AgentSidebar.svelte";
  import StatusBar from "$lib/ui/StatusBar.svelte";
  import AgentMetrics from "$lib/ui/AgentMetrics.svelte";
  import SettingsPanel from "$lib/ui/SettingsPanel.svelte";
  import { t } from "$lib/i18n/index";
  import "$lib/ui/styles.css";

  // Settings panel visibility
  let settingsOpen = $state(false);

  // PixiJS scene instance
  let scene: OfficeScene | null = null;

  // Handle keyboard shortcuts globally
  function onKeydown(event: KeyboardEvent): void {
    // Ctrl+, or Cmd+, — open settings
    if ((event.ctrlKey || event.metaKey) && event.key === ",") {
      event.preventDefault();
      settingsOpen = !settingsOpen;
    }
  }

  // Listen for agent selection events dispatched from PixiJS scene
  function onAgentSelect(event: Event): void {
    const customEvent = event as CustomEvent<{ id: string }>;
    selectAgent(customEvent.detail.id);
  }

  onMount(() => {
    // Initialize stores first, then renderer (renderer reads store for mock data fallback)
    void initSettingsStore();
    void initSoundBridge();

    const startup = async () => {
      await initAgentsStore();

      const canvas = document.getElementById("office-canvas");
      if (canvas) {
        scene = new OfficeScene();
        await scene.init(canvas);
      }
    };

    startup().catch((err) => {
      console.error("[App] Failed to initialize:", err);
    });

    // Register agent selection listener (emitted by PixiJS renderer)
    window.addEventListener("office:select-agent", onAgentSelect);

    return () => {
      window.removeEventListener("office:select-agent", onAgentSelect);
      destroySoundBridge();
      scene?.destroy();
      scene = null;
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<!-- PixiJS canvas container — renderer mounts here -->
<div id="office-canvas" aria-label="OfficeAI visualization" role="img"></div>

<!-- UI Overlay layer — all Svelte components sit above the canvas -->
<div class="overlay-root" aria-label="UI overlay" role="region">

  <!-- Floating HUD widgets (top-right) -->
  <div class="hud-stack">
    <AgentMetrics />
  </div>

  <!-- Settings toggle button (top-left) -->
  <button
    class="settings-trigger btn"
    aria-label={t("app.openSettings")}
    title={t("app.settingsShortcut")}
    onclick={() => (settingsOpen = true)}
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
    </svg>
    {t("app.settings")}
  </button>

</div>

<!-- Agent sidebar (slide-in from right) -->
<AgentSidebar />

<!-- Status bar (fixed bottom) -->
<StatusBar />

<!-- Settings panel (modal) -->
<SettingsPanel
  open={settingsOpen}
  onClose={() => (settingsOpen = false)}
/>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #0a0a14;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    color: #e0e0e0;
  }

  /* PixiJS canvas fills the viewport */
  #office-canvas {
    position: fixed;
    inset: 0;
    z-index: 0;
  }

  /* HUD widgets stack — top-right */
  .hud-stack {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: var(--z-hud);
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }

  /* Settings button — top-left, always visible */
  .settings-trigger {
    position: fixed;
    top: 16px;
    left: 16px;
    z-index: var(--z-hud);
    pointer-events: all;
    font-size: 12px;
  }
</style>
