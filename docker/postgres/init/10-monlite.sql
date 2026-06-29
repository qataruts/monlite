-- monlite/postgres first-init: enable the extensions the harness uses.
-- Runs once, when the data directory is first created, on the default database.

-- Vector / semantic search for @monlite/postgres (pgvector is preinstalled in the base image).
CREATE EXTENSION IF NOT EXISTS vector;
