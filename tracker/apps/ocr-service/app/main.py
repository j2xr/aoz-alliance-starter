import asyncio
import json
import logging
import os
import tempfile
import time
import uuid
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

import aiosqlite
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

from app.dispatcher import UnknownEventError, refresh_title_patterns_from_supabase
from app.extract import extract
from app.preprocess import preprocess_image
from app.tess_engine import current_backend, health_check, shutdown_pool

# Honour LOG_LEVEL from .env so app loggers (extract, parsers, llm_fallback)
# actually emit their INFO/DEBUG output. Without this, Python defaults to
# WARNING and only logger.exception(...) is visible.
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)

_ONE_HOUR = 3600.0

_db: aiosqlite.Connection | None = None
_loop: asyncio.AbstractEventLoop | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global _db, _loop
    _loop = asyncio.get_running_loop()
    db_path = os.getenv("JOBS_DB_PATH", "/data/jobs.db")
    logger.info("OCR service starting (tesseract backend: %s)", current_backend())

    _db = await aiosqlite.connect(db_path)
    await _db.execute(
        """
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            payload TEXT,
            created_at REAL NOT NULL
        )
        """
    )
    await _db.commit()

    # Mark pending jobs orphaned by a previous crash as errors so the bot
    # doesn't poll indefinitely after a container restart.
    await _db.execute(
        "UPDATE jobs SET status = 'error', payload = ? WHERE status = 'pending'",
        (json.dumps({"error": "restarted"}),),
    )
    # Remove terminal jobs older than 1 hour to bound DB size.
    cutoff = time.time() - _ONE_HOUR
    await _db.execute(
        "DELETE FROM jobs WHERE status IN ('done', 'error') AND created_at < ?",
        (cutoff,),
    )
    await _db.commit()

    logger.info("Job store ready (%s)", db_path)

    # Alias de titres pilotés par la base (at_event_types.title_aliases) ;
    # fallback statique si la base est injoignable ou non configurée.
    try:
        refreshed = await asyncio.to_thread(refresh_title_patterns_from_supabase)
        logger.info(
            "Title patterns source: %s",
            "supabase (at_event_types)" if refreshed else "built-in fallback",
        )
    except Exception:
        logger.exception("Failed to load title aliases from Supabase — using built-in fallback")

    try:
        yield
    finally:
        await _db.close()
        _db = None
        shutdown_pool()
        logger.info("OCR service stopped")


async def _set_job(job_id: str, status: str, payload: dict[str, Any] | None = None) -> None:
    assert _db is not None
    await _db.execute(
        "INSERT OR REPLACE INTO jobs (id, status, payload, created_at) VALUES (?, ?, ?, ?)",
        (
            job_id,
            status,
            json.dumps(payload) if payload is not None else None,
            time.time(),
        ),
    )
    if status in ("done", "error"):
        # Opportunistic TTL sweep, piggybacked on terminal writes: bounds the
        # table without deleting a row the instant it's first read, which lost
        # results to a dropped bot connection or a poll retry (see _get_job).
        cutoff = time.time() - _ONE_HOUR
        await _db.execute(
            "DELETE FROM jobs WHERE status IN ('done', 'error') AND created_at < ?",
            (cutoff,),
        )
    await _db.commit()


async def _get_job(job_id: str) -> dict[str, Any] | None:
    assert _db is not None
    async with _db.execute("SELECT status, payload FROM jobs WHERE id = ?", (job_id,)) as cursor:
        row = await cursor.fetchone()
    if row is None:
        return None
    status: str = row[0]
    payload_json: str | None = row[1]
    payload: dict[str, Any] = json.loads(payload_json) if payload_json is not None else {}
    return {"status": status, **payload}


def _submit(coro: Coroutine[Any, Any, None]) -> None:
    """Submit a coroutine to the app event loop from a sync worker thread."""
    assert _loop is not None
    asyncio.run_coroutine_threadsafe(coro, _loop).result()


app = FastAPI(title="OCR Service", version="0.2.0", lifespan=lifespan)


@app.get("/health")
async def health() -> JSONResponse:
    tesseract_ok = await asyncio.to_thread(health_check)

    db_ok = False
    if _db is not None:
        try:
            await _db.execute("SELECT 1")
            db_ok = True
        except Exception:
            logger.exception("Job store health check failed")

    healthy = tesseract_ok and db_ok
    return JSONResponse(
        content={
            "status": "ok" if healthy else "degraded",
            "tesseract": tesseract_ok,
            "db": db_ok,
        },
        status_code=200 if healthy else 503,
    )


def _run_job(job_id: str, tmp_path: Path, event_type: str | None, force_llm: bool) -> None:
    """Synchronous worker; FastAPI runs sync background tasks in a threadpool."""
    try:
        image = preprocess_image(str(tmp_path))
        try:
            result = extract(image, event_type_override=event_type, force_llm=force_llm)
        except UnknownEventError:
            logger.info("Job %s: unknown event type", job_id)
            _submit(_set_job(job_id, "error", {"error": "unknown_event"}))
            return
        _submit(_set_job(job_id, "done", {"result": result.model_dump()}))
        logger.info("Job %s: done", job_id)
    except Exception as exc:
        logger.exception("Job %s failed", job_id)
        _submit(_set_job(job_id, "error", {"error": "internal_error", "detail": str(exc)}))
    finally:
        tmp_path.unlink(missing_ok=True)


@app.post("/extract", status_code=202)
async def extract_screenshot(
    background_tasks: BackgroundTasks,
    file: Annotated[UploadFile, File(...)],
    event_type: str | None = Query(
        default=None, description="Force event type detection (skips OCR header)"
    ),
    force_llm: bool = Query(
        default=False, description="Apply LLM fallback to all rows regardless of confidence"
    ),
) -> JSONResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    suffix = Path(file.filename or "img.png").suffix or ".png"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = Path(tmp.name)

    job_id = uuid.uuid4().hex
    await _set_job(job_id, "pending")
    background_tasks.add_task(_run_job, job_id, tmp_path, event_type, force_llm)
    logger.info(
        "Job %s: scheduled (%s, event_type=%s, force_llm=%s)",
        job_id,
        file.filename,
        event_type,
        force_llm,
    )
    return JSONResponse(
        content={"job_id": job_id, "status": "pending"},
        status_code=202,
    )


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> JSONResponse:
    job = await _get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] == "done":
        return JSONResponse(content={"status": "done", "result": job["result"]})
    if job["status"] == "error":
        payload: dict[str, Any] = {"status": "error", "error": job["error"]}
        if job.get("detail") is not None:
            payload["detail"] = job["detail"]
        return JSONResponse(content=payload)
    return JSONResponse(content={"status": "pending"})
