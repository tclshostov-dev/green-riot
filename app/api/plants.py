from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from app.core.database import SessionLocal
from app.models.plant import Plant


router = APIRouter(prefix="/plants", tags=["plants"])


class PlantCreate(BaseModel):
    name: str
    species: str | None = None
    location: str | None = None
    notes: str | None = None


@router.post("")
def create_plant(plant_data: PlantCreate):
    with SessionLocal() as db:
        plant = Plant(
            name=plant_data.name,
            species=plant_data.species,
            location=plant_data.location,
            notes=plant_data.notes,
        )

        db.add(plant)
        db.commit()
        db.refresh(plant)

        return {
            "id": plant.id,
            "name": plant.name,
            "species": plant.species,
            "location": plant.location,
            "notes": plant.notes,
        }


@router.get("")
def get_plants():
    with SessionLocal() as db:
        plants = db.scalars(select(Plant)).all()

        return [
            {
                "id": plant.id,
                "name": plant.name,
                "species": plant.species,
                "location": plant.location,
                "notes": plant.notes,
            }
            for plant in plants
        ]