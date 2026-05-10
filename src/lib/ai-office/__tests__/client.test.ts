import { describe, expect, it } from "vitest";
import { routeAiOfficeTask } from "../client";

describe("AI Office task routing", () => {
  it("routes financial reports to Accountant before generic report routing", () => {
    expect(routeAiOfficeTask("Написать финансовый отчет за 2024 год").id).toBe(
      "accountant",
    );
  });

  it("routes sales reports without financial wording to Analyst", () => {
    expect(routeAiOfficeTask("Сделай отчет по продажам за Q1").id).toBe(
      "data_analyst",
    );
  });

  it("routes code tasks to Developer", () => {
    expect(routeAiOfficeTask("Написать код сортировки на c++").id).toBe(
      "developer",
    );
  });
});
