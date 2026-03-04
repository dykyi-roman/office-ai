<script lang="ts">
  import { getSettings, setSetting } from "$lib/stores/index.svelte";
  import { t, SUPPORTED_LOCALES } from "$lib/i18n/index";
  import type { Locale } from "$lib/i18n/translations";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  const settings = $derived(getSettings());

  // Close on Escape key
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && open) {
      onClose();
    }
  }

  // Active section tab
  let activeSection = $state<"general" | "discovery" | "display">(
    "general",
  );

  // Bug report generation
  let bugReportGenerating = $state(false);

  async function generateBugReport(): Promise<void> {
    if (bugReportGenerating) return;
    bugReportGenerating = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("generate_bug_report");
    } catch {
      console.info("Bug report not available in dev mode");
    } finally {
      bugReportGenerating = false;
    }
  }

  const SECTION_IDS = ["general", "discovery", "display"] as const;
  type SectionId = (typeof SECTION_IDS)[number];

  const SECTION_KEYS: Record<SectionId, Parameters<typeof t>[0]> = {
    general: "settings.general",
    discovery: "settings.discovery",
    display: "settings.display",
  };
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- Modal backdrop -->
  <button
    class="modal-backdrop"
    aria-label={t("settings.closeSettings")}
    onclick={onClose}
    tabindex="-1"
  ></button>

  <!-- Modal panel -->
  <div
    class="settings-modal panel"
    role="dialog"
    aria-modal="true"
    aria-label={t("settings.title")}
  >
    <!-- Modal header -->
    <header class="modal-header">
      <h2 class="modal-title">{t("settings.title")}</h2>
      <button class="close-btn" aria-label={t("settings.closeSettings")} onclick={onClose}>
        &#x2715;
      </button>
    </header>

    <!-- Section tabs -->
    <nav class="section-tabs" aria-label={t("settings.settingsSections")}>
      {#each SECTION_IDS as sectionId}
        <button
          class="tab-btn"
          class:active={activeSection === sectionId}
          onclick={() => (activeSection = sectionId)}
          aria-selected={activeSection === sectionId}
          role="tab"
        >{t(SECTION_KEYS[sectionId])}</button>
      {/each}
    </nav>

    <!-- Section content -->
    <div class="modal-body custom-scrollbar">

      <!-- GENERAL -->
      {#if activeSection === "general"}
        <fieldset class="settings-section">
          <legend class="section-title">{t("settings.general")}</legend>

          <div class="setting-row">
            <label for="theme-select" class="setting-label">{t("settings.theme")}</label>
            <select
              id="theme-select"
              class="input select"
              value={settings.theme}
              onchange={(e) => setSetting("theme", (e.currentTarget as HTMLSelectElement).value as typeof settings.theme)}
            >
              <option value="modern">{t("settings.themeModern")}</option>
            </select>
          </div>

          <div class="setting-row">
            <label for="language-select" class="setting-label">{t("settings.language")}</label>
            <select
              id="language-select"
              class="input select"
              value={settings.language}
              onchange={(e) => setSetting("language", (e.currentTarget as HTMLSelectElement).value as Locale)}
            >
              {#each SUPPORTED_LOCALES as locale}
                <option value={locale.value}>{locale.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-row">
            <span class="setting-label">{t("settings.sound")}</span>
            <label class="toggle" aria-label={t("settings.toggleSound")}>
              <input
                type="checkbox"
                checked={settings.soundEnabled}
                onchange={(e) => setSetting("soundEnabled", (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="toggle-track"></span>
              <span class="toggle-thumb"></span>
            </label>
          </div>

        </fieldset>
      {/if}

      <!-- DISCOVERY -->
      {#if activeSection === "discovery"}
        <fieldset class="settings-section">
          <legend class="section-title">{t("settings.discovery")}</legend>

          <div class="setting-row setting-row--column">
            <label for="scan-interval" class="setting-label">
              {t("settings.scanInterval")} <strong>{settings.scanInterval}s</strong>
            </label>
            <input
              id="scan-interval"
              type="range"
              class="slider"
              min="1"
              max="10"
              step="1"
              value={settings.scanInterval}
              oninput={(e) => setSetting("scanInterval", Number((e.currentTarget as HTMLInputElement).value))}
            />
            <div class="range-labels">
              <span>1s</span><span>10s</span>
            </div>
          </div>

          <div class="setting-row setting-row--column">
            <label for="custom-log-paths" class="setting-label">
              {t("settings.customLogPaths")}
            </label>
            <textarea
              id="custom-log-paths"
              class="input textarea"
              rows="3"
              placeholder={t("settings.customLogPathsPlaceholder")}
              value={settings.customLogPaths}
              oninput={(e) => setSetting("customLogPaths", (e.currentTarget as HTMLTextAreaElement).value)}
            ></textarea>
          </div>
        </fieldset>
      {/if}

      <!-- DISPLAY -->
      {#if activeSection === "display"}
        <fieldset class="settings-section">
          <legend class="section-title">{t("settings.display")}</legend>

          <div class="setting-row setting-row--column">
            <label for="max-agents" class="setting-label">
              {t("settings.maxAgents")} <strong>{settings.maxAgents}</strong>
            </label>
            <input
              id="max-agents"
              type="range"
              class="slider"
              min="1"
              max="50"
              step="1"
              value={settings.maxAgents}
              oninput={(e) => setSetting("maxAgents", Number((e.currentTarget as HTMLInputElement).value))}
            />
            <div class="range-labels">
              <span>1</span><span>50</span>
            </div>
          </div>

          <div class="setting-row setting-row--column">
            <label for="anim-speed" class="setting-label">
              {t("settings.animationSpeed")} <strong>{settings.animationSpeed.toFixed(1)}x</strong>
            </label>
            <input
              id="anim-speed"
              type="range"
              class="slider"
              min="0.5"
              max="2.0"
              step="0.1"
              value={settings.animationSpeed}
              oninput={(e) => setSetting("animationSpeed", Number((e.currentTarget as HTMLInputElement).value))}
            />
            <div class="range-labels">
              <span>0.5x</span><span>2.0x</span>
            </div>
          </div>

          <div class="setting-row">
            <span class="setting-label">{t("settings.showMetrics")}</span>
            <label class="toggle" aria-label={t("settings.toggleMetrics")}>
              <input
                type="checkbox"
                checked={settings.showAgentMetrics}
                onchange={(e) => setSetting("showAgentMetrics", (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="toggle-track"></span>
              <span class="toggle-thumb"></span>
            </label>
          </div>

          <div class="setting-row">
            <span class="setting-label">{t("settings.showPrompts")}</span>
            <label class="toggle" aria-label={t("settings.togglePrompts")}>
              <input
                type="checkbox"
                checked={settings.showPrompts}
                onchange={(e) => setSetting("showPrompts", (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="toggle-track"></span>
              <span class="toggle-thumb"></span>
            </label>
          </div>
        </fieldset>
      {/if}



    </div>

    <!-- Footer with auto-save notice and bug report -->
    <footer class="modal-footer">
      <button
        class="bug-report-btn"
        onclick={generateBugReport}
        disabled={bugReportGenerating}
        title={t("settings.bugReportLabel")}
      >
        {bugReportGenerating ? t("settings.bugReportGenerating") : t("settings.bugReport")}
      </button>
      <span class="autosave-notice">{t("settings.autoSave")}</span>
    </footer>
  </div>
{/if}

<style>
  /* Backdrop */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--color-bg-overlay);
    backdrop-filter: var(--blur-overlay);
    -webkit-backdrop-filter: var(--blur-overlay);
    z-index: calc(var(--z-modal) - 1);
    border: none;
    cursor: default;
    pointer-events: all;
    animation: fade-in 200ms ease;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* Modal panel */
  .settings-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 480px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 80px);
    z-index: var(--z-modal);
    display: flex;
    flex-direction: column;
    pointer-events: all;
    animation: modal-in 200ms ease;
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translate(-50%, -48%);
    }
    to {
      opacity: 1;
      transform: translate(-50%, -50%);
    }
  }

  /* Header */
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .modal-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0;
  }

  .close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: 50%;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: 12px;
    transition:
      background var(--transition-fast),
      color var(--transition-fast);
  }

  .close-btn:hover {
    background: var(--color-bg-hover);
    color: var(--color-text-primary);
  }

  /* Section tabs */
  .section-tabs {
    display: flex;
    gap: 2px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .tab-btn {
    padding: 5px 12px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--color-text-secondary);
    font-size: 12px;
    cursor: pointer;
    transition:
      background var(--transition-fast),
      color var(--transition-fast),
      border-color var(--transition-fast);
  }

  .tab-btn:hover {
    background: var(--color-bg-hover);
    color: var(--color-text-primary);
  }

  .tab-btn.active {
    background: rgba(74, 158, 255, 0.15);
    border-color: rgba(74, 158, 255, 0.3);
    color: var(--color-accent-blue);
  }

  /* Modal body */
  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    min-height: 0;
  }

  /* Settings sections */
  .settings-section {
    border: none;
    margin: 0;
    padding: 8px 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .section-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-text-muted);
    margin-bottom: 12px;
    padding: 0;
    display: block;
  }

  /* Individual setting row */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .setting-row:last-child {
    border-bottom: none;
  }

  .setting-row--column {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .setting-label {
    font-size: 12px;
    color: var(--color-text-primary);
    flex: 1;
  }

  /* Select dropdown */
  .select {
    max-width: 160px;
    cursor: pointer;
    appearance: auto;
  }

  /* Textarea */
  .textarea {
    resize: vertical;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.6;
  }

  /* Range labels */
  .range-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--color-text-muted);
    margin-top: 2px;
  }

  /* Toggle reused from styles.css but scoped */
  .toggle {
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
    cursor: pointer;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
    position: absolute;
  }

  .toggle-track {
    position: absolute;
    inset: 0;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    transition: background var(--transition-base), border-color var(--transition-base);
  }

  .toggle input:checked + .toggle-track {
    background: rgba(74, 158, 255, 0.4);
    border-color: var(--color-accent-blue);
  }

  .toggle-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 12px;
    height: 12px;
    background: #e0e0e0;
    border-radius: 50%;
    transition: transform var(--transition-base);
    pointer-events: none;
  }

  .toggle input:checked ~ .toggle-thumb {
    transform: translateX(16px);
  }

  /* Footer */
  .modal-footer {
    padding: 10px 20px;
    border-top: 1px solid var(--color-border);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .autosave-notice {
    font-size: 10px;
    color: var(--color-text-muted);
    font-style: italic;
  }

  .bug-report-btn {
    padding: 4px 10px;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-secondary);
    font-size: 11px;
    cursor: pointer;
    transition:
      background var(--transition-fast),
      color var(--transition-fast),
      border-color var(--transition-fast);
  }

  .bug-report-btn:hover:not(:disabled) {
    background: var(--color-bg-hover);
    color: var(--color-text-primary);
    border-color: var(--color-accent-blue);
  }

  .bug-report-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
