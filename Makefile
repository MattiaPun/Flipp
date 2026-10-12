# Day-to-day commands. `make dev` needs no Docker build: Node restarts on every save.
.PHONY: dev docker-dev test e2e seed reset up down logs

NODE_IMAGE := node:24-alpine
UID_GID    := $(shell id -u):$(shell id -g)

# Local Node (>= 22.13), auto-restart on change, data in ./data.
dev: node_modules
	npm run dev

# Same, inside the production Node image with the source mounted: no image build, no local Node needed.
# node_modules lives in a named volume so it is installed for the container's platform, once.
docker-dev:
	docker run --rm -v flipp-node-modules:/m alpine chown $(UID_GID) /m
	docker run --rm -it --init --user $(UID_GID) -p 3000:3000 -e HOME=/tmp \
		-v "$(CURDIR)":/app -v flipp-node-modules:/app/node_modules -w /app $(NODE_IMAGE) \
		sh -c 'npm ci --ignore-scripts --no-audit --no-fund && exec npm run dev'

node_modules: package-lock.json
	npm ci
	@touch node_modules

test: node_modules
	npm test

e2e: node_modules
	npm run test:e2e

seed: node_modules
	npm run seed -- --reset

# Wipes the local dev data folder (database, uploads, backups).
reset:
	rm -rf ./data

# Production-like: builds the image (runs the unit tests in the build) and starts it detached.
up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f flipp
