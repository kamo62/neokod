import type { EvidenceItem, RiskEvidence } from "@neokod/contracts";

/**
 * Parser for the structured agent handoff file (`SYMPHONY_EVIDENCE.md`) that
 * the agent is prompted to write in the workspace (plan 10).
 *
 * No generated fallback: when the file is missing or incomplete, the fields
 * stay empty and the overall assessment is `insufficient`. Host-derived
 * inventories (diff, validation) are assembled separately and never satisfy a
 * required agent field.
 *
 * Expected shape (markdown, case-insensitive headings):
 *
 * ```md
 * # Implementation Summary
 * Free text, possibly spanning multiple paragraphs.
 *
 * ## Assumptions
 * - one per bullet
 *
 * ## Risks
 * - [high] risky thing
 * - [medium] medium thing
 *
 * ## Unresolved
 * - open question
 * ```
 */

export interface ParsedEvidenceFile {
  readonly implementationSummary: string;
  readonly assumptions: EvidenceItem[];
  readonly risks: RiskEvidence[];
  readonly unresolved: EvidenceItem[];
}

const SEVERITIES = new Set(["low", "medium", "high"]);

const normalizeHeading = (line: string): string | null => {
  const match = /^#{1,6}\s+(.+)$/.exec(line.trim());
  if (match === null || match[1] === undefined) {
    return null;
  }
  return match[1].trim().toLowerCase().replace(/\s+/g, " ");
};

const isBullet = (line: string): string | null => {
  const match = /^[-*]\s+(.+)$/.exec(line.trim());
  return match === null || match[1] === undefined ? null : match[1].trim();
};

type EvidenceSection = "summary" | "assumptions" | "risks" | "unresolved";

export const parseEvidenceFile = (content: string): ParsedEvidenceFile => {
  const sections = new Map<EvidenceSection, string[]>();
  let current: EvidenceSection | null = null;
  const headingToSection = (heading: string): EvidenceSection | null => {
    if (heading === "implementation summary" || heading === "summary") {
      return "summary";
    }
    if (heading === "assumptions") {
      return "assumptions";
    }
    if (heading === "risks") {
      return "risks";
    }
    if (heading === "unresolved") {
      return "unresolved";
    }
    return null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const heading = normalizeHeading(rawLine);
    if (heading !== null) {
      current = headingToSection(heading);
      sections.set(current ?? "summary", []);
      continue;
    }
    if (current === null) {
      continue;
    }
    const bullet = isBullet(rawLine);
    if (bullet !== null) {
      sections.set(current, [...(sections.get(current) ?? []), bullet]);
    } else if (current === "summary") {
      const trimmed = rawLine.trim();
      if (trimmed.length > 0) {
        sections.set(current, [...(sections.get(current) ?? []), trimmed]);
      }
    }
  }

  const summary = (sections.get("summary") ?? []).join("\n").trim();
  const assumptions: EvidenceItem[] = (sections.get("assumptions") ?? []).map((text) => ({
    text,
    source: "agent",
  }));
  const risks: RiskEvidence[] = (sections.get("risks") ?? []).map((text) => {
    const severityMatch = /^\[(low|medium|high)\]\s+(.+)$/i.exec(text);
    const severity = severityMatch?.[1]?.toLowerCase();
    const body = severityMatch?.[2] ?? text;
    return {
      severity:
        severity !== undefined && SEVERITIES.has(severity)
          ? (severity as RiskEvidence["severity"])
          : "medium",
      text: body,
      source: "agent",
    };
  });
  const unresolved: EvidenceItem[] = (sections.get("unresolved") ?? []).map((text) => ({
    text,
    source: "agent",
  }));

  return { implementationSummary: summary, assumptions, risks, unresolved };
};
