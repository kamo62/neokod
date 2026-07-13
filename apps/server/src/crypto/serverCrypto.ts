import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as NodeCrypto from "node:crypto";

export function base64UrlEncode(input: string | Uint8Array): string {
  return typeof input === "string"
    ? Encoding.encodeBase64Url(new TextEncoder().encode(input))
    : Encoding.encodeBase64Url(input);
}

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Encoding.decodeBase64UrlString(input));
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return NodeCrypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  return timingSafeEqualBuffers(Buffer.from(left, "base64url"), Buffer.from(right, "base64url"));
}

export function timingSafeEqualUtf8(left: string, right: string): boolean {
  return timingSafeEqualBuffers(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function timingSafeEqualBuffers(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
}
