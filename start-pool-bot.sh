#!/bin/bash

# Pool Bot Startup Script
# Save this as start-pool-bot.sh in the same directory as your bot

sleep 30

# Define log file
LOG_FILE="pool-bot.log"

# Add common Node.js installation paths to PATH
export PATH="$PATH:/usr/bin:/usr/local/bin:/home/$(whoami)/.nvm/versions/node/$(ls /home/$(whoami)/.nvm/versions/node/ 2>/dev/null | sort -V | tail -n 1)/bin"

# Log the current PATH for debugging
echo "Current PATH: $PATH" >> $LOG_FILE

# Navigate to the bot directory
cd /home/erikivarsson/Projects/Javascript/pool-bot

# Make sure the log exists
touch $LOG_FILE

# Print startup timestamp
echo "=== Starting Pool Bot $(date) ===" >> $LOG_FILE

# Check if node is installed and log its location
NODE_PATH=$(which node 2>/dev/null)
if [ -z "$NODE_PATH" ]; then
    echo "Node.js is not found in PATH. Checking common locations..." >> $LOG_FILE
    
    # Check common locations for node
    for location in /usr/bin/node /usr/local/bin/node /home/$(whoami)/.nvm/versions/node/*/bin/node; do
        if [ -x "$location" ]; then
            echo "Found Node.js at: $location" >> $LOG_FILE
            NODE_PATH=$location
            break
        fi
    done
    
    if [ -z "$NODE_PATH" ]; then
        echo "Node.js not found. Please install it or specify the full path." >> $LOG_FILE
        exit 1
    fi
else
    echo "Node.js found at: $NODE_PATH ($(node -v))" >> $LOG_FILE
fi

# Check if the bot file exists
if [ ! -f "discord-elo-bot.js" ]; then
    echo "Bot file not found: discord-elo-bot.js" >> $LOG_FILE
    exit 1
fi

# Check if the .env file exists
if [ ! -f ".env" ]; then
    echo "Warning: .env file not found. Make sure your bot token is set properly." >> $LOG_FILE
fi

# Check for required npm packages
if [ ! -d "node_modules/discord.js" ] || [ ! -d "node_modules/dotenv" ] || [ ! -d "node_modules/node-json-db" ]; then
    echo "Installing required packages..." >> $LOG_FILE
    
    # Try to find npm
    NPM_PATH=$(which npm 2>/dev/null)
    if [ -z "$NPM_PATH" ]; then
        NPM_PATH=$(dirname $NODE_PATH)/npm
        if [ ! -x "$NPM_PATH" ]; then
            echo "npm not found. Using node to install packages." >> $LOG_FILE
            $NODE_PATH -e "require('child_process').execSync('npm install discord.js dotenv node-json-db', {stdio: 'inherit'})"
        else
            echo "npm found at: $NPM_PATH" >> $LOG_FILE
            $NPM_PATH install discord.js dotenv node-json-db >> $LOG_FILE 2>&1
        fi
    else
        echo "npm found at: $NPM_PATH" >> $LOG_FILE
        npm install discord.js dotenv node-json-db >> $LOG_FILE 2>&1
    fi
fi

# Kill any existing bot processes
pkill -f "node discord-elo-bot.js" >> $LOG_FILE 2>&1

# Start the bot in the background using the full path to node
echo "Starting bot with $NODE_PATH..." >> $LOG_FILE
nohup $NODE_PATH discord-elo-bot.js >> $LOG_FILE 2>&1 &

# Check if the bot started successfully
sleep 3
if pgrep -f "node discord-elo-bot.js" > /dev/null; then
    echo "Pool Bot started successfully with PID: $(pgrep -f "node discord-elo-bot.js")" >> $LOG_FILE
    echo "Pool Bot started successfully"
else
    echo "Failed to start Pool Bot. Check the log file: $LOG_FILE" >> $LOG_FILE
    echo "Failed to start Pool Bot. Check the log file: $LOG_FILE"
    exit 1
fi
