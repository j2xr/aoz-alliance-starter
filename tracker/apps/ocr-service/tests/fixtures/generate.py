"""Génère les fixtures JSON de référence pour le parseur Polar Invasion.

Les données ont été extraites manuellement depuis 8 captures d'écran Android.
Ces fichiers servent de ground truth pour les tests du parseur OCR.
"""

import json
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "polar_invasion"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ============================================================================
# Événement 1 : Polar Invasion 2026-04-07 15:00
# Alliance rank 1, 43 battlers, 21,955 points
# 5 captures à différentes positions de scroll
# ============================================================================

EVENT_01_HEADER = {
    "event_type": "polar_invasion",
    "event_datetime": "2026-04-07T15:00:00+02:00",
    "alliance_rank": 1,
    "total_battlers": 43,
    "total_points": 21955,
}

# Capture 001 : haut de liste (scores les plus élevés)
# Source : 1000006342.jpg
EVENT_01_SCROLL_001 = {
    **EVENT_01_HEADER,
    "source_file": "1000006342.jpg",
    "members": [
        {"name": "Bulleit", "rank": "R1", "power": 21067465, "points": 61091},
        {"name": "Yojimbo", "rank": "R4", "power": 22911768, "points": 48950},
        {"name": "doradora12", "rank": "R2", "power": 19093174, "points": 39879},
        {"name": "LEÓN", "rank": "R4", "power": 27132739, "points": 38932},
        {"name": "CATFIGHT", "rank": "R2", "power": 19571726, "points": 37119},
        {"name": "RageX_", "rank": "R4", "power": 26866503, "points": 37099},
        {"name": "scepter", "rank": "R3", "power": 26517561, "points": 37070},
        {"name": "Goldeneye21", "rank": "R3", "power": 20635851, "points": 35492},
        {"name": "Ichigo_19", "rank": "R1", "power": 22370871, "points": 34089},
        {"name": "FATCAT29", "rank": "R1", "power": 23211659, "points": 33242},
        {"name": "Akrid", "rank": "R2", "power": 18112489, "points": 30496},
    ],
}

# Capture 002
# Source : 1000006341.jpg
EVENT_01_SCROLL_002 = {
    **EVENT_01_HEADER,
    "source_file": "1000006341.jpg",
    "members": [
        {"name": "Akrid", "rank": "R2", "power": 18112489, "points": 30496},
        {"name": "BenOVerbich", "rank": "R3", "power": 21136644, "points": 29135},
        {"name": "JayJayOv", "rank": "R1", "power": 18265686, "points": 28770},
        {"name": "Maks", "rank": "R1", "power": 22046077, "points": 28086},
        {"name": "nuna", "rank": "R1", "power": 14232338, "points": 27933},
        {"name": "pennywise", "rank": "R1", "power": 15874678, "points": 27760},
        {"name": "CHIANTI", "rank": "R3", "power": 25379942, "points": 27289},
        {"name": "Метью", "rank": "R1", "power": 13664290, "points": 25628},
        {"name": "jc0n", "rank": "R1", "power": 27291151, "points": 25586},
        {"name": "VTN", "rank": "R1", "power": 20132176, "points": 25087},
        {"name": "Герман", "rank": "R1", "power": 13667193, "points": 24303},
    ],
}

# Capture 003
# Source : 1000006340.jpg
EVENT_01_SCROLL_003 = {
    **EVENT_01_HEADER,
    "source_file": "1000006340.jpg",
    "members": [
        {"name": "Genesis", "rank": "R1", "power": 13845497, "points": 22294},
        {"name": "ZEROHERO", "rank": "R3", "power": 26756958, "points": 22062},
        {"name": "Stoka", "rank": "R1", "power": 16022860, "points": 21517},
        {"name": "GOLF", "rank": "R4", "power": 30264445, "points": 21374},
        {"name": "JMAC", "rank": "R1", "power": 17966478, "points": 19476},
        {"name": "Xrage", "rank": "R3", "power": 17480229, "points": 18606},
        {"name": "JANI", "rank": "R1", "power": 14686753, "points": 17213},
        {"name": "Dyaaan", "rank": "R1", "power": 18416759, "points": 17115},
        {"name": "HEAVYMETAL", "rank": "R2", "power": 22008089, "points": 15590},
        {"name": "Insidious", "rank": "R1", "power": 15920491, "points": 11189},
        {"name": "Gattopardo", "rank": "R1", "power": 27657753, "points": 9357},
    ],
}

