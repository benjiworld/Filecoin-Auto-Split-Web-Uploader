#!/usr/bin/env bash

# Filecoin Smart Uploader CLI
# Requires a tested filecoin-pin version compatible with server.mjs.
# Uses a .env file for configuration.

set -Eeuo pipefail
IFS=$'\n\t'

# -----------------------------
# Configuration
# -----------------------------
ENV_FILE="${ENV_FILE:-.env}"
PRIVATE_KEY="${PRIVATE_KEY:-}"
DATASET_ID="${DATASET_ID:-}"
RPC_URL="${RPC_URL:-}"
FILECOIN_PIN_VERSION="${FILECOIN_PIN_VERSION:-}"
COPIES="${COPIES:-2}"
FILECOIN_PIN_CMD="${FILECOIN_PIN_CMD:-filecoin-pin}"

MAX_CAR_SIZE=1065353216
MIN_CAR_BOUNDARY=$((32 * 1024 * 1024))
WORKSPACE=""

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { printf '%b\n' "${BLUE}$*${NC}"; }
ok() { printf '%b\n' "${GREEN}$*${NC}"; }
warn() { printf '%b\n' "${YELLOW}$*${NC}"; }
error() { printf '%b\n' "${RED}$*${NC}" >&2; }

cleanup() {
  if [[ -n "${WORKSPACE:-}" && -d "$WORKSPACE" ]]; then
    rm -rf -- "$WORKSPACE"
  fi
}
trap cleanup EXIT INT TERM

usage() {
  cat <<'EOF'
Usage:
  ./smart-upload-updated-fixed.sh [--env .env]

Environment variables (via .env or shell):
  PRIVATE_KEY             Filecoin private key. Required; must start with 0x.
  DATASET_ID              Target dataset ID. Required.
  RPC_URL                 Filecoin RPC endpoint. Required.
  FILECOIN_PIN_VERSION    Tested filecoin-pin version. Required.
  COPIES                  Number of copies. Default: 2.
  FILECOIN_PIN_CMD        Installed filecoin-pin executable. Default: filecoin-pin.
  ENV_FILE                Path to .env file. Default: .env
EOF
}

load_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    error "Environment file not found: $ENV_FILE"
    error 'Create a .env file with:'
    error '  PRIVATE_KEY=0x...'
    error '  DATASET_ID=99'
    error '  RPC_URL=https://...'
    error '  FILECOIN_PIN_VERSION=your-tested-version'
    exit 1
  fi

  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    key="${key%%[[:space:]]}"
    value="${value##[[:space:]]}"
    value="${value%%[[:space:]]}"
    value="${value#[\"\']}"
    value="${value%[\"\']}"

    case "$key" in
      PRIVATE_KEY) PRIVATE_KEY="$value" ;;
      DATASET_ID) DATASET_ID="$value" ;;
      RPC_URL) RPC_URL="$value" ;;
      FILECOIN_PIN_VERSION) FILECOIN_PIN_VERSION="$value" ;;
      COPIES) COPIES="$value" ;;
      FILECOIN_PIN_CMD) FILECOIN_PIN_CMD="$value" ;;
    esac
  done < "$ENV_FILE"
}

require_commands() {
  local missing=0
  for command in node npm npx "$FILECOIN_PIN_CMD"; do
    if ! command -v "$command" >/dev/null 2>&1; then
      error "Required command not found: $command"
      missing=1
    fi
  done
  (( missing == 0 )) || exit 1
}

validate_config() {
  [[ -n "$PRIVATE_KEY" ]] || { error 'PRIVATE_KEY is required.'; exit 1; }
  [[ "$PRIVATE_KEY" == 0x* ]] || { error 'PRIVATE_KEY must start with 0x.'; exit 1; }
  [[ "$DATASET_ID" =~ ^[0-9]+$ ]] || { error 'DATASET_ID must be a non-negative integer.'; exit 1; }
  [[ -n "$RPC_URL" ]] || { error 'RPC_URL is required.'; exit 1; }
  [[ -n "$FILECOIN_PIN_VERSION" ]] || { error 'FILECOIN_PIN_VERSION is required.'; exit 1; }
  [[ "$COPIES" =~ ^[1-9][0-9]*$ ]] || { error 'COPIES must be a positive integer.'; exit 1; }
}

filecoin_pin() {
  "$FILECOIN_PIN_CMD" "$@"
}

get_file_size() {
  if stat --version >/dev/null 2>&1; then
    stat -c '%s' -- "$1"
  else
    stat -f '%z' -- "$1"
  fi
}

get_padded_size() {
  local size="$1"
  local padded=$MIN_CAR_BOUNDARY
  while (( padded < size )); do
    padded=$((padded * 2))
  done
  printf '%s\n' "$padded"
}

spinner() {
  local pid="$1"
  local delay=0.1
  local chars='|/-\\'
  local index=0
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r[%c] Working...' "${chars:index++%4:1}"
    sleep "$delay"
  done
  printf '\r                    \r'
}

run_with_spinner() {
  local log_file="$1"
  shift
  "$@" >"$log_file" 2>&1 &
  local pid=$!
  spinner "$pid"
  wait "$pid"
}

ensure_cli_version() {
  local version
  version=$(filecoin_pin --version 2>/dev/null || true)
  if [[ -z "$version" ]]; then
    error "Unable to execute $FILECOIN_PIN_CMD."
    return 1
  fi
  ok "Using filecoin-pin: $version"
}

ensure_payments_setup() {
  warn 'Checking payment setup...'
  if filecoin_pin payments status --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null 2>&1; then
    ok 'Payment status check completed.'
    return 0
  fi

  warn 'Payments are not ready. Starting interactive payment setup.'
  filecoin_pin payments setup --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL"
}

