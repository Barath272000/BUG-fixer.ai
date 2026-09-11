"""Mirrors: backend/src/modules/errors/test-result-parser.ts"""
import re
from dataclasses import dataclass

_SUMMARY_RE = re.compile(r"(\d+)\s+tests?.*?(\d+)\s+passed.*?(\d+)\s+failed", re.IGNORECASE | re.DOTALL)


@dataclass
class TestSummary:
    total: int
    passed: int
    failed: int
    skipped: int
    status: str


def parse_generic_test_output(stdout: str, stderr: str, exit_code: int) -> TestSummary:
    combined = f"{stdout}\n{stderr}"
    if re.search(r"(?:Ran\s+0\s+tests?|NO\s+TESTS\s+RAN|no\s+tests?\s+(?:found|ran))", combined, re.IGNORECASE):
        return TestSummary(total=0, passed=0, failed=0, skipped=0, status="NO_TESTS")

    match = _SUMMARY_RE.search(combined)
    status = "PASSED" if exit_code == 0 else "FAILED"

    if match:
        return TestSummary(
            total=int(match.group(1)),
            passed=int(match.group(2)),
            failed=int(match.group(3)),
            skipped=0,
            status=status,
        )

    return TestSummary(
        total=1,
        passed=1 if exit_code == 0 else 0,
        failed=0 if exit_code == 0 else 1,
        skipped=0,
        status=status,
    )
