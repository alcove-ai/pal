#!/usr/bin/env bash
#
# PAL installer
#
# Usage:
#   bash install.sh           # install latest version
#   bash install.sh v0.3.0    # install a specific version
#
set -euo pipefail

GITLAB_BASE="https://gitlab.cee.redhat.com/hosted-pulp/pal"
INSTALL_DIR="${HOME}/.local/bin"
BINARY_NAME="pal"

# Optional version argument (e.g., "v0.3.0")
VERSION="${1:-}"

# --- Platform detection ---

detect_platform() {
  local os arch

  os="$(uname -s)"
  arch="$(uname -m)"

  case "${os}" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)
      echo "Error: unsupported OS: ${os}" >&2
      exit 1
      ;;
  esac

  case "${arch}" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "Error: unsupported architecture: ${arch}" >&2
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

PLATFORM="$(detect_platform)"
ASSET_NAME="pal-${PLATFORM}"

echo "pal: detected platform ${PLATFORM}"

# --- Build download URL ---

if [ -n "${VERSION}" ]; then
  # Strip leading 'v' if present for the tag, then re-add
  VERSION="${VERSION#v}"
  DOWNLOAD_URL="${GITLAB_BASE}/-/releases/v${VERSION}/downloads/${ASSET_NAME}"
  CHECKSUM_URL="${GITLAB_BASE}/-/releases/v${VERSION}/downloads/${ASSET_NAME}.sha256"
  echo "pal: installing version v${VERSION}"
else
  DOWNLOAD_URL="${GITLAB_BASE}/-/releases/permalink/latest/downloads/${ASSET_NAME}"
  CHECKSUM_URL="${GITLAB_BASE}/-/releases/permalink/latest/downloads/${ASSET_NAME}.sha256"
  echo "pal: installing latest version"
fi

# --- Download binary ---

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

echo "pal: downloading binary..."
if ! curl -fSL --connect-timeout 10 --max-time 120 -o "${TMPDIR}/${BINARY_NAME}" "${DOWNLOAD_URL}"; then
  echo "Error: failed to download binary from ${DOWNLOAD_URL}" >&2
  echo "Make sure you are connected to the Red Hat VPN." >&2
  exit 1
fi

echo "pal: downloading checksum..."
if ! curl -fSL --connect-timeout 10 --max-time 10 -o "${TMPDIR}/${BINARY_NAME}.sha256" "${CHECKSUM_URL}"; then
  echo "Error: failed to download checksum from ${CHECKSUM_URL}" >&2
  exit 1
fi

# --- Verify checksum ---

EXPECTED="$(cat "${TMPDIR}/${BINARY_NAME}.sha256" | tr -d '[:space:]')"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TMPDIR}/${BINARY_NAME}" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "${TMPDIR}/${BINARY_NAME}" | awk '{print $1}')"
fi

if [ "${EXPECTED}" != "${ACTUAL}" ]; then
  echo "Error: checksum verification failed" >&2
  echo "  expected: ${EXPECTED}" >&2
  echo "  actual:   ${ACTUAL}" >&2
  exit 1
fi

echo "pal: checksum verified"

# --- Install binary ---

mkdir -p "${INSTALL_DIR}"
chmod +x "${TMPDIR}/${BINARY_NAME}"
mv "${TMPDIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}"

echo "pal: installed to ${INSTALL_DIR}/${BINARY_NAME}"

# --- Check PATH ---

ON_PATH=true
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*)
    ;;
  *)
    ON_PATH=false
    ;;
esac

echo ""
if [ "${ON_PATH}" = true ]; then
  echo "  Run 'pal' to get started."
else
  echo "  ${INSTALL_DIR} is not on your PATH. Add it:"
  echo ""
  echo "    echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
  echo ""
  echo "  Then run 'pal' to get started."
fi
echo ""
echo "  PAL auto-updates on startup. Set PAL_NO_UPDATE_CHECK=1 to disable."
