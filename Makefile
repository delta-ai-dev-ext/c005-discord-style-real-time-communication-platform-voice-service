SERVICE_NAME ?= voice_service

.PHONY: dev test typecheck build run lint

dev:
	bun --watch src/index.ts

test:
	bun test --coverage

typecheck:
	bun x tsc --noEmit

build:
	docker build -t $(SERVICE_NAME):latest .

run:
	bun run src/index.ts

lint:
	bun x eslint src/ tests/
