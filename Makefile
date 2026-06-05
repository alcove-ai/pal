.PHONY: release

release:
	@VERSION=$$(node -e "console.log(require('./packages/opencode/package.json').version)") && \
	echo "Releasing v$$VERSION" && \
	git tag "v$$VERSION" && \
	git push github "v$$VERSION" && \
	echo "Tagged and pushed v$$VERSION — CI will build and publish."
