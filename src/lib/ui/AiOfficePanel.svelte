<script lang="ts">
  import {
    AI_OFFICE_AGENTS,
    getAiOfficeAgent,
    routeAiOfficeTask,
    runAiOfficeTask,
    type AiOfficeAgentId,
    type AiOfficeResponse,
  } from "$lib/ai-office/client";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  interface LogEntry {
    id: number;
    title: string;
    message: string;
    tone: "info" | "good" | "warn" | "error";
    timestamp: Date;
  }

  let { open, onClose }: Props = $props();

  let selectedAgentId = $state<AiOfficeAgentId>("pmo");
  let task = $state("Написать код сортировки на c++");
  let qualityScore = $state(85);
  let running = $state(false);
  let logs = $state<LogEntry[]>([]);
  let lastResponse = $state<AiOfficeResponse | null>(null);
  let currentAgent = $state("idle");
  let selectedRuntimeAgent = $state("не выбран");
  let iteration = $state(0);
  let workflowStatus = $state("ожидает запуска");
  let telegramStatus = $state("ожидает финала");
  let logCounter = 0;

  const selectedAgent = $derived(getAiOfficeAgent(selectedAgentId));

  function addLog(
    title: string,
    message: string,
    tone: LogEntry["tone"] = "info",
  ): void {
    logs = [
      ...logs,
      {
        id: ++logCounter,
        title,
        message,
        tone,
        timestamp: new Date(),
      },
    ];
  }

  function formatTime(date: Date): string {
    return date.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runWorkflow(): Promise<void> {
    if (running) return;

    running = true;
    logs = [];
    lastResponse = null;
    iteration = 0;
    telegramStatus = "ожидает финала";
    workflowStatus = "задача создана";

    const normalizedTask = task.trim() || "Проанализируй рынок SaaS";
    const routedAgent =
      selectedAgentId === "pmo" ? routeAiOfficeTask(normalizedTask) : selectedAgent;

    selectedRuntimeAgent = routedAgent.name;
    currentAgent = "user";
    addLog("01. User", `Задача создана: ${normalizedTask}`);
    await wait(280);

    currentAgent = "pmo";
    workflowStatus = "PMO анализирует задачу";
    addLog(
      "02. PMO",
      selectedAgentId === "pmo"
        ? `Выбран исполнитель: ${routedAgent.name}.`
        : `Прямой запуск агента: ${routedAgent.name}.`,
    );
    await wait(280);

    iteration = 1;
    currentAgent = routedAgent.id;
    workflowStatus = `${routedAgent.name} готовит результат`;
    addLog(`03. ${routedAgent.name}`, routedAgent.action);
    await wait(320);

    currentAgent = "pmo";
    workflowStatus = "PMO проверяет качество";
    addLog(
      "04. Quality Gate",
      `quality_score=${qualityScore}, порог приемки=70.`,
      qualityScore < 70 ? "warn" : "good",
    );

    if (qualityScore < 70) {
      iteration = 2;
      currentAgent = routedAgent.id;
      workflowStatus = "повторная итерация";
      addLog(
        "05. Возврат",
        "PMO просит усилить структуру, точность и полезность результата.",
        "warn",
      );
      await wait(320);
      currentAgent = "pmo";
      addLog("06. Повторная проверка", "Исправленная версия принята.", "good");
    }

    workflowStatus = "запуск реального агента";
    telegramStatus = `${routedAgent.name} генерирует ответ`;
    addLog("Финал", "Запускаю настоящего агента через AI Office API.", "good");

    try {
      const response = await runAiOfficeTask(routedAgent.id, normalizedTask);
      lastResponse = response;
      workflowStatus = "готово";
      telegramStatus = response.telegram_notified
        ? "уведомление отправлено"
        : "не отправлено";
      currentAgent = response.handled_by || routedAgent.id;
      selectedRuntimeAgent =
        response.handled_by_name || getAiOfficeAgent(currentAgent).name;

      addLog(
        `Ответ: ${selectedRuntimeAgent}`,
        response.result || "Агент завершил задачу без текстового ответа.",
        "good",
      );
      addLog(
        "Telegram",
        response.telegram_notified
          ? `Отправлено. Task ID: ${response.task_id || "n/a"}.`
          : "Backend завершил задачу, но Telegram не подтвердил отправку.",
        response.telegram_notified ? "good" : "warn",
      );
    } catch (error) {
      workflowStatus = "ошибка";
      telegramStatus = "не отправлено";
      addLog(
        "Ошибка",
        error instanceof Error ? error.message : String(error),
        "error",
      );
    } finally {
      running = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && open) {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <aside class="ai-office-panel panel" aria-label="AI Office" role="region">
    <header class="panel-header">
      <div>
        <h2>AI Office</h2>
        <span>PMO · агенты · Telegram</span>
      </div>
      <button class="btn close-btn" aria-label="Закрыть AI Office" onclick={onClose}>
        &#x2715;
      </button>
    </header>

    <section class="agent-strip" aria-label="AI Office agents">
      {#each AI_OFFICE_AGENTS as agent}
        <button
          class="agent-chip"
          class:active={selectedAgentId === agent.id}
          onclick={() => (selectedAgentId = agent.id)}
          title={agent.description}
        >
          <span>{agent.icon}</span>
          <strong>{agent.name}</strong>
        </button>
      {/each}
    </section>

    <section class="task-section">
      <textarea
        class="input task-input"
        rows="3"
        bind:value={task}
        placeholder="Опишите задачу..."
      ></textarea>
      <div class="quality-row">
        <label for="quality-range">Quality</label>
        <input
          id="quality-range"
          type="range"
          min="0"
          max="100"
          step="1"
          bind:value={qualityScore}
        />
        <span class="score">{qualityScore}</span>
      </div>
      <button class="btn btn--primary run-btn" onclick={runWorkflow} disabled={running}>
        {running ? "Работает..." : "Запустить"}
      </button>
    </section>

    <section class="state-grid" aria-label="State">
      <div><span>task</span><strong>{task || "без задачи"}</strong></div>
      <div><span>current_agent</span><strong>{currentAgent}</strong></div>
      <div><span>selected_agent</span><strong>{selectedRuntimeAgent}</strong></div>
      <div><span>iteration</span><strong>{iteration}</strong></div>
      <div><span>status</span><strong>{workflowStatus}</strong></div>
      <div><span>telegram</span><strong>{telegramStatus}</strong></div>
    </section>

    <section class="log custom-scrollbar" aria-label="AI Office log">
      {#if logs.length === 0}
        <p class="empty-log">Лог пуст</p>
      {:else}
        {#each logs as entry (entry.id)}
          <article class:tone-info={entry.tone === "info"} class:tone-good={entry.tone === "good"} class:tone-warn={entry.tone === "warn"} class:tone-error={entry.tone === "error"}>
            <time>{formatTime(entry.timestamp)}</time>
            <h3>{entry.title}</h3>
            <p>{entry.message}</p>
          </article>
        {/each}
      {/if}
    </section>

    {#if lastResponse}
      <footer class="result-footer">
        <span>{lastResponse.handled_by_name || selectedRuntimeAgent}</span>
        <span>{lastResponse.task_id}</span>
        <span class:sent={lastResponse.telegram_notified}>
          {lastResponse.telegram_notified ? "Telegram ✓" : "Telegram —"}
        </span>
      </footer>
    {/if}
  </aside>
{/if}

<style>
  .ai-office-panel {
    position: fixed;
    left: 16px;
    top: 62px;
    bottom: 58px;
    width: min(520px, calc(100vw - 32px));
    z-index: var(--z-sidebar);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-lg);
    pointer-events: all;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-md);
  }

  .panel-header h2 {
    margin: 0;
    font-size: 16px;
    line-height: 1.2;
  }

  .panel-header span {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .close-btn {
    padding-inline: 8px;
  }

  .agent-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-sm);
  }

  .agent-chip {
    display: flex;
    min-width: 0;
    min-height: 54px;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 2px;
    padding: 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-input);
    color: var(--color-text-primary);
    cursor: pointer;
    text-align: left;
    transition:
      background var(--transition-fast),
      border-color var(--transition-fast);
  }

  .agent-chip:hover,
  .agent-chip.active {
    background: rgba(74, 158, 255, 0.16);
    border-color: rgba(74, 158, 255, 0.45);
  }

  .agent-chip span {
    color: var(--color-accent-yellow);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .agent-chip strong {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-section {
    display: grid;
    gap: var(--space-sm);
  }

  .task-input {
    min-height: 82px;
    resize: vertical;
  }

  .quality-row {
    display: grid;
    grid-template-columns: 54px minmax(0, 1fr) 36px;
    align-items: center;
    gap: var(--space-sm);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .quality-row input {
    accent-color: var(--color-accent-blue);
  }

  .score {
    color: var(--color-text-primary);
    font-family: var(--font-mono);
    text-align: right;
  }

  .run-btn {
    justify-content: center;
    min-height: 34px;
  }

  .run-btn:disabled {
    cursor: not-allowed;
    opacity: 0.58;
  }

  .state-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-xs);
  }

  .state-grid div {
    min-width: 0;
    padding: 7px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: rgba(255, 255, 255, 0.04);
  }

  .state-grid span {
    display: block;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .state-grid strong {
    display: block;
    min-width: 0;
    overflow: hidden;
    color: var(--color-text-primary);
    font-size: 12px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .log {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    gap: var(--space-sm);
    overflow-y: auto;
    padding-right: 3px;
  }

  .log article {
    border-left: 3px solid var(--color-accent-blue);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: rgba(0, 0, 0, 0.22);
    padding: 8px 10px;
  }

  .log article.tone-good {
    border-left-color: var(--color-accent-green);
  }

  .log article.tone-warn {
    border-left-color: var(--color-accent-yellow);
  }

  .log article.tone-error {
    border-left-color: var(--color-accent-red);
  }

  .log time {
    float: right;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .log h3 {
    margin: 0 0 4px;
    font-size: 12px;
  }

  .log p {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .empty-log {
    margin: auto;
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
  }

  .result-footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .result-footer span {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    padding: 2px 8px;
    background: rgba(255, 255, 255, 0.04);
  }

  .result-footer .sent {
    border-color: rgba(34, 197, 94, 0.45);
    color: var(--color-accent-green);
  }

  @media (max-width: 640px) {
    .ai-office-panel {
      inset: 54px 10px 56px;
      width: auto;
      padding: var(--space-md);
    }

    .agent-strip,
    .state-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
