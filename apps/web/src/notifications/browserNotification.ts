export type BrowserNotificationCapability =
  | "unsupported"
  | "insecure"
  | "default"
  | "granted"
  | "denied";

export type BrowserNotificationShowResult =
  | "shown"
  | "unsupported"
  | "insecure"
  | "not-granted"
  | "construction-failed";

export function readBrowserNotificationCapability(): BrowserNotificationCapability {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return Notification.permission;
}

export function subscribeBrowserNotificationCapability(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const refresh = () => {
    if (document.visibilityState === "visible") listener();
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationCapability> {
  if (readBrowserNotificationCapability() !== "default") return readBrowserNotificationCapability();
  try {
    await Notification.requestPermission();
  } catch {
    // Permission is authoritative; browsers may reject a request made outside user activation.
  }
  return readBrowserNotificationCapability();
}

export function showBrowserActivityNotification({
  title,
  body,
  tag,
  onClick,
}: {
  readonly title: string;
  readonly body?: string;
  readonly tag: string;
  readonly onClick: () => void;
}): BrowserNotificationShowResult {
  const capability = readBrowserNotificationCapability();
  if (capability === "unsupported") return "unsupported";
  if (capability === "insecure") return "insecure";
  if (capability !== "granted") return "not-granted";
  try {
    const notification = new Notification(title, {
      ...(body === undefined ? {} : { body }),
      tag,
      silent: true,
    });
    notification.onclick = (event) => {
      event.preventDefault();
      window.focus();
      notification.close();
      onClick();
    };
    return "shown";
  } catch {
    return "construction-failed";
  }
}
