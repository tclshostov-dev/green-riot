from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.plant import Base


class Space(Base):
    __tablename__ = "spaces"

    id: Mapped[int] = mapped_column(primary_key=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"),
        nullable=False,
    )

    name: Mapped[str] = mapped_column(
        String(100)
    )

    space_type: Mapped[str] = mapped_column(
        String(50)
    )

    user: Mapped["User"] = relationship(
        back_populates="spaces"
    )

    plants: Mapped[list["Plant"]] = relationship(
        back_populates="space",
        cascade="all, delete-orphan",
    )