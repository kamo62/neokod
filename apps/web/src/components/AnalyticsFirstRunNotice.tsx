import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { primaryServerConfigAtom } from "../state/server";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { usePrimarySettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "./ui/toast";

export const ANALYTICS_FIRST_RUN_NOTICE_STORAGE_KEY = "neokod:analytics-first-run-notice:v1";

export function AnalyticsFirstRunNotice() {
  const navigate = useNavigate();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const analyticsEnabled = usePrimarySettings((settings) => settings.analytics.enabled);
  const [noticeShown, setNoticeShown] = useLocalStorage(
    ANALYTICS_FIRST_RUN_NOTICE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const noticeShownRef = useRef(noticeShown);

  useEffect(() => {
    if (serverConfig === null || !analyticsEnabled || noticeShown || noticeShownRef.current) {
      return;
    }

    noticeShownRef.current = true;
    setNoticeShown(true);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Analytics is enabled by default",
        description: "It collects usage data and error logs only, never prompts or source code.",
        timeout: 0,
        actionProps: {
          children: "Review Settings > Analytics",
          onClick: () => void navigate({ to: "/settings/analytics" }),
        },
        actionVariant: "outline",
      }),
    );
  }, [analyticsEnabled, navigate, noticeShown, serverConfig, setNoticeShown]);

  return null;
}
