-- Schema do banco de dados (Cloudflare D1 / SQLite)
-- Equivale ao banco-de-dados/init-mongo.js do repositorio original.

DROP TABLE IF EXISTS todos;

CREATE TABLE todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  completed  INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_todos_completed ON todos (completed);

-- Seed identico ao do projeto original
INSERT INTO todos (text, completed) VALUES
  ('Laercio e um excelente professor', 0),
  ('Estudar Cloud', 1),
  ('Fazer exercicios da UA', 0);
