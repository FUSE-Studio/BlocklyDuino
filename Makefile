AWS_PROFILE ?= terraform-dev

.PHONY: fuse

fuse:
	# Resolve S3 bucket from SSM and sync
	@BUCKET=$$(aws ssm get-parameter \
		--name /laravel/satellite-apps-bucket \
		--query Parameter.Value \
		--output text \
		--profile $(AWS_PROFILE)); \
	echo "Syncing to s3://$$BUCKET/blocklyduino/ (profile: $(AWS_PROFILE))..."; \
	aws s3 sync build/ s3://$$BUCKET/blocklyduino/ --delete --profile $(AWS_PROFILE)
