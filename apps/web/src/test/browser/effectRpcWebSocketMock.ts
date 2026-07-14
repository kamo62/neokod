import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { RpcMessage } from "effect/unstable/rpc";
import * as Schema from "effect/Schema";

export interface EffectRpcWebSocketClient {
  readonly addEventListener: (type: "close" | "message", listener: EventListener) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly send: (data: string) => void;
}

const codec = RpcSerialization.json.makeUnsafe();
const decodeFromClientEncoded = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.TaggedStruct("Request", {
      id: Schema.String,
      tag: Schema.String,
      payload: Schema.Unknown,
      headers: Schema.mutable(
        Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
      ),
      traceId: Schema.optionalKey(Schema.String),
      spanId: Schema.optionalKey(Schema.String),
      sampled: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.TaggedStruct("Ack", { requestId: Schema.String }),
    Schema.TaggedStruct("Interrupt", { requestId: Schema.String }),
    Schema.TaggedStruct("Ping", {}),
    Schema.TaggedStruct("Eof", {}),
  ]),
);

export function decodeEffectRpcClientFrames(
  data: string,
): ReadonlyArray<RpcMessage.FromClientEncoded> {
  return codec.decode(data).map((frame) => decodeFromClientEncoded(frame));
}

export function sendEffectRpcServerFrame(
  client: EffectRpcWebSocketClient,
  frame: RpcMessage.FromServerEncoded,
): void {
  client.send(codec.encode(frame) as string);
}

export function sendEffectRpcChunk(
  client: EffectRpcWebSocketClient,
  requestId: string,
  value: unknown,
): void {
  sendEffectRpcServerFrame(client, {
    _tag: "Chunk",
    requestId,
    values: [value],
  });
}

export function sendEffectRpcExit(
  client: EffectRpcWebSocketClient,
  requestId: string,
  value: unknown = null,
): void {
  sendEffectRpcServerFrame(client, {
    _tag: "Exit",
    requestId,
    exit: { _tag: "Success", value },
  });
}
