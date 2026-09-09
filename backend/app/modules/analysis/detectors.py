"""Mirrors: backend/src/modules/analysis/detectors/{build.detector,runtime.detector}.ts"""
import json
import os


async def detect_build_command(root: str, language: str) -> str:
    if language in ("JavaScript", "TypeScript"):
        pkg_path = os.path.join(root, "package.json")
        try:
            with open(pkg_path, "r", encoding="utf-8") as f:
                pkg = json.load(f)
            scripts = pkg.get("scripts", {})
            return "npm run build" if scripts.get("build") else "npm install --ignore-scripts"
        except (FileNotFoundError, json.JSONDecodeError):
            return "npm install --ignore-scripts"
    if language == "Python":
        # python:3.12-slim ships no third-party packages, so best-effort
        # install the project's own deps first (silently skipped if there's
        # no requirements.txt, or if the sandbox has no network — see
        # SANDBOX_NETWORK_MODE in .env) before the actual build check.
        return (
            "[ -f requirements.txt ] && pip install -q -r requirements.txt "
            "|| true; python -m compileall -q ."
        )
    if language == "Go":
        return "go build ./..."
    if language == "Rust":
        return "cargo check"
    return 'echo "No supported build command detected"'


async def detect_test_command(root: str, language: str) -> str:
    if language == "Python":
        uses_pytest = os.path.exists(os.path.join(root, "pytest.ini")) or os.path.exists(
            os.path.join(root, "pyproject.toml")
        )
        if uses_pytest:
            # pytest isn't in the base image; install it best-effort, then run.
            # If the sandbox has no network (SANDBOX_NETWORK_MODE=none, the
            # default), this install is a no-op and the run fails honestly
            # with "pytest: not found" rather than silently passing.
            return "pip install -q pytest 2>/dev/null; pytest"
        return "python -m unittest discover"
    if language in ("JavaScript", "TypeScript"):
        pkg_path = os.path.join(root, "package.json")
        try:
            with open(pkg_path, "r", encoding="utf-8") as f:
                pkg = json.load(f)
            if pkg.get("scripts", {}).get("test"):
                return "npm test"
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        return "npm test -- --runInBand"
    if language == "Go":
        return "go test ./..."
    if language == "Rust":
        return "cargo test"
    return 'echo "No supported test command detected"'
