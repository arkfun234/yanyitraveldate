"""Generate Azure travel plans for local mock pre-validation AB-test files."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = PROJECT_ROOT / "abtest_results" / "mock_young_adult"
GENERATOR = PROJECT_ROOT / "scripts" / "generate_azure_travel_plan.py"
OUTPUT_DIR = PROJECT_ROOT / "generated_plans"


def expected_outputs(input_path: Path) -> tuple[Path, Path]:
    base_name = f"{input_path.stem}_azure_plan"
    return OUTPUT_DIR / f"{base_name}.md", OUTPUT_DIR / f"{base_name}.json"


def main() -> int:
    print(
        "WARNING: This script calls Azure OpenAI once for each mock pre-validation "
        "JSON file and may incur API usage costs.",
        file=sys.stderr,
    )
    input_paths = sorted(INPUT_DIR.glob("*.json"))
    if not input_paths:
        print(f"No mock input files found in: {INPUT_DIR}", file=sys.stderr)
        return 1

    successes: list[tuple[Path, Path]] = []
    failures: list[tuple[Path, str]] = []

    for input_path in input_paths:
        print(f"\nGenerating plan for: {input_path}")
        completed = subprocess.run(
            [sys.executable, str(GENERATOR), str(input_path)],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        markdown_path, json_path = expected_outputs(input_path)
        if completed.returncode == 0 and markdown_path.is_file() and json_path.is_file():
            successes.append((markdown_path, json_path))
            print(f"Success: {markdown_path}")
            print(f"Success: {json_path}")
        else:
            detail = completed.stderr.strip() or completed.stdout.strip() or "unknown error"
            failures.append((input_path, detail))
            print(f"Failed: {input_path}\n{detail}", file=sys.stderr)

    print("\nMock plan generation summary")
    print(f"Success count: {len(successes)}")
    print(f"Failed count: {len(failures)}")
    print("Output paths:")
    for markdown_path, json_path in successes:
        print(markdown_path)
        print(json_path)
    if failures:
        print("Failed inputs:")
        for input_path, detail in failures:
            print(f"{input_path}: {detail}", file=sys.stderr)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
