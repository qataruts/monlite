# monlite/postgres — PostgreSQL tuned for the monlite harness.
#
# Everything @monlite/postgres expects, preconfigured so "plug it in and it works":
#   • pgvector (vector / semantic search) installed AND enabled on first init
#   • LISTEN/NOTIFY available out of the box (the changefeed / watch transport)
#   • sensible JSONB-friendly defaults
#
#   docker build -t monlite/postgres:16 docker/postgres
#   docker run -d --name pg -e POSTGRES_PASSWORD=monlite -p 5432:5432 monlite/postgres:16
#   # then: createDb("postgres://postgres:monlite@localhost/postgres") from @monlite/postgres
FROM pgvector/pgvector:pg16

# Enable pgvector (and any future monlite defaults) the first time the data dir is created.
COPY init/ /docker-entrypoint-initdb.d/

LABEL org.opencontainers.image.title="monlite/postgres" \
      org.opencontainers.image.description="PostgreSQL 16 + pgvector, tuned for the monlite harness" \
      org.opencontainers.image.source="https://github.com/qataruts/monlite" \
      org.opencontainers.image.licenses="MIT"
