#!/bin/bash

# 1. Define paths (Update these if your path is different)
PROJECT_DIR="/home/erik/Projects/Javascript/pool-bot"
DB_FILE="$PROJECT_DIR/prisma/dev.db"
BACKUP_FILE="$PROJECT_DIR/pool_backup.sql"

# 2. Navigate to project
cd $PROJECT_DIR

# 3. Create the SQL Dump
# This converts the binary database into text instructions (INSERT INTO...)
# It is transaction-safe and perfect for Git.
sqlite3 $DB_FILE ".dump" > $BACKUP_FILE

# 4. Check if the dump worked (file size > 0)
if [ -s "$BACKUP_FILE" ]; then
    # 5. Git commands
    git add pool_stats.html # Ensure HTML updates are caught too
    git add $BACKUP_FILE
    git commit -m "Nightly Database Backup: $(date +'%Y-%m-%d')"
    git push origin master
    echo "Backup successful: $(date)" >> "$PROJECT_DIR/backup.log"
else
    echo "Backup failed: $(date)" >> "$PROJECT_DIR/backup.log"
fi
