.PHONY: up down seed logs test typecheck rebuild

up:
	docker compose up -d --build
	@echo "API      http://localhost:4000/api/v1/health"
	@echo "Swagger  http://localhost:4000/docs"
	@echo "Client   http://localhost:5173"

down:
	docker compose down

# Populates fictional demo data. Run after `make up`.
seed:
	docker compose exec api node dist/seed/seed.js

logs:
	docker compose logs -f api

test:
	cd server && npm test

typecheck:
	cd server && npm run typecheck

rebuild:
	docker compose down -v && docker compose up -d --build
