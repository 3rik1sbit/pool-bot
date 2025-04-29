# Discord Pool ELO Bot - Setup Guide

This Discord bot tracks ELO ratings for your office pool games, allowing friendly competition among coworkers.

## Features

- Player registration system
- Match recording with automatic ELO calculation
- Leaderboard/rankings display
- Individual player statistics
- Simple command-based interface

## Setup Instructions

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (v16.9.0 or higher)
- A Discord account
- Permission to add bots to your Discord server

### 2. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name like "Office Pool ELO"
3. Go to the "Bot" tab and click "Add Bot"
4. Under "Privileged Gateway Intents", enable:
   - Message Content Intent
   - Server Members Intent
5. Save changes
6. Click "Reset Token" and copy your bot token (keep this secure!)

### 3. Invite the Bot to Your Server

1. Go to the "OAuth2" > "URL Generator" tab
2. Select the "bot" scope
3. Select the following permissions:
   - Read Messages/View Channels
   - Send Messages
   - Embed Links
   - Read Message History
4. Copy the generated URL and open it in a browser
5. Select your Discord server and authorize the bot

### 4. Install and Configure

1. Download the bot code from the provided file
2. Create a project folder and place the code in a file named `index.js`
3. Open a terminal/command prompt in that folder
4. Run these commands:

```bash
npm init -y
npm install discord.js dotenv node-json-db
```

5. Create a `.env` file in the same folder with the following content:

```
TOKEN=your_bot_token_here
```

Replace `your_bot_token_here` with the token you copied earlier.

### 5. Start the Bot

1. In the terminal, run:

```bash
node index.js
```

2. You should see "Logged in as [Bot Name]" if everything is working

3. To keep the bot running permanently, consider using a service like:
   - [PM2](https://pm2.keymetrics.io/) for your own server
   - [Heroku](https://www.heroku.com/) for cloud hosting
   - [Replit](https://replit.com/) for a simple free option

## Using the Bot

All commands start with `!pool`:

- `!pool register YourName` - Register yourself as a player
- `!pool match @opponent` - Record that you won a match against the mentioned player
- `!pool rankings` - Show the current player rankings
- `!pool stats` - Show your stats (or use `!pool stats @player` for another player)
- `!pool help` - Show the help message with all commands

## Customization

You can modify these values in the code to change the ELO behavior:

- `DEFAULT_ELO` (currently 1000) - Starting ELO for new players
- `K_FACTOR` (currently 32) - How quickly ratings change (higher = faster changes)

## Troubleshooting

- If the bot doesn't respond, check that it has proper permissions in the Discord server
- Make sure your `.env` file contains the correct token
- Check that Node.js is properly installed and up to date
- Verify that all required packages are installed

## Support

If you need help or want to suggest improvements, please reach out to the bot creator.

Happy playing!
