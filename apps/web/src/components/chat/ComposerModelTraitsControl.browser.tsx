import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";
import { render } from "vitest-browser-react";
import { useState } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@neokod/contracts";

import { ComposerModelTraitsControl } from "./ComposerModelTraitsControl";
import { formatComposerModelTraitsSummary } from "./ComposerModelTraitsControl.logic";
import { TraitsPicker } from "./TraitsPicker";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

// This test exists to catch the specific nested-popup risk a reviewer
// flagged: ComposerModelTraitsControl embeds TraitsPicker (its own Menu,
// own trigger) as an "adjacent section" inside the outer Popover. If the
// two floating layers didn't coordinate dismissal correctly, opening the
// nested provider-options menu could incorrectly close the outer model
// popover.

const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("codex");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const MODEL_SLUG = "codex-model";

const model: ServerProviderModel = {
  slug: MODEL_SLUG,
  name: "Codex Model",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "high", label: "High", isDefault: true },
          { id: "low", label: "Low" },
        ],
        currentValue: "high",
      },
    ],
  },
};

const snapshot: ServerProvider = {
  instanceId: INSTANCE_ID,
  driver: PROVIDER,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [model],
  slashCommands: [],
  skills: [],
};

const instanceEntries = deriveProviderInstanceEntries([snapshot]);
const modelOption: ModelEsque = { slug: MODEL_SLUG, name: "Codex Model" };
const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
  [INSTANCE_ID, [modelOption]],
]);

const cleanups: Array<() => Promise<void>> = [];

function Harness() {
  const [modelOptions, setModelOptions] = useState<
    ReadonlyArray<ProviderOptionSelection> | undefined
  >(undefined);
  const summaryLabel = formatComposerModelTraitsSummary({
    model: modelOption,
    provider: PROVIDER,
    models: [model],
    modelSlug: MODEL_SLUG,
    prompt: "",
    modelOptions,
    hasTraitsTarget: true,
  });

  return (
    <ComposerModelTraitsControl
      activeInstanceId={INSTANCE_ID}
      model={MODEL_SLUG}
      lockedProvider={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      summaryLabel={summaryLabel}
      onInstanceModelChange={() => {}}
      traitsFooter={
        <TraitsPicker
          provider={PROVIDER}
          instanceId={INSTANCE_ID}
          models={[model]}
          model={MODEL_SLUG}
          prompt=""
          onPromptChange={() => {}}
          modelOptions={modelOptions}
          onModelOptionsChange={setModelOptions}
        />
      }
    />
  );
}

async function mountControl() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<Harness />, { container: host });

  cleanups.push(async () => {
    await screen.unmount();
    host.remove();
  });
}

describe("ComposerModelTraitsControl", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("keeps the outer model popover open when the nested provider-options menu opens", async () => {
    await mountControl();

    await page.getByRole("button", { name: "Codex Model · High", exact: true }).click();
    await expect.element(page.getByPlaceholder("Search models...")).toBeVisible();

    await page.getByRole("button", { name: "High", exact: true }).click();
    await expect.element(page.getByText("Low")).toBeVisible();

    // The outer popover (model list) must still be open — opening the
    // nested TraitsPicker menu must not have dismissed it.
    await expect.element(page.getByPlaceholder("Search models...")).toBeVisible();
  });
});
