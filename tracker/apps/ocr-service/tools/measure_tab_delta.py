"""Mesure la distribution des deltas de détection d'onglet (_detect_selected_tab)
sur un corpus réel de captures, pour vérifier empiriquement la politique
d'ambiguïté actuelle plutôt que de la refaire à la main à chaque fois.

Contexte : contribution_ranking_v1.py rejette désormais une capture ("unknown")
quand aucune pilule d'onglet ne ressort clairement (delta < OCR_TAB_DETECT_MIN_DELTA
= 15.0 par défaut), au lieu de supposer silencieusement "weekly". Ce seuil a été
choisi entre un plancher de bruit mesuré (10.1, bande mal visée) et un plafond de
signal mesuré (25.1, bande correcte) sur 56 images lors du correctif du
2026-07-26 — mais ces deux chiffres sortaient d'un script de sondage jetable,
jamais versionné. Cet outil reproduit exactement la même mesure (via
tab_zone_stats, la fonction que _detect_selected_tab utilise elle-même en
production), de façon rejouable, pour répondre à la question laissée en
suspens : « à quelle fréquence une vraie capture Weekly tombera-t-elle dans la
bande morte [seuil, 25.1) et sera rejetée à tort ? ».

Usage (depuis apps/ocr-service/, venv hôte — data/inbox n'est PAS monté dans
le conteneur ocr-service, voir docker-compose.yml) :

    uv run python tools/measure_tab_delta.py                     # data/inbox par défaut
    uv run python tools/measure_tab_delta.py --include-fixtures
    uv run python tools/measure_tab_delta.py --json > report.json
    # exit 1 si la bande morte n'est pas vide :
    uv run python tools/measure_tab_delta.py --fail-on-dead-band

Via Docker, avec un montage ad hoc :

    docker compose run --rm -v "$PWD/../../data/inbox:/inbox:ro" ocr-service \\
        python tools/measure_tab_delta.py --root /inbox
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from app.dispatcher import DONATION_CODE, UnknownEventError, detect_screen_kind
from app.parsers.contribution_ranking_v1 import _TAB_DETECT_MIN_DELTA, _TABS_ORDER, tab_zone_stats
from app.preprocess import preprocess_image

# Repères mesurés le 2026-07-26 (voir le commentaire de calibration dans
# contribution_ranking_v1.py) : plafond de bruit de l'ancienne bande mal
# visée, plancher de signal de la bande correcte. Cet outil existe pour
# REVÉRIFIER ces deux chiffres, pas pour les redéfinir — s'ils dérivent avec
# de nouvelles captures, c'est ici qu'on doit s'en apercevoir, pas dans un
# commentaire figé qui ne sera jamais relu.
NOISE_CEILING = 10.1
SIGNAL_FLOOR = 25.1

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png")


@dataclass(frozen=True)
class TabMeasurement:
    path: Path
    width: int
    height: int
    means: tuple[float, ...]
    delta: float
    detected: str  # "daily" | "weekly" | "history" | "unknown" | "unsampleable"


def classify_delta(
    delta: float,
    *,
    threshold: float,
    noise_ceiling: float = NOISE_CEILING,
    signal_floor: float = SIGNAL_FLOOR,
) -> str:
    """'noise' | 'below_threshold' | 'dead_band' | 'signal'.

    Bornes semi-ouvertes (voir test_measure_tab_delta_tool.py pour chaque
    valeur pivot) :
      noise           : delta <  noise_ceiling
      below_threshold : noise_ceiling <= delta < threshold
      dead_band       : threshold     <= delta < signal_floor  -- doit rester vide
      signal          : delta >= signal_floor

    'dead_band' = accepté par le seuil courant alors qu'AUCUNE capture réelle
    mesurée n'a jamais produit un signal aussi faible. Si cette bande se
    remplit, le seuil ou la bande d'onglet a dérivé depuis la calibration.
    """
    if delta < noise_ceiling:
        return "noise"
    if delta < threshold:
        return "below_threshold"
    if delta < signal_floor:
        return "dead_band"
    return "signal"


def is_contribution_ranking(image: object) -> bool:
    """detect_screen_kind() lève UnknownEventError sur un en-tête non reconnu
    — traité comme « pas une Contribution Ranking », pas comme une erreur."""
    try:
        kind, code = detect_screen_kind(image)  # type: ignore[arg-type]
    except UnknownEventError:
        return False
    return kind == "donation" and code == DONATION_CODE


def iter_images(roots: Sequence[Path]) -> Iterator[Path]:
    """*.jpg/*.jpeg/*.png, récursif, trié (déterministe), dédupliqué entre racines."""
    seen: set[Path] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for suffix in IMAGE_SUFFIXES:
            for path in sorted(root.rglob(f"*{suffix}")):
                if path not in seen:
                    seen.add(path)
                    yield path


def measure_image(path: Path, *, screen_filter: bool) -> TabMeasurement | None:
    """None = image ignorée (pas une Contribution Ranking quand screen_filter=True,
    ou fichier illisible). Une image reconnue mais géométriquement
    inéchantillonnable (tab_zone_stats() -> None) est quand même rapportée,
    avec detected='unsampleable', plutôt que silencieusement disparue."""
    try:
        image = preprocess_image(str(path))
    except Exception as exc:
        print(f"[skip] {path}: {exc}", file=sys.stderr)
        return None

    if screen_filter and not is_contribution_ranking(image):
        return None

    h, w = image.shape[:2]
    stats = tab_zone_stats(image)
    if stats is None:
        return TabMeasurement(
            path=path, width=w, height=h, means=(), delta=0.0, detected="unsampleable"
        )
    means, delta, idx = stats
    return TabMeasurement(
        path=path, width=w, height=h, means=tuple(means), delta=delta, detected=_TABS_ORDER[idx]
    )


def summarize(
    measurements: Sequence[TabMeasurement], *, threshold: float
) -> tuple[dict[str, int], dict[str, dict[str, float]]]:
    """(histogramme par bande, stats min/max/mean par onglet détecté).

    N'attend que des mesures échantillonnables (`detected != 'unsampleable'`) —
    filtrer avant l'appel.
    """
    histogram = {"noise": 0, "below_threshold": 0, "dead_band": 0, "signal": 0}
    per_tab: dict[str, list[float]] = {}

    for m in measurements:
        band = classify_delta(m.delta, threshold=threshold)
        histogram[band] += 1
        per_tab.setdefault(m.detected, []).append(m.delta)

    per_tab_stats = {
        tab: {
            "n": len(deltas),
            "min": min(deltas),
            "max": max(deltas),
            "mean": sum(deltas) / len(deltas),
        }
        for tab, deltas in per_tab.items()
    }
    return histogram, per_tab_stats


def format_report(
    measurements: Sequence[TabMeasurement], *, root: Path, threshold: float, total_scanned: int
) -> str:
    sampleable = [m for m in measurements if m.detected != "unsampleable"]
    unsampleable_count = len(measurements) - len(sampleable)

    lines: list[str] = []
    lines.append("=== tab-detection delta sweep ===")
    lines.append(f"root:                              {root}")
    lines.append(f"_TAB_DETECT_MIN_DELTA (effective): {threshold}")
    lines.append(
        f"band edges:                        "
        f"noise_ceiling={NOISE_CEILING}  signal_floor={SIGNAL_FLOOR}"
    )
    lines.append(
        f"scanned:                           {total_scanned} image(s) -> "
        f"{len(measurements)} contribution-ranking capture(s)"
    )
    if unsampleable_count:
        lines.append(f"  ({unsampleable_count} of those could not be sampled — too short/narrow)")

    if not sampleable:
        lines.append("\n(no sampleable Contribution Ranking capture found)")
        return "\n".join(lines)

    lines.append("\nper-image (sorted by delta asc):")
    for m in sorted(sampleable, key=lambda m: m.delta):
        means_str = "[" + ", ".join(f"{v:.1f}" for v in m.means) + "]"
        lines.append(
            f"  delta={m.delta:5.1f}  {m.detected:<8} means={means_str}  "
            f"{m.width}x{m.height}  {m.path}"
        )

    histogram, per_tab = summarize(sampleable, threshold=threshold)
    lines.append("\nband histogram:")
    lines.append(f"  < {NOISE_CEILING:<10}  noise / no signal          : {histogram['noise']:>3}")
    lines.append(
        f"  {NOISE_CEILING} - {threshold:<7}below threshold (rejected) : "
        f"{histogram['below_threshold']:>3}"
    )
    lines.append(
        f"  {threshold} - {SIGNAL_FLOOR:<7}DEAD BAND                  : "
        f"{histogram['dead_band']:>3}   <-- must stay 0"
    )
    lines.append(f"  >= {SIGNAL_FLOOR:<9} real signal                : {histogram['signal']:>3}")

    lines.append("\nper-detected-tab deviation:")
    for tab in (*_TABS_ORDER, "unknown"):
        stats = per_tab.get(tab)
        if stats is None:
            lines.append(f"  {tab:<7}: n=0")
        else:
            lines.append(
                f"  {tab:<7}: n={stats['n']:<4} min={stats['min']:.1f}  "
                f"max={stats['max']:.1f}  mean={stats['mean']:.1f}"
            )

    dead_band = histogram["dead_band"]
    margin_below = threshold - NOISE_CEILING
    margin_above = SIGNAL_FLOOR - threshold
    lines.append(
        f"\ndead-band captures: {dead_band}   "
        f"(threshold {threshold} has {margin_below:.1f} of noise margin below "
        f"and {margin_above:.1f} of signal margin above)"
    )
    return "\n".join(lines)


def _default_inbox_root() -> Path:
    """tools/measure_tab_delta.py -> tools -> ocr-service -> apps -> tracker
    (4 parents) in a full monorepo checkout. Inside the Docker image only
    apps/ocr-service is copied to /app, so there's no "tracker" ancestor to
    find there — fall back to a path that simply won't exist rather than
    raising IndexError; main() already handles a missing root by requiring
    --root explicitly (see the module docstring's Docker invocation)."""
    here = Path(__file__).resolve()
    if len(here.parents) > 3:
        return here.parents[3] / "data" / "inbox"
    return here.parent / "_no_default_inbox_root_pass_--root_explicitly"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    default_root = _default_inbox_root()
    fixtures_root = (
        Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "contribution_ranking"
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=default_root,
        help=f"Racine à scanner (défaut : {default_root})",
    )
    parser.add_argument(
        "--include-fixtures", action="store_true", help="Inclure aussi les fixtures de test"
    )
    parser.add_argument(
        "--no-screen-filter",
        action="store_true",
        help=(
            "Ne pas filtrer par type d'écran (mesure toute image comme si c'était "
            "une Contribution Ranking) — plus rapide (saute l'OCR d'en-tête), "
            "réservé à un dossier déjà homogène (ex. fixtures/), pas à data/inbox."
        ),
    )
    parser.add_argument("--json", action="store_true", help="Sortie JSON au lieu du rapport texte")
    parser.add_argument(
        "--fail-on-dead-band",
        action="store_true",
        help="Code de sortie 1 si la bande morte [seuil, signal_floor) n'est pas vide",
    )
    args = parser.parse_args()

    roots = [args.root]
    if args.include_fixtures:
        roots.append(fixtures_root)

    if not any(r.is_dir() for r in roots):
        print(f"Aucune racine trouvée parmi : {[str(r) for r in roots]}", file=sys.stderr)
        return 2

    screen_filter = not args.no_screen_filter
    all_paths = list(iter_images(roots))
    measurements = [
        m
        for path in all_paths
        if (m := measure_image(path, screen_filter=screen_filter)) is not None
    ]

    if args.json:
        payload = {
            "root": str(args.root),
            "threshold": _TAB_DETECT_MIN_DELTA,
            "total_scanned": len(all_paths),
            "measurements": [{**asdict(m), "path": str(m.path)} for m in measurements],
        }
        print(json.dumps(payload, indent=2))
    else:
        print(
            format_report(
                measurements,
                root=args.root,
                threshold=_TAB_DETECT_MIN_DELTA,
                total_scanned=len(all_paths),
            )
        )

    if args.fail_on_dead_band:
        sampleable = [m for m in measurements if m.detected != "unsampleable"]
        histogram, _ = summarize(sampleable, threshold=_TAB_DETECT_MIN_DELTA)
        if histogram["dead_band"] > 0:
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
