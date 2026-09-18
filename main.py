from fastapi import FastAPI

app = FastAPI(title="Зелёный бунт")


@app.get("/")
def root():
    return {
        "status": "ok",
        "message": "🌱 Зелёный бунт работает!"
    }


@app.get("/health")
def health():
    return {
        "status": "healthy"
    }