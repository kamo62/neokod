import { satisfiesSemverRange } from "@neokod/shared/semver";

const nodeEngineCheckMain = function nodeEngineCheckMain() {
  const range = process.argv[2] || "";
  const rawVersion =
    process.versions && process.versions.node ? process.versions.node : process.version;

  if (!satisfiesSemverRange(rawVersion, range)) {
    process.stderr.write(
      "WSL node " + rawVersion + " does not satisfy required range " + range + ".\n",
    );
    process.exit(1);
  }
};

const nodeEnvironmentScript = `prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

wsl_node_satisfies_engine() {
  T3_NODE_ENGINE_RANGE=@@T3_NODE_ENGINE_RANGE@@
  if [ -z "$T3_NODE_ENGINE_RANGE" ]; then
    return 0
  fi
  node - "$T3_NODE_ENGINE_RANGE" <<'NODE'
@@T3_NODE_ENGINE_CHECK_SCRIPT@@
NODE
}

ensure_wsl_node_path() {
  if command -v node >/dev/null 2>&1 && wsl_node_satisfies_engine >/dev/null 2>&1; then
    return 0
  fi

  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"

  if [ -z "\${VOLTA_HOME:-}" ]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${FNM_DIR:-}" ]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${NVM_DIR:-}" ]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$T3_NODE_BIN/node" ]; then
        PATH="$T3_NODE_BIN:$PATH"
        export PATH
      fi
    done
  fi

  command -v node >/dev/null 2>&1 && wsl_node_satisfies_engine
}
`;

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function buildWslNodeEnvScript(nodeEngineRange?: string | null): string {
  return nodeEnvironmentScript
    .replaceAll("@@T3_NODE_ENGINE_RANGE@@", shellSingleQuote(nodeEngineRange?.trim() || ""))
    .replaceAll(
      "@@T3_NODE_ENGINE_CHECK_SCRIPT@@",
      `${satisfiesSemverRange.toString()}\n(${nodeEngineCheckMain.toString()})();`,
    )
    .replace(/\n+$/u, "");
}
