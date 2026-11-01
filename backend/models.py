"""Database layer for Smart Gate Keeper (SQLAlchemy 2.x + SQLite)."""
import os
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, create_engine
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
    sessionmaker,
)

DATABASE_URL = os.getenv("SGK_DATABASE_URL", "sqlite:///./gatekeeper.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def utcnow() -> datetime:
    """Naive UTC datetime (stored as UTC, serialised with a trailing 'Z')."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class User(Base):
    """A student or visitor. One row per USN; the latest issued pass is tracked here."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    usn: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    department: Mapped[str] = mapped_column(String(80), default="General")
    pass_type: Mapped[str] = mapped_column(String(32))  # "Student Daily" | "Visitor Pre-Approved"

    # Only the most recent pass is valid; generating a new one supersedes the old QR.
    active_pass_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    active_pass_issued_at: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # epoch seconds

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    logs: Mapped[list["GateAccessLog"]] = relationship(back_populates="user")


class GateAccessLog(Base):
    """Every scan attempt at a gate, granted or denied."""

    __tablename__ = "gate_access_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    usn: Mapped[str] = mapped_column(String(32), index=True)  # "UNKNOWN" for unreadable QR codes
    name: Mapped[str] = mapped_column(String(120), default="Unknown")
    pass_type: Mapped[str] = mapped_column(String(32), default="-")
    pass_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    direction: Mapped[str] = mapped_column(String(3), default="—")  # "IN" | "OUT" | "—" (denied)
    status: Mapped[str] = mapped_column(String(8), index=True)  # "GRANTED" | "DENIED"
    reason: Mapped[str] = mapped_column(String(120), default="")
    gate: Mapped[int] = mapped_column(Integer, default=1)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    user: Mapped[Optional[User]] = relationship(back_populates="logs")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