# Capture 004
# Source : 1000006339.jpg
EVENT_01_SCROLL_004 = {
    **EVENT_01_HEADER,
    "source_file": "1000006339.jpg",
    "members": [
        {"name": "Gattopardo", "rank": "R1", "power": 27657753, "points": 9357},
        {"name": "Yuyuyu325", "rank": "R2", "power": 15103026, "points": 9065},
        {"name": "おーしあ", "rank": "R2", "power": 25942393, "points": 8801},
        {"name": "Duvan395", "rank": "R4", "power": 25064275, "points": 7677},
        {"name": "BakersBakedd27", "rank": "R1", "power": 13888203, "points": 7627},
        {"name": "KlausRider", "rank": "R1", "power": 19432561, "points": 7546},
        {"name": "Garbageman", "rank": "R2", "power": 10644329, "points": 7304},
        {"name": "KOR.Park", "rank": "R1", "power": 19695471, "points": 5571},
        {"name": "Медвежонок", "rank": "R3", "power": 27848366, "points": 4125},
        {"name": "DarKKnight", "rank": "R4", "power": 25880671, "points": 1514},
        {"name": "SNIPER", "rank": "R1", "power": 19550372, "points": 0},
    ],
}

# Capture 005 : bas de liste (scores les plus bas, inclut des 0)
# Source : 1000006338.jpg
EVENT_01_SCROLL_005 = {
    **EVENT_01_HEADER,
    "source_file": "1000006338.jpg",
    "members": [
        {"name": "Yuyuyu325", "rank": "R2", "power": 15103026, "points": 9065},
        {"name": "おーしあ", "rank": "R2", "power": 25942393, "points": 8801},
        {"name": "Duvan395", "rank": "R4", "power": 25064275, "points": 7677},
        {"name": "BakersBakedd27", "rank": "R1", "power": 13888203, "points": 7627},
        {"name": "KlausRider", "rank": "R1", "power": 19432561, "points": 7546},
        {"name": "Garbageman", "rank": "R2", "power": 10644329, "points": 7304},
        {"name": "KOR.Park", "rank": "R1", "power": 19695471, "points": 5571},
        {"name": "Медвежонок", "rank": "R3", "power": 27848366, "points": 4125},
        {"name": "DarKKnight", "rank": "R4", "power": 25880671, "points": 1514},
        {"name": "SNIPER", "rank": "R1", "power": 19550372, "points": 0},
        {"name": "Cummins", "rank": "R1", "power": 15969312, "points": 0},
    ],
}

# ============================================================================
# Événement 2 : Polar Invasion 2026-04-14 23:00
# Alliance rank 2, 26 battlers, 11,630 points
# 3 captures à différentes positions de scroll
# ============================================================================

EVENT_02_HEADER = {
    "event_type": "polar_invasion",
    "event_datetime": "2026-04-14T23:00:00+02:00",
    "alliance_rank": 2,
    "total_battlers": 26,
    "total_points": 11630,
}

# Capture 001 : haut de liste
# Source : 1000006345.jpg
EVENT_02_SCROLL_001 = {
    **EVENT_02_HEADER,
    "source_file": "1000006345.jpg",
    "members": [
        {"name": "Bulleit", "rank": "R2", "power": 21671521, "points": 65920},
        {"name": "Edu", "rank": "R4", "power": 41191106, "points": 48917},
        {"name": "scepter", "rank": "R3", "power": 26771549, "points": 29168},
        {"name": "KlausRider", "rank": "R1", "power": 19515555, "points": 28436},
        {"name": "Yojimbo", "rank": "R5", "power": 23324091, "points": 27935},
        {"name": "Maks", "rank": "R1", "power": 22261270, "points": 21443},
        {"name": "FATCAT29", "rank": "R1", "power": 23197016, "points": 17682},
        {"name": "beandip", "rank": "R3", "power": 29269133, "points": 16739},
        {"name": "ZEROHERO", "rank": "R3", "power": 26909654, "points": 16284},
        {"name": "JMAC", "rank": "R1", "power": 18144616, "points": 16001},
        {"name": "LATAM.REYCOLIMAN", "rank": "R1", "power": 15935383, "points": 15855},
    ],
}

