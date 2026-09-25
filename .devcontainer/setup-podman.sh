#!/usr/bin/env bash
# Devcontainer postCreateCommand for the Podman-only setup.
#
# This container previously used docker-outside-of-docker (a mounted
# /var/run/docker.sock). We no longer use Docker anywhere: sandbox exec,
# Preview containers, and the future workspace/terminal container all run
# on rootless Podman instead. This script installs it, sets up the pieces
# rootless mode needs (subuid/subgid ranges, fuse-overlayfs storage), and
# proves the one thing most likely to break the migration -- bind-mount
# file ownership -- before the app itself is installed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."  # repo root

echo "==> Installing Podman + rootless dependencies"
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs

echo "==> Ensuring rootless subuid/subgid ranges for $(whoami)"
# Rootless Podman maps container UIDs (e.g. the 10001 that
# container_manager.py hardcodes) into a range of "sub" UIDs owned by the
# host user. The devcontainer base image doesn't always pre-allocate one.
if ! grep -q "^$(whoami):" /etc/subuid 2>/dev/null; then
  sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$(whoami)"
fi

echo "==> Configuring Podman storage (fuse-overlayfs, required for rootless overlay)"
mkdir -p ~/.config/containers
cat > ~/.config/containers/storage.conf <<'EOF'
[storage]
driver = "overlay"

[storage.options.overlay]
mount_program = "/usr/bin/fuse-overlayfs"
EOF

echo "==> Verifying rootless Podman starts"
podman info >/dev/null && echo "    podman info OK"

echo "==> Running bind-mount UID round-trip check"
if bash scripts/verify-podman-sandbox.sh; then
  echo "    Sandbox verification PASSED"
else
  echo "    Sandbox verification FAILED -- see output above."
  echo "    The rest of setup will continue, but container_manager.py's"
  echo "    Podman swap will not work correctly until this is fixed."
fi

echo "==> Installing app dependencies"
pip install -r backend/requirements.txt
(cd frontend && npm install)

echo "==> Done."