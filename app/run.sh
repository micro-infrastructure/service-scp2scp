#!/bin/bash
node app.js --redis 172.17.0.2 -p 4301 --infraPath ./infra.json --netPath ./network.json --dev
