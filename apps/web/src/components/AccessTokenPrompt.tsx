import { useState } from "react";

import type { PrimaryAccessTokenCheck } from "../environments/primary/accessToken";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function AccessTokenPrompt(props: {
  readonly reason: "required" | "rejected";
  readonly hasStoredToken: boolean;
  readonly verify: (token: string) => Promise<PrimaryAccessTokenCheck>;
  readonly onAccepted: (token: string) => void;
  readonly onForget: () => void;
}) {
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<PrimaryAccessTokenCheck | null>(null);

  const submit = async () => {
    const value = token.trim();
    if (value.length === 0 || checking) return;
    setChecking(true);
    setCheck(null);
    try {
      const result = await props.verify(value);
      if (result === "accepted") {
        props.onAccepted(value);
        return;
      }
      setCheck(result);
    } catch {
      setCheck("unreachable");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-background">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-6 text-card-foreground shadow-lg"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h1 className="text-lg font-semibold">Enter access token</h1>
        <p className="text-sm text-foreground/70">
          {props.reason === "required"
            ? 'This Neokod server needs an access token. Run "cat <base-dir>/access-token" on the server (the path is printed when the server starts).'
            : "The saved access token was not accepted. It may have been replaced on the server. Enter the current token."}
        </p>
        <div className="space-y-1.5">
          <label htmlFor="neokod-access-token" className="text-sm font-medium">
            Access token
          </label>
          <Input
            id="neokod-access-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        {check === "rejected" ? (
          <p role="alert" className="text-sm text-destructive">
            That token was not accepted.
          </p>
        ) : null}
        {check === "unreachable" ? (
          <p role="alert" className="text-sm text-destructive">
            Could not reach the server. Check the address and try again.
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={token.trim().length === 0 || checking}>
            {checking ? "Checking" : "Connect"}
          </Button>
          {props.hasStoredToken ? (
            <Button type="button" variant="outline" onClick={props.onForget}>
              Forget saved token
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
