from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.models import Base


DATABASE_URL = "sqlite:///./green_riot.db"


engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)