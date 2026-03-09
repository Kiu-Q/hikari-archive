#!/bin/bash

# Installation script for Hikari VRM Viewer
# This script creates local cache directories to avoid permission issues

echo "Creating local cache directories..."
mkdir -p .electron-cache .npm-cache

echo "Installing dependencies with custom cache locations..."
ELECTRON_CACHE=$(pwd)/.electron-cache npm install --cache .npm-cache

echo "Installation complete!"
echo "Note: Cache directories (.electron-cache, .npm-cache) are git-ignored"