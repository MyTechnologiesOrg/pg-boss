.PHONY: db-up db-down test test-run ci clean install

ifeq (test-run,$(firstword $(MAKECMDGOALS)))
  RUN_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  $(eval $(RUN_ARGS):;@:)
endif

install:
	npm install --prefer-offline --no-audit

db-up:
	docker compose up -d
	@echo "Waiting for PostgreSQL to be ready..."
	@until docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do sleep 1; done
	@echo "PostgreSQL is ready"

db-down:
	docker compose down

test: install db-up
	npm test -- --exit
	$(MAKE) db-down

test-run: install db-up
	npx mocha --exit $(RUN_ARGS)
	$(MAKE) db-down

ci: install db-up
	npm run cover -- --exit
	$(MAKE) db-down

clean:
	docker compose down -v
