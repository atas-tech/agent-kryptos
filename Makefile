SHELL := /bin/bash

.PHONY: up down logs migrate build test dev-sps dev-dashboard dev-browser

up:
	docker compose -f docker-compose.test.yml up -d

down:
	docker compose -f docker-compose.test.yml down --remove-orphans

logs:
	docker compose -f docker-compose.test.yml logs -f redis postgres

migrate:
	npm run db:migrate --workspace=packages/sps-server

build:
	npm run build

test:
	npm test

dev-sps:
	npm run dev --workspace=packages/sps-server

dev-dashboard:
	npm run dev --workspace=packages/dashboard

dev-browser:
	npm run dev --workspace=packages/browser-ui
