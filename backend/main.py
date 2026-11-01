"""Smart Gate Keeper API.

Run:  uvicorn main:app --reload --port 8000
"""
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import Depends, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from models import Base, GateAccessLog, User, engine, get_db

# --------------------------------------------------------------------------- config
SECRET_KEY = os.getenv("SGK_SECRET", "dev-only-change-me").encode()
PASS_TTL_SECONDS = 15 * 60
CLOCK_SKEW_SECONDS = 30

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Smart Gate Keeper API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("SGK_CORS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- schemas
class GenerateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    usn: str = Field(min_length=1, max_length=32)
    department: str = Field(default="General", max_length=80)
    pass_type: Literal["Student Daily", "Visitor Pre-Approved"]


class VerifyIn(BaseModel):
    qr_payload: Optional[str] = None  # raw JSON string decoded from the QR code
    usn: Optional[str] = None  # manual fallback entry
    gate: int = Field(default=1, ge=1, le=99)


# --------------------------------------------------------------------------- helpers
def sign(usn: str, pass_id: str, timestamp: int) -> str:
    msg = f"{usn}|{pass_id}|{timestamp}".encode()
    return hmac.new(SECRET_KEY, msg, hashlib.sha256).hexdigest()[:32]


def serialize_log(l: GateAccessLog) -> dict:
    return {
        "id": l.id,
        "usn": l.usn,
        "name": l.name,
        "pass_type": l.pass_type,
        "direction": l.direction,
        "timestamp": l.timestamp.isoformat() + "Z",
        "gate": l.gate,
        "status": l.status.title(),  # "Granted" / "Denied"
        "reason": l.reason,
    }


def start_of_today_utc() -> datetime:
    local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    return local_midnight.astimezone(timezone.utc).replace(tzinfo=None)


def record(db: Session, *, usn: str, user: Optional[User], gate: int, granted: bool,
           reason: str, pass_id: Optional[str] = None) -> GateAccessLog:
    direction = "—"
    if granted and user:
        last = db.scalar(
            select(GateAccessLog)
            .where(GateAccessLog.user_id == user.id, GateAccessLog.status == "GRANTED")
            .order_by(GateAccessLog.id.desc())
            .limit(1)
        )
        direction = "OUT" if last and last.direction == "IN" else "IN"

    log = GateAccessLog(
        user_id=user.id if user else None,
        usn=usn,
        name=user.name if user else "Unknown",
        pass_type=user.pass_type if user else "-",
        pass_id=pass_id,
        direction=direction,
        status="GRANTED" if granted else "DENIED",
        reason=reason,
        gate=gate,
    )
    db.add(log)
    db.commit()
    return log


def verify_response(log: GateAccessLog, user: Optional[User]) -> dict:
    granted = log.status == "GRANTED"
    kind = "Visitor" if user and user.pass_type.startswith("Visitor") else "Student"
    return {
        "granted": granted,
        "message": f"ACCESS GRANTED - {kind} Verified" if granted else "ACCESS DENIED - Pass Expired or Invalid",
        "reason": log.reason,
        "direction": log.direction,
        "user": {"name": user.name, "usn": user.usn, "department": user.department,
                 "pass_type": user.pass_type} if user else None,
        "log": serialize_log(log),
    }


# --------------------------------------------------------------------------- endpoints
@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/pass/generate")
def generate_pass(body: GenerateIn, db: Session = Depends(get_db)):
    usn = body.usn.strip().upper()
    user = db.scalar(select(User).where(User.usn == usn))
    if not user:
        user = User(usn=usn, name=body.name.strip(), department=body.department, pass_type=body.pass_type)
        db.add(user)
    else:
        user.name, user.department, user.pass_type = body.name.strip(), body.department, body.pass_type

    issued_at = int(time.time())
    pass_id = secrets.token_hex(8)
    user.active_pass_id = pass_id  # supersedes any earlier QR for this user
    user.active_pass_issued_at = issued_at
    db.commit()

    return {
        "pass_id": pass_id,
        "name": user.name,
        "usn": usn,
        "department": user.department,
        "pass_type": user.pass_type,
        "issued_at": issued_at,
        "expires_at": issued_at + PASS_TTL_SECONDS,
        "payload": {
            "usn": usn,
            "timestamp": issued_at,
            "pass_id": pass_id,
            "secret_token": sign(usn, pass_id, issued_at),
        },
    }


@app.post("/api/pass/verify")
def verify_pass(body: VerifyIn, db: Session = Depends(get_db)):
    now = int(time.time())
    usn, user, pass_id = "UNKNOWN", None, None

    def deny(reason: str):
        log = record(db, usn=usn, user=user, gate=body.gate, granted=False, reason=reason, pass_id=pass_id)
        return verify_response(log, user)

    # ---- QR path
    if body.qr_payload:
        try:
            p = json.loads(body.qr_payload)
            raw_usn, pass_id = str(p["usn"]), str(p["pass_id"])
            ts, token = int(p["timestamp"]), str(p["secret_token"])
        except (ValueError, KeyError, TypeError):
            return deny("Malformed QR code")

        usn = raw_usn.strip().upper()
        user = db.scalar(select(User).where(User.usn == usn))

        if not hmac.compare_digest(sign(raw_usn, pass_id, ts), token):
            return deny("Invalid signature")
        if now - ts > PASS_TTL_SECONDS:
            return deny("Pass expired")
        if ts - now > CLOCK_SKEW_SECONDS:
            return deny("Pass timestamp in the future")
        if not user:
            return deny("Unknown user")
        if user.active_pass_id != pass_id:
            return deny("Pass superseded by a newer one")

    # ---- Manual USN path
    elif body.usn:
        usn = body.usn.strip().upper()
        user = db.scalar(select(User).where(User.usn == usn))
        if not user:
            return deny("USN not registered")
        pass_id = user.active_pass_id
        if not user.active_pass_issued_at or now - user.active_pass_issued_at > PASS_TTL_SECONDS:
            return deny("No active pass (expired)")
    else:
        return deny("Empty scan")

    log = record(db, usn=usn, user=user, gate=body.gate, granted=True, reason="Verified", pass_id=pass_id)
    return verify_response(log, user)


@app.get("/api/logs")
def get_logs(
    q: str = Query("", description="Search by USN or name"),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    stmt = select(GateAccessLog).order_by(GateAccessLog.id.desc()).limit(limit)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(GateAccessLog.usn.ilike(like), GateAccessLog.name.ilike(like)))
    return [serialize_log(l) for l in db.scalars(stmt)]


@app.get("/api/stats/campus-count")
def campus_count(db: Session = Depends(get_db)):
    # People "inside" = users whose most recent granted scan was a check-in.
    latest_per_user = (
        select(func.max(GateAccessLog.id))
        .where(GateAccessLog.status == "GRANTED", GateAccessLog.user_id.isnot(None))
        .group_by(GateAccessLog.user_id)
    )
    inside = db.scalar(
        select(func.count()).select_from(GateAccessLog)
        .where(GateAccessLog.id.in_(latest_per_user), GateAccessLog.direction == "IN")
    )

    today = start_of_today_utc()

    def count(status: str, direction: Optional[str] = None) -> int:
        stmt = select(func.count()).select_from(GateAccessLog).where(
            GateAccessLog.timestamp >= today, GateAccessLog.status == status
        )
        if direction:
            stmt = stmt.where(GateAccessLog.direction == direction)
        return db.scalar(stmt) or 0

    return {
        "inside": inside or 0,
        "check_ins_today": count("GRANTED", "IN"),
        "check_outs_today": count("GRANTED", "OUT"),
        "failed_scans": count("DENIED"),
    }
