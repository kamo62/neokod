import "~/index.css";

import { EventId, TurnId, type OrchestrationThreadActivity } from "@neokod/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { renderBrowserHarness } from "../test/browser/render";
import SubagentsPanel from "./SubagentsPanel";

function activity(
  sequence: number,
  kind: string,
  createdAt: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`subagent-browser-${sequence}`),
    turnId: TurnId.make("subagent-browser-turn"),
    sequence,
    kind,
    createdAt,
    summary: kind,
    tone: "info",
    payload,
  };
}

function isoAt(baseMs: number, offsetSeconds: number): string {
  return new Date(baseMs + offsetSeconds * 1_000).toISOString();
}

function subagentActivities(baseMs: number): readonly OrchestrationThreadActivity[] {
  return [
    activity(0, "task.started", isoAt(baseMs, -8), {
      taskId: "active-explorer",
      description: "Repository explorer",
      taskType: "explorer",
      model: "gpt-5.6",
    }),
    activity(1, "task.progress", isoAt(baseMs, -6), {
      taskId: "active-explorer",
      description: "Running Search lifecycle projection references",
      lastToolName: "grep",
    }),
    activity(2, "task.progress", isoAt(baseMs, -4), {
      taskId: "active-explorer",
      summary: "Comparing provider terminal evidence with synthetic reconciliation",
      lastToolName: "read",
      usage: { totalTokens: 4_096 },
    }),
    activity(3, "task.started", isoAt(baseMs, -7), {
      taskId: "detached-reviewer",
      description: "Detached reviewer",
      taskType: "reviewer",
      model: "claude-sonnet-4.6",
    }),
    activity(4, "task.progress", isoAt(baseMs, -5), {
      taskId: "detached-reviewer",
      description: "Inspecting descendant process evidence",
      lastToolName: "read",
    }),
    activity(5, "task.completed", isoAt(baseMs, -3), {
      taskId: "detached-reviewer",
      status: "orphaned",
      summary: "Parent tracking ended before descendant termination was confirmed.",
    }),
    activity(6, "task.started", isoAt(baseMs, -7), {
      taskId: "completed-builder",
      description: "Settings builder",
      taskType: "builder",
      model: "gpt-5.6-codex",
    }),
    activity(7, "task.completed", isoAt(baseMs, -2), {
      taskId: "completed-builder",
      status: "completed",
      summary: "Revision acknowledgement logic implemented and validated.",
      usage: { input_tokens: 2_400, output_tokens: 800 },
    }),
    activity(8, "task.started", isoAt(baseMs, -6), {
      taskId: "failed-checker",
      description: "Regression checker",
      taskType: "checker",
    }),
    activity(9, "task.completed", isoAt(baseMs, -1), {
      taskId: "failed-checker",
      status: "failed",
      summary: "A targeted check failed; no success state was inferred.",
    }),
  ];
}

let mounted: Awaited<ReturnType<typeof renderBrowserHarness>> | undefined;

function rosterButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).filter(
    (button) => button.className.includes("grid-cols"),
  );
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  localStorage.clear();
  document.body.replaceChildren();
});

describe("SubagentsPanel browser presentation", () => {
  it("preserves lifecycle state while switching density", async () => {
    mounted = await renderBrowserHarness(
      <main
        aria-label="Subagent panel browser harness"
        className="h-[780px] w-[340px] overflow-hidden bg-surface-panel"
      >
        <SubagentsPanel
          activities={subagentActivities(Date.now())}
          timestampFormat="24-hour"
          mode="embedded"
        />
      </main>,
    );

    await expect.element(page.getByText("Working on", { exact: true })).toBeVisible();
    expect(rosterButtons()).toHaveLength(4);
    expect(rosterButtons().map((button) => button.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Active"),
        expect.stringContaining("Orphaned"),
        expect.stringContaining("Completed"),
        expect.stringContaining("Failed"),
      ]),
    );

    await page.getByRole("button", { name: /^Detached reviewer/ }).click();
    await expect.element(page.getByText("Tracking lost", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("This worker may still be running outside the parent session."))
      .toBeVisible();

    await page.getByRole("button", { name: "Compact subagent cards" }).click();
    await expect.element(page.getByText("Tracking lost", { exact: true })).not.toBeInTheDocument();
    expect(rosterButtons()).toHaveLength(4);
    expect(
      rosterButtons().filter((button) => button.getAttribute("aria-pressed") === "true"),
    ).toHaveLength(1);

    await page.getByRole("button", { name: /^Settings builder/ }).click();
    await expect
      .element(page.getByText("Revision acknowledgement logic implemented and validated."))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "Expanded subagent cards" }).click();
    await expect
      .element(page.getByText("Revision acknowledgement logic implemented and validated."))
      .toBeVisible();
  });
});
