import { createContext, use, type ReactNode } from "react";
import type { EnvironmentId, ProjectId } from "@neokod/contracts";

export interface AddedCodeProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

type OpenAddProject = (onAdded?: (project: AddedCodeProject) => void) => void;

const OpenAddProjectCommandPaletteContext = createContext<OpenAddProject | null>(null);

export function OpenAddProjectCommandPaletteProvider(props: {
  readonly children: ReactNode;
  readonly openAddProject: OpenAddProject;
}) {
  return (
    <OpenAddProjectCommandPaletteContext value={props.openAddProject}>
      {props.children}
    </OpenAddProjectCommandPaletteContext>
  );
}

export function useOpenAddProjectCommandPalette(): OpenAddProject {
  const openAddProject = use(OpenAddProjectCommandPaletteContext);
  if (!openAddProject) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return openAddProject;
}

/** Read at event time so the chat tree does not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
