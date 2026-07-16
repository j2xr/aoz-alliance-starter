import os

import numpy as np
import pytest

# Use an in-memory SQLite DB for tests so every TestClient context starts
# with a fresh, empty job store without touching the filesystem.
os.environ.setdefault("JOBS_DB_PATH", ":memory:")


@pytest.fixture
def dark_screenshot() -> np.ndarray:
    """1920×1080 BGR image with dark background (simulates a game screenshot)."""
    return np.full((1920, 1080, 3), 30, dtype=np.uint8)


@pytest.fixture
def blank_preprocessed() -> np.ndarray:
    """1920×1080 white grayscale binary image (post-preprocessing)."""
    return np.full((1920, 1080), 255, dtype=np.uint8)
