#!/usr/bin/env bash
# Proves that a rootless Podman container can write into a bind-mounted
# workspace directory as a fixed UID -- matching container_manager.py's
# hardcoded `--user 10001:10001` -- and that the API-side process (running
# as the current host user) can read AND delete the result afterward.
#
# This is the one thing that decides whether the Docker-outside-of-Docker
# path translation in container_manager.py's _docker_workspace_path() can
# be replaced with a plain bind-mount under Podman, or whether the rewrite
# needs `--userns=keep-id` / `podman unshare` on top. Run this on its own,
# before touching container_manager.py, so a mapping problem shows up here
# instead of hiding inside a bigger rewrite later.
#
# Usage: scripts/verify-podman-sandbox.sh
# Exit code 0 = safe to proceed with the container_manager.py Podman swap.
set -euo pipefail

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Test workspace: $WORKDIR"
echo "Host user:      $(id -un) ($(id -u):$(id -g))"

echo
echo "== Step 1: container (UID 10001) writes a file into the bind mount =="
podman run --rm \
  --user 10001:10001 \
  -v "$WORKDIR:/workspace:rw" \
  -w /workspace \
  docker.io/library/alpine:3.20 \
  /bin/sh -c 'echo "written by container UID $(id -u)" > sandbox-output.txt && id'

echo
echo "== Step 2: host process reads the file back =="
if [ ! -f "$WORKDIR/sandbox-output.txt" ]; then
  echo "FAIL: file does not exist on the host side at all."
  echo "      Check the bind-mount path and that podman actually ran."
  exit 1
fi

OWNER_UID="$(stat -c '%u' "$WORKDIR/sandbox-output.txt")"
echo "File owner UID as seen by host: $OWNER_UID"
echo "File contents:"
if ! cat "$WORKDIR/sandbox-output.txt" 2>/dev/null; then
  echo "  <unreadable -- host user lacks read permission on this file>"
fi

echo
echo "== Step 3: host process deletes the file (simulates cleanup after a run) =="
if rm -f "$WORKDIR/sandbox-output.txt" 2>/dev/null && [ ! -f "$WORKDIR/sandbox-output.txt" ]; then
  echo "PASS: host can read AND delete container-written files."
else
  echo "FAIL: host cannot delete container-written files."
  echo "      This is the classic rootless-Podman subuid/userns mismatch."
  echo "      Fixes to try, in order:"
  echo "        1. Confirm /etc/subuid and /etc/subgid have an entry for $(id -un)."
  echo "        2. Add --userns=keep-id to the podman run call instead of a fixed --user."
  echo "        3. As a last resort, run 'podman unshare chown -R 10001:10001 <dir>' before cleanup."
  exit 1
fi

echo
echo "== Result: rootless bind-mount round-trip OK. Safe to proceed with the =="
echo "== container_manager.py Podman swap using the same --user/-v pattern.  =="