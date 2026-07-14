import { describe, expect, it } from "vite-plus/test";

import { decodeEffectRpcClientFrames } from "./effectRpcWebSocketMock";

describe("decodeEffectRpcClientFrames", () => {
  it("rejects malformed client envelopes", () => {
    for (const frame of [
      { _tag: "Request", id: 1, tag: "server.getConfig", payload: null, headers: [] },
      { _tag: "Request", id: "1", tag: "server.getConfig", payload: null, headers: [["x", 1]] },
      { _tag: "Ack", requestId: 1 },
      { _tag: "Interrupt", requestId: 1 },
      { _tag: "Unknown" },
    ]) {
      expect(() => decodeEffectRpcClientFrames(JSON.stringify(frame))).toThrow();
    }
  });
});
