#!/bin/bash

# auto-commit-push.sh - A script to automate git commit and push operations
# Usage: ./scripts/auto-commit-push.sh "Your commit message here"

# Set script to exit on error
set -e

echo "======== Git Auto Commit & Push ========"

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "Error: git is not installed"
    exit 1
fi

# Check if the current directory is a git repository
if [ ! -d ".git" ]; then
    echo "Error: Not a git repository"
    exit 1
fi

# Check if there are any changes to commit
if [ -z "$(git status --porcelain)" ]; then
    echo "No changes to commit. Working tree clean."
    exit 0
fi

# Get commit message from argument or prompt for it
COMMIT_MESSAGE="$1"
if [ -z "$COMMIT_MESSAGE" ]; then
    echo "Enter commit message:"
    read -r COMMIT_MESSAGE
    if [ -z "$COMMIT_MESSAGE" ]; then
        COMMIT_MESSAGE="Update $(date +"%Y-%m-%d %H:%M:%S")"
        echo "Using default commit message: $COMMIT_MESSAGE"
    fi
fi

# Add all changes
echo "Adding all changes..."
git add .

# Create initial commit if needed
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "Creating initial commit..."
    git commit -m "Initial commit"
fi

# Commit changes
echo "Committing changes with message: $COMMIT_MESSAGE"
git commit -m "$COMMIT_MESSAGE"

# Switch to main branch
echo "Switching to main branch..."
git branch -M main

# Configure remote if not already set
if ! git config remote.origin.url > /dev/null; then
    echo "Setting up remote repository..."
    git remote add origin https://github.com/Hansade2005/devforge.git
elif [ "$(git config remote.origin.url)" != "https://github.com/Hansade2005/devforge.git" ]; then
    echo "Updating remote repository URL..."
    git remote set-url origin https://github.com/Hansade2005/devforge.git
fi

# Push to remote
echo "Pushing to remote origin..."
if git push -u origin main; then
    echo "Push successful!"
else
    echo "Push failed. You may need to:"
    echo "1. Ensure you have write access to the repository"
    echo "2. Configure your Git credentials"
    echo "3. Use GitHub CLI: gh auth login"
    echo "4. Or manually push using: git push -u origin main"
    exit 1
fi

echo "======== Done ========"
