"""Vérifie, sur les images réelles qui les ont produits, si les cas concrets de
"donation row 11: alliance_honor=X breaks monotonicity" documentés dans les
audits `/reprocess-channel` du 2026-07-26 (voir docs/maintenance/2026-07-26-
reprocess-channel-*.md) sont aujourd'hui corrigés — plutôt que de le supposer.

Contexte : ces trois audits ont trouvé la même signature dans trois alliances
différentes : la dernière ligne d'une capture pleine page (row 11 sur
_MAX_ROWS=12, voir contribution_ranking_v1.py) casse la monotonie de
l'alliance_honor, parce que la bande de crop y est la plus mal alignée
(dérive géométrique documentée dans contribution_ranking_v1.py, lignes
~134-178). PR #29 (déjà mergée) a corrigé la circularité honor<->LLM pour les
lignes explicitement "suspect" (suspect_honor_window fixé par
_enforce_honor_monotonicity) — mais deux des cas documentés (SOD: 'ran' et
'Somethin_kool' à 955/970) ne cassent PAS la monotonie (leur valeur est plus
petite que la ligne précédente) et sont rejetés par une branche différente
(le "self-consistency gate" quand aucune fenêtre n'est fixée) que PR #29 ne
touche pas. Cet outil règle la question empiriquement, cas par cas, plutôt que
par déduction.

Deux passes par image concernée :
  - "parser" : ContributionRankingV1Parser.parse() seul, déterministe, sans LLM.
  - "full"   : app.extract.extract() — le pipeline de production complet,
    y compris le fallback LLM si LLM_FALLBACK_ENABLED (lu à l'import, voir
    app/extract.py — impossible à bascule après coup depuis ce script).

La table CASES ci-dessous est le "ground truth" : la valeur mémorisée en base
(stored_honor, ce que la capture d'origine a produit) sert de repère de ligne
au même titre que le nom, car deux des noms réels sont eux-mêmes tronqués par
l'OCR ("Somethin kool", "ran") — matcher uniquement par nom serait peu fiable.

Usage — cet outil, comme measure_tab_delta.py, n'a pas accès à data/inbox/ ni
à un venv utilisable directement sur cet hôte (aucun `uv` sur le PATH, le
`.venv` du conteneur pointe vers un interpréteur qui n'existe que dedans, et
l'image ne contient PAS tools/ — seul app/ est copié, voir Dockerfile). La
seule invocation qui fonctionne réellement sur cet hôte :

    cd tracker
    docker compose run --rm --no-deps \\
        -e JOBS_DB_PATH=/tmp/jobs.db \\
        -v "$PWD/apps/ocr-service/tools:/app/tools:ro" \\
        -v "$PWD/data/inbox:/inbox:ro" \\
        ocr-service python tools/verify_honor_audit_cases.py --root /inbox

  --mode {parser,full,both} (défaut both)
  --include-unconfirmed   : inclut aussi les cas non re-vérifiés à l'écran (LOL #4)
  --json
  --fail-on-regression    : sortie 1 si un cas confirmé est FAIL en mode full

Note : le mode "full" appelle le vrai Ollama de production (pas d'API payante
— voir app/llm_fallback.py, _DEFAULT_BASE_URL="http://localhost:11434") et
n'est donc ni déterministe ni adapté à CI/bench.py — à lancer manuellement,
de préférence hors heures de forte utilisation Discord.
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
# Même seuil que tools/bench-ocr/bench.py:_sim — pas redéfini indépendamment.
NAME_SIM_THRESHOLD = 0.70


@dataclass(frozen=True)
class AuditCase:
    label: str  # nom joueur tel qu'imprimé dans le rapport d'audit
    stored_honor: int  # valeur FAUSSE effectivement stockée en prod — sert aussi de repère de ligne
    true_honor: int  # valeur confirmée par capture d'écran dans l'audit
    source: str  # doc + numéro de finding
    message_id: str | None = None  # None = scanner tout le corpus (message inconnu)
    confirmed: bool = True  # False = l'audit n'a pas re-vérifié à l'écran (LOL #4)


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
    # Le rapport SOD cite ces deux lignes de log mais ne précise jamais de
    # quel message elles proviennent — d'où message_id=None : on scanne tout
    # le corpus et on rapporte où la ligne apparaît.
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
    """Même garde que measure_tab_delta.py : un en-tête non reconnu lève
    UnknownEventError, traité comme « pas une Contribution Ranking »."""
    try:
        kind, code = detect_screen_kind(image)  # type: ignore[arg-type]
    except UnknownEventError:
        return False
    return kind == "donation" and code == DONATION_CODE


def iter_images(root: Path) -> Iterator[Path]:
    """*.jpg/*.jpeg/*.png, récursif, trié (déterministe)."""
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
    """Toutes les lignes dont l'honor OU le nom correspond au cas — jamais
    seulement la meilleure : le même joueur apparaît légitimement sur
    plusieurs captures qui se chevauchent (voir weekly_010, où Somethin_kool
    lit correctement 2385, contre la capture voisine du même message où il
    tombe en row 11 et lit 92256). L'honor sert de repère de ligne car deux
    des noms réels sont eux-mêmes tronqués par l'OCR ("Somethin kool", "ran")
    — matcher uniquement par nom serait peu fiable pour ces deux-là.

    Limite assumée : deux cas qui partagent le MÊME label mais des paires
    stored/true_honor différentes (les deux vrais "Somethin_kool", un par
    alliance, 92256/2385 et 955/255) ne sont PAS mutuellement exclusifs ici —
    le repère par nom seul ne peut pas les distinguer, et le scan par
    message_id=None (rapport SOD : message inconnu) empêche de les séparer
    par contexte. Une ligne de l'un peut donc aussi apparaître comme hit de
    l'autre, avec un verdict 'other' (ni son stored_honor ni son true_honor) —
    du bruit visible dans le rapport, jamais un PASS/FAIL silencieusement
    faux. Voir test_match_case_same_named_cases_can_still_cross_match.
    """
    return [
        m
        for m in members
        if m.alliance_honor in (case.stored_honor, case.true_honor)
        or _name_matches(m.name, case.label)
    ]


Verdict = str  # "pass" | "fail" | "other"


def classify(honor: int, case: AuditCase) -> Verdict:
    """'pass' = la valeur vraie confirmée par l'audit ; 'fail' = la valeur
    fausse effectivement stockée en prod ; 'other' = ni l'une ni l'autre —
    rapporté tel quel, jamais deviné."""
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
    """mode: 'parser' (pas de LLM), 'full' (pipeline complet), 'both'."""
    parser = get_parser(DONATION_CODE)
    if parser is None:  # pragma: no cover — garde défensive, jamais vrai en pratique
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
                # Reflète le vrai déclencheur d'app.extract._apply_llm_fallback :
                # une ligne "suspect" ou sous le seuil de confiance nom est
                # envoyée au LLM dès que LLM_FALLBACK_ENABLED est vrai (lu ici
                # depuis le même module, donc la valeur réellement active).
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
    """Un résumé par cas dans `cases` : combien de hits PASS/FAIL/OTHER en mode
    parser et en mode full, et combien ont atteint le LLM. N'exclut PAS les cas
    confirmed=False elle-même — c'est à l'appelant de filtrer `cases` (voir
    main()'s --include-unconfirmed) puisqu'un résumé doit rester une fonction
    pure du couple (hits, cases) qu'on lui donne."""
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
    """Même garde que measure_tab_delta.py — voir sa docstring pour le
    raisonnement complet (pas de 4e parent quand seul apps/ocr-service est
    copié dans l'image Docker)."""
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
        help=f"Racine à scanner (défaut : {default_root})",
    )
    parser.add_argument(
        "--mode", choices=("parser", "full", "both"), default="both", help="Passes à exécuter"
    )
    parser.add_argument(
        "--include-unconfirmed",
        action="store_true",
        help="Inclure aussi les cas non re-vérifiés à l'écran (LOL #4) dans le résumé",
    )
    parser.add_argument("--json", action="store_true", help="Sortie JSON au lieu du rapport texte")
    parser.add_argument(
        "--fail-on-regression",
        action="store_true",
        help="Code de sortie 1 si un cas confirmé est FAIL en mode full",
    )
    args = parser.parse_args()

    if not args.root.is_dir():
        print(f"Racine introuvable : {args.root}", file=sys.stderr)
        return 2

    # Toujours scanner TOUS les cas (un cas non confirmé doit quand même être
    # rapporté per-hit) — --include-unconfirmed ne change que ce que le RÉSUMÉ
    # affiche, via summary_cases ci-dessous.
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
