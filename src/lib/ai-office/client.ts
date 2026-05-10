import { getSetting } from "$lib/stores/index.svelte";

export type AiOfficeAgentId =
  | "pmo"
  | "data_analyst"
  | "developer"
  | "copywriter"
  | "support"
  | "strategist"
  | "accountant";

export interface AiOfficeAgent {
  id: AiOfficeAgentId;
  name: string;
  icon: string;
  description: string;
  action: string;
  keywords: string[];
}

export interface AiOfficeResponse {
  agent_id: string;
  handled_by: string;
  handled_by_name: string;
  result: string;
  task_id: string;
  telegram_notified: boolean;
  status: "ok" | "error";
  error?: string;
}

export const AI_OFFICE_AGENTS: AiOfficeAgent[] = [
  {
    id: "pmo",
    name: "PMO",
    icon: "PMO",
    description: "маршрутизация и контроль",
    action: "читает задачу, выбирает исполнителя, проверяет качество и закрывает работу",
    keywords: [],
  },
  {
    id: "data_analyst",
    name: "Аналитик",
    icon: "DATA",
    description: "данные и метрики",
    action: "собирает метрики, проверяет источники данных и формирует выводы",
    keywords: ["sql", "данные", "метрик", "продаж", "выруч", "дашборд", "отчет", "отчёт"],
  },
  {
    id: "developer",
    name: "Разработчик",
    icon: "DEV",
    description: "код и ревью",
    action: "читает задачу как технический запрос, готовит кодовое решение или ревью",
    keywords: ["код", "c++", "cpp", "python", "javascript", "программ", "разработ", "ревью", "деплой", "баг", "api"],
  },
  {
    id: "copywriter",
    name: "Копирайтер",
    icon: "COPY",
    description: "тексты и контент",
    action: "создает текстовый черновик, адаптирует тон и структуру",
    keywords: ["текст", "контент", "стать", "пост", "email", "письм", "лендинг"],
  },
  {
    id: "support",
    name: "Поддержка",
    icon: "HELP",
    description: "диагностика и ответы",
    action: "классифицирует обращение, готовит ответ и при необходимости эскалирует",
    keywords: ["поддержк", "проблем", "ошибк", "тикет", "клиент", "не работает"],
  },
  {
    id: "strategist",
    name: "Стратег",
    icon: "STR",
    description: "рынок и конкуренты",
    action: "смотрит на рынок, конкурентов, риски и стратегические гипотезы",
    keywords: ["рынок", "стратег", "конкурент", "saas", "позиционир", "гипотез"],
  },
  {
    id: "accountant",
    name: "Бухгалтер",
    icon: "FIN",
    description: "финансы и сверки",
    action: "проверяет суммы, документы, инвойсы и арифметические расхождения",
    keywords: [
      "инвойс",
      "счёт",
      "счет",
      "финанс",
      "сверк",
      "ндс",
      "налог",
      "доход",
      "расход",
      "прибыл",
      "убыт",
      "баланс",
      "бюджет",
      "p&l",
      "pnl",
      "cash flow",
      "денежн",
      "ebitda",
    ],
  },
];

const ROUTING_PRIORITY: AiOfficeAgentId[] = [
  "accountant",
  "developer",
  "support",
  "strategist",
  "copywriter",
  "data_analyst",
];

export function getAiOfficeAgent(id: string): AiOfficeAgent {
  return AI_OFFICE_AGENTS.find((agent) => agent.id === id) ?? AI_OFFICE_AGENTS[1];
}

export function routeAiOfficeTask(task: string): AiOfficeAgent {
  const normalized = task.toLowerCase();
  for (const agentId of ROUTING_PRIORITY) {
    const agent = getAiOfficeAgent(agentId);
    if (agent.keywords.some((keyword) => normalized.includes(keyword))) {
      return agent;
    }
  }
  return getAiOfficeAgent("data_analyst");
}

export async function runAiOfficeTask(
  agentId: AiOfficeAgentId,
  message: string,
): Promise<AiOfficeResponse> {
  const baseUrl = getSetting("aiOfficeApiUrl").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, message }),
  });
  const data = (await response.json()) as AiOfficeResponse;
  if (!response.ok || data.status === "error") {
    throw new Error(data.error || `AI Office API returned ${response.status}`);
  }
  return data;
}