pack_target() {
  local target="$1"
  local car_file="$2"
  local log_file="$3"

  info "Packing '$target' into a CAR file..."
  run_with_spinner "$log_file" npx --yes ipfs-car pack "$target" -o "$car_file"

  ROOT_CID=$(grep -Eo '\b(bafy[a-z0-9]+|bafk[a-z0-9]+)\b' "$log_file" | tail -n 1 || true)
  [[ -n "$ROOT_CID" ]] || {
    error "Could not detect the IPFS root CID. Output:"
    cat "$log_file" >&2
    return 1
  }

  ok "Root CID: $ROOT_CID"
}

split_car() {
  local car_file="$1"
  local workspace="$2"
  local car_size
  car_size=$(get_file_size "$car_file")

  if (( car_size <= MIN_CAR_BOUNDARY )); then
    info 'CAR is 32 MiB or smaller; skipping splitting.'
    return 0
  fi

  info 'Splitting CAR into Filecoin-compatible chunks...'
  local boundary="$MAX_CAR_SIZE"
  local log_file="$workspace/carbites.log"

  (cd "$workspace" && npx --yes carbites split "$(basename "$car_file")" --size "$boundary" --strategy treewalk) >"$log_file" 2>&1 &
  local pid=$!
  spinner "$pid"
  wait "$pid"

  rm -f -- "$car_file"

  shopt -s nullglob
  local chunks=("$workspace"/*.car)
  shopt -u nullglob
  (( ${#chunks[@]} > 0 )) || {
    error 'carbites did not produce any CAR chunks.'
    cat "$log_file" >&2
    return 1
  }

  ok "Created ${#chunks[@]} CAR chunk(s)."
}

upload_target() {
  local target
  read -r -p 'Enter the path to the file or folder to upload: ' target
  target="${target%/}"

  [[ -e "$target" ]] || { error "Path does not exist: $target"; return; }

  WORKSPACE="$(mktemp -d ./.tmp_filecoin_upload.XXXXXX)"
  local original_name
  original_name=$(basename "$target")
  local car_file="$WORKSPACE/$original_name.car"
  local pack_log="$WORKSPACE/ipfs-car.log"

  trap 'rm -rf -- "$WORKSPACE"' RETURN

  pack_target "$target" "$car_file" "$pack_log" || return
  split_car "$car_file" "$WORKSPACE" || return

  shopt -s nullglob
  local chunks=("$WORKSPACE"/*.car)
  shopt -u nullglob
  (( ${#chunks[@]} > 0 )) || { error 'No CAR files found for import.'; return; }

  info "Importing ${#chunks[@]} chunk(s) into Dataset $DATASET_ID..."
  local index=1
  for chunk in "${chunks[@]}"; do
    local chunk_name
    chunk_name=$(basename "$chunk")
    info "Chunk [$index/${#chunks[@]}]: $chunk_name"

    filecoin_pin import "$chunk" \
      --private-key "$PRIVATE_KEY" \
      --rpc-url "$RPC_URL" \
      --data-set-id "$DATASET_ID" \
      --copies "$COPIES" \
      --auto-fund \
      --metadata "name=${chunk_name:0:32}" \
      --metadata "originalfile=${original_name:0:32}" \
      --metadata "rootcid=${ROOT_CID:0:128}"

    ((index += 1))
  done

  ok 'Upload completed successfully.'
  rm -rf -- "$WORKSPACE"
  WORKSPACE=''
}

fetch_history() {
  printf '\n%b\n' "${CYAN}Upload History (Dataset $DATASET_ID)${NC}"
  filecoin_pin data-set piece-status "$DATASET_ID" --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL"
}

dataset_summary() {
  printf '\n%b\n' "${CYAN}Dataset Summary (Dataset $DATASET_ID)${NC}"
  filecoin_pin data-set show "$DATASET_ID" --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL"
}

check_payments() {
  printf '\n%b\n' "${CYAN}Payments Status${NC}"
  filecoin_pin payments status --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL"
}

remove_pieces() {
  local -a pieces
  read -r -a pieces -p 'Enter Piece CID(s) separated by spaces: '
  (( ${#pieces[@]} > 0 )) || { error 'No Piece CIDs provided.'; return; }

  warn "Each removal uses 'remove --wait' and waits for confirmation."
  local current=1
  for piece in "${pieces[@]}"; do
    [[ "$piece" =~ ^[a-zA-Z0-9]{10,}$ ]] || { error "Invalid Piece CID: $piece"; return; }
    info "[$current/${#pieces[@]}] Removing $piece..."
    filecoin_pin remove \
      --piece "$piece" \
      --data-set-id "$DATASET_ID" \
      --private-key "$PRIVATE_KEY" \
      --rpc-url "$RPC_URL" \
      --wait
    ((current += 1))
  done

  ok 'All removals completed and confirmed.'
}

main_menu() {
  while true; do
    printf '\n%b\n' "${CYAN}Filecoin Smart Uploader${NC}"
    printf '%s\n' '1) Upload File/Folder' '2) View Upload History' '3) Check Payments Status' '4) Remove Piece CID(s)' '5) Dataset Summary' '6) Quit'
    read -r -p 'Select an option [1-6]: ' choice
    case "$choice" in
      1) upload_target ;;
      2) fetch_history ;;
      3) check_payments ;;
      4) remove_pieces ;;
      5) dataset_summary ;;
      6) ok 'Goodbye!'; return 0 ;;
      *) error 'Invalid option.' ;;
    esac
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

load_env_file
require_commands
validate_config
ensure_cli_version
ensure_payments_setup
main_menu