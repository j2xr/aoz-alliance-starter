"""Checks, against the real images that produced them, whether the concrete
"donation row 11: alliance_honor=X breaks monotonicity" cases documented in
the `/reprocess-channel` audits of 2026-07-26 (see docs/maintenance/2026-07-26-
reprocess-channel-*.md) are actually fixed today — rather than assuming so.

Context: these three audits found the same signature in three different
alliances: the last row of a full-page screenshot (row 11 out of
_MAX_ROWS=12, see contribution_ranking_v1.py) breaks alliance_honor
monotonicity, because the crop band there is the most poorly aligned
(geometric drift documented in contribution_ranking_v1.py, lines ~134-178).
PR #29 (already merged) fixed the honor<->LLM circularity for rows
explicitly flagged "suspect" (suspect_honor_window set by
_enforce_honor_monotonicity) — but two of the documented cases (SOD: 'ran'
and 'Somethin_kool' at 955/970) do NOT break monotonicity (their value is
smaller than the previous row) and are rejected by a different branch (the
"self-consistency gate" when no window is set) that PR #29 doesn't touch.
This tool settles the question empirically, case by case, rather than by
deduction.

Two passes per relevant image:
  - "parser": ContributionRankingV1Parser.parse() alone, deterministic, no LLM.
  - "full"  : app.extract.extract() — the full production pipeline,
    including the LLM fallback if LLM_FALLBACK_ENABLED (read at import time,
    see app/extract.py — cannot be toggled after the fact from this script).

The CASES table below is the "ground truth": the value stored in the
database (stored_honor, what the original screenshot produced) serves as a
row marker just like the name, because two of the real names are themselves
truncated by OCR ("Somethin kool", "ran") — matching by name alone would be
unreliable.

Usage — like measure_tab_delta.py, this tool has no access to data/inbox/
nor to a venv usable directly on this host (no `uv` on the PATH, the
container's `.venv` points to an interpreter that only exists inside it, and
the image does NOT contain tools/ — only app/ is copied, see Dockerfile).
The only invocation that actually works on this host:

    cd tracker
    docker compose run --rm --no-deps \\
        -e JOBS_DB_PATH=/tmp/jobs.db \\
        -v "$PWD/apps/ocr-service/tools:/app/tools:ro" \\
        -v "$PWD/data/inbox:/inbox:ro" \\
        ocr-service python tools/verify_honor_audit_cases.py --root /inbox

  --mode {parser,full,both} (default both)
  --include-unconfirmed   : also includes cases not re-verified on screen (LOL #4)
  --json
  --fail-on-regression    : exit 1 if a confirmed case is FAIL in full mode

Note: "full" mode calls the real production Ollama (no paid API — see
app/llm_fallback.py, _DEFAULT_BASE_URL="http://localhost:11434") and is
therefore neither deterministic nor suited to CI/bench.py — run it manually,
preferably outside peak Discord usage hours.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator, Sequence
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path

from app.dispatcher import DONATION_CODE, UnknownEventError, detect_screen_kind
from app.extract import _CONFIDENCE_THRESHOLD_NAME, _LLM_FALLBACK_ENABLED, extract
from app.parsers import get_parser
from app.parsers.base import DonationMember, DonationParseResult
from app.preprocess import preprocess_image

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png")
# Same threshold as tools/bench-ocr/bench.py:_sim — not redefined independently.
NAME_SIM_THRESHOLD = 0.70


@dataclass(frozen=True)
class AuditCase:
    label: str  # player name as printed in the audit report
    stored_honor: int  # WRONG value actually stored in prod — also serves as a row marker
    true_honor: int  # value confirmed by screenshot in the audit
    source: str  # doc + finding number
    message_id: str | None = None  # None = scan the whole corpus (unknown message)
    confirmed: bool = True  # False = the audit did not re-verify on screen (LOL #4)


CASES: tuple[AuditCase, ...] = (
    AuditCase(
        "Somethin_kool",
        92256,
        2385,
        "2026-07-26-reprocess-channel-data-quality-report.md#1",
        message_id="1527351181750440036",
    ),
    AuditCase(
        "StoKaizer",
        9044,
        2944,
        "2026-07-26-reprocess-channel-data-quality-report.md#1",
        message_id="1527351181750440036",
    ),
    # The SOD report cites these two log lines but never specifies which
    # message they came from — hence message_id=None: the whole corpus is
    # scanned and where the row appears is reported.
    AuditCase(
        "Somethin_kool",
        955,
        255,
        "2026-07-26-reprocess-channel-sod-data-quality-report.md#3",
    ),
    AuditCase(
        "ran",
        970,
        270,
        "2026-07-26-reprocess-channel-sod-data-quality-report.md#3",
    ),
    AuditCase(
        "nuna",
        51325,
        5135,
        "2026-07-26-reprocess-channel-lol-data-quality-report.md#4",
        message_id="1500244014480228402",
        confirmed=False,
    ),
)


def is_contribution_ranking(image: object) -> bool:
    """Same guard as measure_tab_delta.py: an unrecognized header raises
    UnknownEventError, treated as "not a Contribution Ranking"."""
    try:
        kind, code = detect_screen_kind(image)  # type: ignore[arg-type]
    except UnknownEventError:
        return False
    return kind == "donation" and code == DONATION_CODE


def iter_images(root: Path) -> Iterator[Path]:
    """*.jpg/*.jpeg/*.png, recursive, sorted (deterministic)."""
    if not root.is_dir():
        return
    seen: set[Path] = set()
    for suffix in IMAGE_SUFFIXES:
        for path in sorted(root.rglob(f"*{suffix}")):
            if path not in seen:
                seen.add(path)
                yield path


def _name_matches(name: str, label: str) -> bool:
    return SequenceMatcher(None, name.lower(), label.lower()).ratio() >= NAME_SIM_THRESHOLD


def match_case(members: Sequence[DonationMember], case: AuditCase) -> list[DonationMember]:
    """All rows whose honor OR name matches the case — never just the best
    one: the same player legitimately appears across several overlapping
    screenshots (see weekly_010, where Somethin_kool correctly reads 2385,
    versus the neighboring screenshot of the same message where they land
    on row 11 and read 92256). Honor serves as a row marker because two of
    the real names are themselves truncated by OCR ("Somethin kool", "ran")
    — matching by name alone would be unreliable for those two.

    Accepted limitation: two cases that share the SAME label but different
    stored/true_honor pairs (the two real "Somethin_kool"s, one per
    alliance, 92256/2385 and 955/255) are NOT mutually exclusive here — the
    name-only marker can't distinguish them, and the message_id=None scan
    (SOD report: unknown message) prevents separating them by context. A
    row from one can therefore also show up as a hit for the other, with a
    verdict of 'other' (neither its stored_honor nor its true_honor) —
    noise visible in the report, never a silently wrong PASS/FAIL. See
    test_match_case_same_named_cases_can_still_cross_match.
    """
    return [
        m
        for m in members
        if m.alliance_honor in (case.stored_honor, case.true_honor)
        or _name_matches(m.name, case.label)
    ]


Verdict = str  # "pass" | "fail" | "other"


def classify(honor: int, case: AuditCase) -> Verdict:
    """'pass' = the true value confirmed by the audit; 'fail' = the wrong
    value actually stored in prod; 'other' = neither one — reported as-is,
    never guessed."""
    if honor == case.true_honor:
        return "pass"
    if honor == case.stored_honor:
        return "fail"
    return "other"


@dataclass(frozen=True)
class RowHit:
    case: AuditCase
    image: Path
    row_index: int | None
    name: str
    parser_honor: int
    verdict_parser: Verdict
    suspect_window: tuple[int, int] | None
    reached_llm: bool
    final_honor: int | None
    final_confidence: float | None
    verdict_full: Verdict | None
    period_type: str


def scan_root(root: Path, cases: Sequence[AuditCase], *, mode: str) -> list[RowHit]:
    """mode: 'parser' (no LLM), 'full' (full pipeline), 'both'."""
    parser = get_parser(DONATION_CODE)
    if parser is None:  # pragma: no cover — defensive guard, never true in practice
        raise RuntimeError(f"No parser registered for {DONATION_CODE!r}")

    hits: list[RowHit] = []
    for path in iter_images(root):
        message_id = path.parent.name
        applicable = [c for c in cases if c.message_id is None or c.message_id == message_id]
        if not applicable:
            continue

        try:
            image = preprocess_image(str(path))
        except Exception as exc:
            print(f"[skip] {path}: {exc}", file=sys.stderr)
            continue

        if not is_contribution_ranking(image):
            continue

        parsed = parser.parse(image)
        assert isinstance(parsed, DonationParseResult)

        case_matches = {c: match_case(parsed.members, c) for c in applicable}
        case_matches = {c: ms for c, ms in case_matches.items() if ms}
        if not case_matches:
            continue

        final_by_row_index: dict[int, DonationMember] = {}
        if mode in ("full", "both"):
            full_result = extract(image, event_type_override=DONATION_CODE)
            if isinstance(full_result, DonationParseResult):
                final_by_row_index = {
                    m.row_index: m for m in full_result.members if m.row_index is not None
                }

        for case, members in case_matches.items():
            for m in members:
                final = final_by_row_index.get(m.row_index) if m.row_index is not None else None
                # Reflects the real trigger of app.extract._apply_llm_fallback:
                # a "suspect" row or one below the name confidence threshold
                # is sent to the LLM as soon as LLM_FALLBACK_ENABLED is true
                # (read here from the same module, so the actually active value).
                reached_llm = _LLM_FALLBACK_ENABLED and (
                    m.suspect_honor_window is not None or m.confidence < _CONFIDENCE_THRESHOLD_NAME
                )
                hits.append(
                    RowHit(
                        case=case,
                        image=path,
                        row_index=m.row_index,
                        name=m.name,
                        parser_honor=m.alliance_honor,
                        verdict_parser=classify(m.alliance_honor, case),
                        suspect_window=m.suspect_honor_window,
                        reached_llm=reached_llm,
                        final_honor=final.alliance_honor if final is not None else None,
                        final_confidence=final.confidence if final is not None else None,
                        verdict_full=(
                            classify(final.alliance_honor, case) if final is not None else None
                        ),
                        period_type=parsed.period_type,
                    )
                )
    return hits


def summary_key(case: AuditCase) -> str:
    return f"{case.label} ({case.stored_honor}->{case.true_honor})"


def summarize(hits: Sequence[RowHit], *, cases: Sequence[AuditCase]) -> dict[str, dict[str, int]]:
    """A summary per case in `cases`: how many PASS/FAIL/OTHER hits in parser
    mode and in full mode, and how many reached the LLM. Does NOT itself
    exclude confirmed=False cases — it's up to the caller to filter `cases`
    (see main()'s --include-unconfirmed) since a summary should stay a pure
    function of the (hits, cases) pair it's given."""
    summary: dict[str, dict[str, int]] = {}
    for case in cases:
        key = summary_key(case)
        case_hits = [h for h in hits if h.case == case]
        summary[key] = {
            "hits": len(case_hits),
            "parser_pass": sum(1 for h in case_hits if h.verdict_parser == "pass"),
            "parser_fail": sum(1 for h in case_hits if h.verdict_parser == "fail"),
            "full_pass": sum(1 for h in case_hits if h.verdict_full == "pass"),
            "full_fail": sum(1 for h in case_hits if h.verdict_full == "fail"),
            "reached_llm": sum(1 for h in case_hits if h.reached_llm),
        }
    return summary


def format_report(
    hits: Sequence[RowHit],
    *,
    all_cases: Sequence[AuditCase],
    summary_cases: Sequence[AuditCase],
    root: Path,
    mode: str,
) -> str:
    lines: list[str] = []
    lines.append("=== row-11 honor-monotonicity audit-case verification ===")
    lines.append(f"root: {root}   mode: {mode}")
    lines.append(f"cases: {len(all_cases)} ({sum(1 for c in all_cases if c.confirmed)} confirmed)")

    if not hits:
        lines.append("\n(no matching row found for any case)")
        return "\n".join(lines)

    lines.append("\nper-hit:")
    for h in sorted(hits, key=lambda h: (h.case.label, h.case.stored_honor, str(h.image))):
        confirmed_tag = "" if h.case.confirmed else " [unconfirmed]"
        # h.name is printed alongside the case label because a match by
        # honor value alone (no name similarity) can legitimately hit an
        # unrelated player who happens to share that honor this week — a
        # real example found on the first real corpus run: row 6 of
        # Screenshot_20260516_222021 is "KOR.morningstar", honor 955, a
        # completely different, unrelated player from the SOD "Somethin_kool"
        # case (955/255) matched purely by the honor coincidence. Printing
        # the name lets a human spot that at a glance instead of assuming
        # every "fail" verdict is evidence of an unfixed bug.
        name_flag = (
            "" if _name_matches(h.name, h.case.label) else "  [name differs — likely unrelated]"
        )
        lines.append(
            f"  {h.case.label}{confirmed_tag}"
            f" (want {h.case.true_honor}, stored {h.case.stored_honor}) — {h.image}"
        )
        lines.append(f"    name={h.name!r}{name_flag}")
        lines.append(
            f"    row_index={h.row_index}  period_type={h.period_type}  "
            f"parser_honor={h.parser_honor} [{h.verdict_parser}]  "
            f"suspect_window={h.suspect_window}  reached_llm={h.reached_llm}"
        )
        if h.final_honor is not None:
            lines.append(
                f"    final_honor={h.final_honor} [{h.verdict_full}]  "
                f"final_confidence={h.final_confidence}"
            )

    lines.append("\nsummary:")
    summary = summarize(hits, cases=summary_cases)
    if not summary:
        lines.append("  (no case matched)")
    for key, s in summary.items():
        lines.append(
            f"  {key}: hits={s['hits']}  parser pass/fail={s['parser_pass']}/{s['parser_fail']}  "
            f"full pass/fail={s['full_pass']}/{s['full_fail']}  reached_llm={s['reached_llm']}"
        )

    excluded = [c for c in all_cases if c not in summary_cases]
    if excluded:
        lines.append(
            f"\n({len(excluded)} unconfirmed case(s) excluded from the summary above — "
            "reported per-hit only, per the source audit's own caveat; rerun with "
            "--include-unconfirmed to include them)"
        )

    return "\n".join(lines)


def _default_inbox_root() -> Path:
    """Same guard as measure_tab_delta.py — see its docstring for the full
    reasoning (no 4th parent when only apps/ocr-service is copied into the
    Docker image)."""
    here = Path(__file__).resolve()
    if len(here.parents) > 3:
        return here.parents[3] / "data" / "inbox"
    return here.parent / "_no_default_inbox_root_pass_--root_explicitly"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    default_root = _default_inbox_root()
    parser.add_argument(
        "--root",
        type=Path,
        default=default_root,
        help=f"Root to scan (default: {default_root})",
    )
    parser.add_argument(
        "--mode", choices=("parser", "full", "both"), default="both", help="Passes to run"
    )
    parser.add_argument(
        "--include-unconfirmed",
        action="store_true",
        help="Also include cases not re-verified on screen (LOL #4) in the summary",
    )
    parser.add_argument("--json", action="store_true", help="JSON output instead of the text report")
    parser.add_argument(
        "--fail-on-regression",
        action="store_true",
        help="Exit code 1 if a confirmed case is FAIL in full mode",
    )
    args = parser.parse_args()

    if not args.root.is_dir():
        print(f"Root not found: {args.root}", file=sys.stderr)
        return 2

    # Always scan ALL cases (an unconfirmed case must still be reported
    # per-hit) — --include-unconfirmed only changes what the SUMMARY
    # displays, via summary_cases below.
    hits = scan_root(args.root, CASES, mode=args.mode)
    summary_cases = CASES if args.include_unconfirmed else tuple(c for c in CASES if c.confirmed)

    if args.json:
        payload = {
            "root": str(args.root),
            "mode": args.mode,
            "hits": [{**asdict(h), "image": str(h.image), "case": asdict(h.case)} for h in hits],
            "summary": summarize(hits, cases=summary_cases),
        }
        print(json.dumps(payload, indent=2))
    else:
        print(
            format_report(
                hits,
                all_cases=CASES,
                summary_cases=summary_cases,
                root=args.root,
                mode=args.mode,
            )
        )

    if args.fail_on_regression:
        summary = summarize(hits, cases=summary_cases)
        if any(s["full_fail"] > 0 for s in summary.values()):
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
