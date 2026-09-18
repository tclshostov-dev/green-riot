from fastapi import FastAPI

from app.core.database import Base, engine
from app.models.user import User
from app.models.space import Space
from app.models.plant import Plant
from app.api.plants import router as plants_router


Base.metadata.create_all(bind=engine)


app = FastAPI(
    title="Зелёный бунт",
    description="Персональный AI-садовник",
    version="0.1.0",
)


app.include_router(plants_router)


@app.get("/")
def root():
    return {
        "status": "ok",
        "message": "🌱 Зелёный бунт работает!",
        "version": "0.1.0",
    }


@app.get("/health")
def health():
    return {
        "status": "healthy",
    }