# Capture 002
# Source : 1000006344.jpg
EVENT_02_SCROLL_002 = {
    **EVENT_02_HEADER,
    "source_file": "1000006344.jpg",
    "members": [
        {"name": "LATAM.REYCOLIMAN", "rank": "R1", "power": 15935383, "points": 15855},
        {"name": "1jr", "rank": "R3", "power": 17889854, "points": 15233},
        {"name": "Hardcore101", "rank": "R2", "power": 12507630, "points": 12524},
        {"name": "Blitzdog", "rank": "R1", "power": 17835678, "points": 12003},
        {"name": "THOR,01", "rank": "R1", "power": 17892348, "points": 11588},
        {"name": "Bumbelbee", "rank": "R1", "power": 17254144, "points": 10868},
        {"name": "Stoka", "rank": "R1", "power": 16427949, "points": 10816},
        {"name": "SNIPER", "rank": "R1", "power": 19975359, "points": 10674},
        {"name": "KANHA_", "rank": "R2", "power": 13563455, "points": 9263},
        {"name": "Толик", "rank": "R1", "power": 11215167, "points": 8214},
        {"name": "BakersBakedd27", "rank": "R1", "power": 14090873, "points": 7319},
    ],
}

# Capture 003 : bas de liste (inclut un 0)
# Source : 1000006343.jpg
EVENT_02_SCROLL_003 = {
    **EVENT_02_HEADER,
    "source_file": "1000006343.jpg",
    "members": [
        {"name": "Bumbelbee", "rank": "R1", "power": 17254144, "points": 10868},
        {"name": "Stoka", "rank": "R1", "power": 16427949, "points": 10816},
        {"name": "SNIPER", "rank": "R1", "power": 19975359, "points": 10674},
        {"name": "KANHA_", "rank": "R2", "power": 13563455, "points": 9263},
        {"name": "Толик", "rank": "R1", "power": 11215167, "points": 8214},
        {"name": "BakersBakedd27", "rank": "R1", "power": 14090873, "points": 7319},
        {"name": "Bigdog", "rank": "R1", "power": 13155440, "points": 3157},
        {"name": "kor,spark", "rank": "R1", "power": 23856864, "points": 2953},
        {"name": "BORZ", "rank": "R3", "power": 22664568, "points": 2319},
        {"name": "Ichigo_19", "rank": "R1", "power": 22747830, "points": 1274},
        {"name": "TomeyNYC", "rank": "R1", "power": 12362806, "points": 0},
    ],
}

# ============================================================================
# Écriture des fichiers
# ============================================================================

FIXTURES = [
    ("20260407T1500_001.json", EVENT_01_SCROLL_001),
    ("20260407T1500_002.json", EVENT_01_SCROLL_002),
    ("20260407T1500_003.json", EVENT_01_SCROLL_003),
    ("20260407T1500_004.json", EVENT_01_SCROLL_004),
    ("20260407T1500_005.json", EVENT_01_SCROLL_005),
    ("20260414T2300_001.json", EVENT_02_SCROLL_001),
    ("20260414T2300_002.json", EVENT_02_SCROLL_002),
    ("20260414T2300_003.json", EVENT_02_SCROLL_003),
]

for filename, data in FIXTURES:
    path = OUTPUT_DIR / filename
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Wrote {path} ({len(data['members'])} members)")

# ============================================================================
# Stats de validation
# ============================================================================

print("\n=== Validation stats ===")

# Unique players per event
for label, fixtures in [
    ("Event 1 (2026-04-07)", FIXTURES[:5]),
    ("Event 2 (2026-04-14)", FIXTURES[5:]),
]:
    all_names = set()
    for _, data in fixtures:
        for m in data["members"]:
            all_names.add(m["name"])
    print(f"{label}: {len(all_names)} unique players across captures")

# Edge case pseudos
all_names = set()
for _, data in FIXTURES:
    for m in data["members"]:
        all_names.add(m["name"])

edge_cases = {
    "cyrillic": [n for n in all_names if any("\u0400" <= c <= "\u04ff" for c in n)],
    "japanese": [n for n in all_names if any("\u3040" <= c <= "\u30ff" for c in n)],
    "accented": [n for n in all_names if any(c in "ÀÁÂÄÇÈÉÊËÌÍÎÏÒÓÔÖÙÚÛÜÑ" for c in n)],
    "with_digits": [n for n in all_names if any(c.isdigit() for c in n)],
    "with_punct": [n for n in all_names if any(c in ".,_" for c in n)],
}
print("\nEdge cases in pseudos:")
for category, names in edge_cases.items():
    print(f"  {category}: {sorted(names)}")
