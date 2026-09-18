import sqlite3


DB_NAME = "green_riot.db"


with sqlite3.connect(DB_NAME) as db:
    cursor = db.cursor()

    cursor.execute(
        """
        ALTER TABLE plants
        ADD COLUMN space_id INTEGER
        """
    )

    db.commit()

print("🌱 Миграция выполнена успешно.")
print("Добавлено поле space_id в таблицу plants.")