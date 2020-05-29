.PHONY: build

build:
	docker build -t microinfrastructure/service-copy:v0.2 .

push: build
	docker push microinfrastructure/service-copy

run: build
	docker run -it --privileged microinfrastructure/service-copy:v0.2 sh

