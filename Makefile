# BlocklyDuino — build and publish to the FUSE satellite-apps bucket.
#
# build/ IS the app and the source of truth. Only build/index.html is generated
# (from src/base.html + src/category.xml); every other file in build/ is edited
# directly and committed.
#
# blockly/ is retained as upstream reference ONLY. It is not a build input: its
# Closure toolchain is Python 2, needs an unchecked-out submodule and a Google
# API that no longer exists, and the compiled artefacts it would produce are
# already committed under build/js/. Do not wire it back into the build.
#
#   make local          -> dest/local/, asset base LOCAL_ORIGIN/blockly, no publish
#   make dev            -> dist/ with relative assets, served on :PORT (no Laravel)
#   make publish-dev    -> dev.satellite.fusestudio.net/blockly/<version>/  (profile fuse-dev)
#   make publish-prod   -> satellite.fusestudio.net/blockly/<version>/      (profile fuse-prod)
#
# `make local` is how to test inside FUSE before a publish. It needs the
# satellite-local Herd site (fusestudio.net/satellite-local, served at
# LOCAL_ORIGIN) to have a `blockly` symlink into this repo's dest/local, the same
# shape as pixelart and rendley. Laravel's local .env points
# SATELLITE_APPS_LOCAL_PATH at satellite-local, so my.fusestudio.test/blockly
# reads dest/local/index.html through that symlink, and the page's assets load
# from LOCAL_ORIGIN. Compile works there too: the page is same-origin with
# Laravel, exactly as in production.
#
# SatelliteApp caches index.html for 5 minutes, so a change to src/ (the
# toolbox, the Arduino tab markup) shows up after that, or immediately after
#   php artisan cache:forget satellite.blockly.index-html
# Changes to build/js and build/css show on the next reload.

AWS_PROFILE            ?= fuse-dev
SATELLITE_BUCKET_PARAM ?= /laravel/satellite-apps-bucket

# S3 key prefix; matches the public route (/blockly), per the publisher
# conventions in fuse-laravel modules/satellite-cdn/README.md.
APP ?= blockly

# Blockly's assets are unhashed and keep the same filenames every build, so the
# version DIRECTORY is what makes a long cache lifetime safe — and gives instant
# rollback by re-publishing an older index.html.
#
# The version must be unique per publish or immutable caching works against us.
# A commit SHA alone is not enough: publishing twice from a dirty tree would
# reuse the path, and browsers holding a year-long copy would never see the
# second publish. So uncommitted builds get a timestamp as well.
GIT_SHA   := $(shell git rev-parse --short HEAD)
GIT_DIRTY := $(shell git diff --quiet || echo -dirty-$(shell date -u +%Y%m%dT%H%M%SZ))
VERSION   ?= $(GIT_SHA)$(GIT_DIRTY)

# Verified against the deployed gamedesign/index.html, which references
# https://dev.satellite.fusestudio.net/gamedesign/... in the dev bucket.
DEV_CDN  ?= https://dev.satellite.fusestudio.net
PROD_CDN ?= https://satellite.fusestudio.net

# The satellite-local Herd site. Override for another static origin, e.g.
#   LOCAL_ORIGIN=http://localhost:8080 make local
LOCAL_ORIGIN ?= https://satellite.fusestudio.test

PROD_AWS_PROFILE ?= fuse-prod

PORT ?= 8080

.PHONY: help
help:
	@echo "make local          build dest/local/ for the satellite-local Herd site ($(LOCAL_ORIGIN)/$(APP)/)"
	@echo "make dev            build dist/ for local use and serve it on :$(PORT)"
	@echo "make index          regenerate build/index.html from src/"
	@echo "make dist           materialise dist/ (requires ASSET_BASE=...)"
	@echo "make publish-dev    publish to $(DEV_CDN)/$(APP)/$(VERSION)"
	@echo "make publish-prod   publish to $(PROD_CDN)/$(APP)/$(VERSION)"
	@echo "make clean          remove dist/ and dest/"

# build/index.html = src/base.html with src/category.xml injected as the toolbox.
.PHONY: index
index:
	python3 src/build_index.py

.PHONY: dist
dist: index
	@test -n "$(ASSET_BASE)" || { echo "error: ASSET_BASE is required — try 'make dev'"; exit 1; }
	python3 src/build_dist.py "$(ASSET_BASE)"

# Local build for the satellite-local Herd site. Flat layout (no version
# directory) so the symlink target never moves; copied out of dist/ so a later
# publish build does not clobber it, and a stale local build is never mistaken
# for a publish.
.PHONY: local
local:
	$(MAKE) dist ASSET_BASE=$(LOCAL_ORIGIN)/$(APP)
	rm -rf dest/local
	mkdir -p dest/local
	cp -R dist/. dest/local/
	@echo
	@echo "dest/local ready: $(LOCAL_ORIGIN)/$(APP)/ (via the satellite-local Herd site)"

.PHONY: dev
dev:
	$(MAKE) dist ASSET_BASE=.
	@echo
	@echo "Serving dist/ at http://localhost:$(PORT)/ — Ctrl-C to stop."
	@echo "Note: Web Serial needs a secure context; localhost counts as one."
	cd dist && python3 -m http.server $(PORT)

.PHONY: publish-dev
publish-dev:
	$(MAKE) publish CDN=$(DEV_CDN) AWS_PROFILE=$(AWS_PROFILE)

.PHONY: publish-prod
publish-prod:
	$(MAKE) publish CDN=$(PROD_CDN) AWS_PROFILE=$(PROD_AWS_PROFILE)

# Assets go to a versioned, immutable prefix; index.html sits at the app root
# where Laravel reads it, and must never be cached — it is the pointer to the
# current version. Deliberately no --delete: a briefly-stale index.html has to
# keep finding the assets it references.
.PHONY: publish
publish:
	@test -n "$(CDN)" || { echo "error: use publish-dev or publish-prod"; exit 1; }
	$(MAKE) dist ASSET_BASE=$(CDN)/$(APP)/$(VERSION)
	@BUCKET=$$(aws ssm get-parameter \
		--name $(SATELLITE_BUCKET_PARAM) \
		--query Parameter.Value \
		--output text \
		--profile $(AWS_PROFILE)); \
	echo "Publishing $(APP)/$(VERSION) to s3://$$BUCKET (profile: $(AWS_PROFILE))"; \
	aws s3 sync dist/ s3://$$BUCKET/$(APP)/$(VERSION)/ \
		--exclude index.html \
		--cache-control "public, max-age=31536000, immutable" \
		--profile $(AWS_PROFILE); \
	aws s3 cp dist/index.html s3://$$BUCKET/$(APP)/index.html \
		--cache-control "no-cache" \
		--content-type "text/html; charset=utf-8" \
		--profile $(AWS_PROFILE); \
	echo; \
	echo "Published. Laravel reads s3://$$BUCKET/$(APP)/index.html at request time,"; \
	echo "so no Laravel deploy is needed."

.PHONY: clean
clean:
	rm -rf dist dest
