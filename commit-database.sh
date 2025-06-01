#!/bin/bash

# --- Configuration ---
# !!! IMPORTANT: SET THESE VARIABLES !!!
GIT_REPO_PATH="/home/erikivarsson/Projects/JavaScript/pool-bot"  # Absolute path to your local Git repository
MAIN_DB_FILE="poolEloDatabase.json"                             # Main DB file, relative to repository root

# Dynamically determine the seasonal database file name
CURRENT_YEAR=$(date +'%Y')
CURRENT_MONTH=$(date +'%m') # %m gives month as 01-12
SEASONAL_DB_FILE="poolEloDatabase_${CURRENT_YEAR}_${CURRENT_MONTH}.json" # Seasonal DB file, relative to repo root

COMMIT_MESSAGE_PREFIX="Automated commit: "
REMOTE_NAME="origin" # Or your preferred remote name
BRANCH_NAME="master"   # Or your preferred branch name

# --- Script Logic ---

# Navigate to the Git repository directory
cd "$GIT_REPO_PATH" || { echo "Error: Could not navigate to Git repository path: $GIT_REPO_PATH"; exit 1; }

# Add main DB file to staging if it exists
if [ -f "$MAIN_DB_FILE" ]; then
  git add "$MAIN_DB_FILE"
else
  echo "Warning: Main database file not found: $GIT_REPO_PATH/$MAIN_DB_FILE"
fi

# Add seasonal DB file to staging if it exists
# It's normal for this file to not exist if the bot hasn't created it for the current month yet
if [ -f "$SEASONAL_DB_FILE" ]; then
  git add "$SEASONAL_DB_FILE"
else
  echo "Info: Seasonal database file for ${CURRENT_YEAR}-${CURRENT_MONTH} not found: $GIT_REPO_PATH/$SEASONAL_DB_FILE. This may be normal."
fi

# Determine which files have actual staged changes
staged_changed_files=()

if [ -f "$MAIN_DB_FILE" ]; then
    # Check if the main file has staged changes (different from HEAD)
    if ! git diff --staged --quiet -- "$MAIN_DB_FILE"; then
        staged_changed_files+=("$(basename "$MAIN_DB_FILE")")
    fi
fi

if [ -f "$SEASONAL_DB_FILE" ]; then
    # Check if the seasonal file has staged changes (different from HEAD)
    if ! git diff --staged --quiet -- "$SEASONAL_DB_FILE"; then
        # Ensure not to add duplicate if names were somehow same (not the case here)
        is_already_listed=false
        for item in "${staged_changed_files[@]}"; do
            if [[ "$item" == "$(basename "$SEASONAL_DB_FILE")" ]]; then
                is_already_listed=true
                break
            fi
        done
        if ! $is_already_listed; then
            staged_changed_files+=("$(basename "$SEASONAL_DB_FILE")")
        fi
    fi
fi

# If any of the targeted files have staged changes
if [ ${#staged_changed_files[@]} -gt 0 ]; then
  # Construct the commit message
  changed_files_string=$(IFS=, ; echo "${staged_changed_files[*]}") # Join array with comma
  FINAL_COMMIT_MESSAGE="${COMMIT_MESSAGE_PREFIX}Updated database file(s): ${changed_files_string}"

  # Commit the changes
  git commit -m "$FINAL_COMMIT_MESSAGE"
  
  # Check if commit was successful
  if [ $? -ne 0 ]; then
      echo "Error: Git commit failed."
      # Optional: You might want to attempt to unstage files or handle this error
      # git reset HEAD "$MAIN_DB_FILE" "$SEASONAL_DB_FILE" > /dev/null 2>&1
      exit 1
  fi

  # Push the changes to the remote repository
  git push "$REMOTE_NAME" "$BRANCH_NAME"

  # Check if push was successful
  if [ $? -ne 0 ]; then
      echo "Error: Git push failed."
      # Optional: Handle push failure (e.g., notify, try again later, revert local commit)
      # git reset --soft HEAD~1 # Example: Revert local commit if push fails
      exit 1
  fi

  echo "Successfully committed and pushed changes to: ${changed_files_string} at $(date)"
else
  echo "No changes to commit for database files ($MAIN_DB_FILE, $SEASONAL_DB_FILE) at $(date)"
fi

exit 0
