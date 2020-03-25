#!/bin/bash
cat network.json | base64 | tr -d '\n'
