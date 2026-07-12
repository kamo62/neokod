import "../../index.css";

import { expect } from "vite-plus/test";

expect(window.innerWidth).toBe(1280);
expect(window.innerHeight).toBe(900);
expect(window.devicePixelRatio).toBe(1);
expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe("en-US");
expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
expect(
  new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date("2026-06-01T13:45:00Z")),
).toBe("13:45");
expect(window.matchMedia("(prefers-color-scheme: light)").matches).toBe(true);
expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
