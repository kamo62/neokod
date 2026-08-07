import { Link } from "@tanstack/react-router";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import {
  DEFAULT_RADIUS_BASE,
  DEFAULT_UI_SCALE,
  RADIUS_BASE_MAX,
  RADIUS_BASE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  useUiStateStore,
} from "../../uiStateStore";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

export function AppearanceSettingsPanel() {
  const uiScale = useUiStateStore((store) => store.uiScale);
  const setUiScale = useUiStateStore((store) => store.setUiScale);
  const radiusBase = useUiStateStore((store) => store.radiusBase);
  const setRadiusBase = useUiStateStore((store) => store.setRadiusBase);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Appearance">
        <SettingsRow
          title="UI scale"
          description="Resizes chrome text and controls across the app — nav labels, meta text, buttons. Chat text has its own size in General."
          resetAction={
            uiScale !== DEFAULT_UI_SCALE ? (
              <SettingResetButton label="UI scale" onClick={() => setUiScale(DEFAULT_UI_SCALE)} />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <NumberField
                value={uiScale}
                min={UI_SCALE_MIN}
                max={UI_SCALE_MAX}
                step={0.05}
                size="sm"
                className="w-28"
                onValueChange={(value) => {
                  if (value !== null) setUiScale(value);
                }}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Decrease UI scale" />
                  <NumberFieldInput aria-label="UI scale multiplier" />
                  <NumberFieldIncrement aria-label="Increase UI scale" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">×</span>
            </div>
          }
        />

        <SettingsRow
          title="Corner radius"
          description="Base corner radius for panels, cards, and controls across the app."
          resetAction={
            radiusBase !== DEFAULT_RADIUS_BASE ? (
              <SettingResetButton
                label="corner radius"
                onClick={() => setRadiusBase(DEFAULT_RADIUS_BASE)}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <NumberField
                value={radiusBase}
                min={RADIUS_BASE_MIN}
                max={RADIUS_BASE_MAX}
                step={1}
                size="sm"
                className="w-28"
                onValueChange={(value) => {
                  if (value !== null) setRadiusBase(value);
                }}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Decrease corner radius" />
                  <NumberFieldInput aria-label="Corner radius in pixels" />
                  <NumberFieldIncrement aria-label="Increase corner radius" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">px</span>
            </div>
          }
        />
      </SettingsSection>

      <p className="px-1 text-xs text-muted-foreground/80">
        Theme and chat reading settings (text size, line height, column width) live in{" "}
        <Link to="/settings/general" className="text-foreground underline-offset-2 hover:underline">
          General
        </Link>
        .
      </p>
    </SettingsPageContainer>
  );
}
