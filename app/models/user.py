from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.plant import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)

    telegram_id: Mapped[str | None] = mapped_column(
        String(100),
        unique=True,
        nullable=True,
    )

    name: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
    )

    spaces: Mapped[list["Space"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )