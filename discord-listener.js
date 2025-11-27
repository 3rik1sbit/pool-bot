// Discord Pool ELO Bot - Listener Service
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const express = require('express');
const dns = require('dns').promises;

// --- CONFIGURATION ---
const LOGIC_SERVICE_URL = 'http://localhost:3005';
const NOTIFICATION_SERVER_PORT = 3006;
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID;

// --- Discord Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// --- Helper Functions ---
function formatError(error) {
    if (error.response && error.response.data && error.response.data.error) {
        return error.response.data.error;
    }
    return error.message;
}

// --- Discord Command Handlers ---

async function handleRegister(message, args) {
    if (args.length < 1) return message.reply('Please provide a name. Usage: `!pool register YourName`');
    const playerName = args.join(' ');
    const playerId = message.author.id;
    try {
        const response = await axios.post(`${LOGIC_SERVICE_URL}/register`, { playerId, playerName });
        message.channel.send(response.data.message);
        if (response.data.seasonalMessage) {
            message.channel.send(response.data.seasonalMessage);
        }
    } catch (error) {
        message.reply(`Registration failed: ${formatError(error)}`);
    }
}

async function handleRecordMatch(message, args) {
    const winnerId = message.author.id;
    const mention = message.mentions.users.first();
    if (!mention) return message.reply('Please mention the player you defeated. Usage: `!pool match @opponent`');
    const loserId = mention.id;

    try {
        const response = await axios.post(`${LOGIC_SERVICE_URL}/match`, { winnerId, loserId, source: 'discord' }); // <-- Added source
        const { seasonalResult, allTimeResult, timestamp } = response.data;
        const embed = new EmbedBuilder()
            .setTitle('Match Result Recorded (Seasonal)')
            .setColor('#00FF00')
            .addFields(
                { name: 'Winner', value: `${seasonalResult.winner.name} (Season ELO: ${seasonalResult.winner.elo}, +${seasonalResult.elo.winnerGain})`, inline: false },
                { name: 'Loser', value: `${seasonalResult.loser.name} (Season ELO: ${seasonalResult.loser.elo}, -${seasonalResult.elo.loserLoss})`, inline: false },
                { name: 'All-Time ELOs', value: `${allTimeResult.winner.name}: ${allTimeResult.winner.elo} | ${allTimeResult.loser.name}: ${allTimeResult.loser.elo}`, inline: false }
            )
            .setFooter({ text: 'Office Pool ELO System' });
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`break_${winnerId}_${loserId}_${timestamp}_winner`).setLabel(seasonalResult.winner.name).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`break_${winnerId}_${loserId}_${timestamp}_loser`).setLabel(seasonalResult.loser.name).setStyle(ButtonStyle.Secondary)
        );

        message.reply({ embeds: [embed], components: [row], content: '**Breaker:** Select who made the break shot for this match.' });

    } catch (error) {
        message.reply(`Failed to record match: ${formatError(error)}`);
    }
}

async function handleAdminMatch(message, args) {
     if (message.mentions.users.size !== 2) {
        return message.reply('Please mention exactly two players. Usage: `!pool adminmatch @winner @loser`');
    }
    const mentionRegex = /<@!?(\d+)>/g;
    const matches = [...message.content.matchAll(mentionRegex)];
    const orderedMentionIds = matches.map(match => match[1]);
    const winnerId = orderedMentionIds[0];
    const loserId = orderedMentionIds[1];

    try {
        const response = await axios.post(`${LOGIC_SERVICE_URL}/match`, { winnerId, loserId, source: 'discord' }); // <-- Added source
        const { seasonalResult, allTimeResult, timestamp } = response.data;
        
        const embed = new EmbedBuilder()
            .setTitle('Match Result Recorded (Admin)')
            .setColor('#00FF00')
            .setDescription(`${message.author.username} recorded a match.`)
            .addFields(
                { name: 'Winner', value: `${seasonalResult.winner.name} (Season ELO: ${seasonalResult.winner.elo}, +${seasonalResult.elo.winnerGain})`, inline: false },
                { name: 'Loser', value: `${seasonalResult.loser.name} (Season ELO: ${seasonalResult.loser.elo}, -${seasonalResult.elo.loserLoss})`, inline: false },
                { name: 'All-Time ELOs', value: `${allTimeResult.winner.name}: ${allTimeResult.winner.elo} | ${allTimeResult.loser.name}: ${allTimeResult.loser.elo}`, inline: false }
            )
            .setFooter({ text: 'Office Pool ELO System' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`break_${winnerId}_${loserId}_${timestamp}_winner`).setLabel(seasonalResult.winner.name).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`break_${winnerId}_${loserId}_${timestamp}_loser`).setLabel(seasonalResult.loser.name).setStyle(ButtonStyle.Secondary)
        );

        message.reply({ embeds: [embed], components: [row], content: '**Breaker:** Select who made the break shot for this match.' });

    } catch (error) {
        message.reply(`Failed to record admin match: ${formatError(error)}`);
    }
}

async function handleUndo(message) {
    try {
        const response = await axios.post(`${LOGIC_SERVICE_URL}/undo`);
        const { seasonal, allTime } = response.data;
        const embed = new EmbedBuilder()
            .setTitle('Match Reverted (Season & All-Time)')
            .setColor('#FF3300')
            .setDescription(`The last match has been reverted.`)
            .addFields(
                { name: 'Reverted Match', value: `${seasonal.winnerName} vs ${seasonal.loserName}`, inline: false },
                { name: `${seasonal.winnerName} (Season)`, value: `${seasonal.winnerOldElo} → ${seasonal.winnerNewElo} (-${seasonal.eloGain} ELO)`, inline: true },
                { name: `${seasonal.loserName} (Season)`, value: `${seasonal.loserOldElo} → ${seasonal.loserNewElo} (+${seasonal.eloLoss} ELO)`, inline: true },
                { name: `${allTime.winnerName} (All-Time ELO)`, value: `${allTime.winnerOldElo} → ${allTime.winnerNewElo}`, inline: true},
                { name: `${allTime.loserName} (All-Time ELO)`, value: `${allTime.loserOldElo} → ${allTime.loserNewElo}`, inline: true}
            )
            .setFooter({ text: 'Office Pool ELO System' });
        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to undo match: ${formatError(error)}`);
    }
}


async function handleRankings(message, allTime = false) {
    try {
        // 1. Fetch the list of all available boards
        const boardsResponse = await axios.get(`${LOGIC_SERVICE_URL}/leaderboards`);
        const boards = boardsResponse.data;

        // 2. Determine which board to show
        let targetBoard;
        if (allTime) {
            targetBoard = boards.find(b => b.isLegacy);
        } else {
            // The API sorts by: Legacy First, then Newest Seasons.
            // So the first board that ISN'T legacy is the current season.
            targetBoard = boards.find(b => !b.isLegacy);
        }

        if (!targetBoard) {
            return message.reply(allTime ? "No all-time leaderboard found." : "No active season found.");
        }

        // 3. Fetch the data for that specific board
        const dataResponse = await axios.get(`${LOGIC_SERVICE_URL}/leaderboard/${targetBoard.id}`);
        const { players } = dataResponse.data; // This returns a Map (Object), not an array

        // 4. Convert Object to Array, Filter, and Sort
        const rankedPlayers = Object.values(players)
            .filter(p => (p.wins + p.losses) > 0)
            .sort((a, b) => b.elo - a.elo);

        // 5. Build the Embed
        const title = `Office Pool Rankings (${targetBoard.name})`;
        const color = allTime ? '#DAA520' : '#0099FF';

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(color)
            .setFooter({ text: 'Office Pool ELO System' });
        
        if (rankedPlayers.length === 0) {
            embed.setDescription('No players have played any games yet.');
        } else {
            rankedPlayers.slice(0, 10).forEach((player, index) => {
                embed.addFields({ 
                    name: `#${index + 1} ${player.name}`, 
                    value: `ELO: ${player.elo} | W: ${player.wins} | L: ${player.losses}`, 
                    inline: false 
                });
            });
        }
        message.reply({ embeds: [embed] });

    } catch (error) {
        console.error(error);
        message.reply(`Failed to get rankings: ${formatError(error)}`);
    }
}

async function handleShowStats(message, args) {
    const playerId = message.mentions.users.size > 0 ? message.mentions.users.first().id : message.author.id;
    try {
        const response = await axios.get(`${LOGIC_SERVICE_URL}/stats/player/${playerId}`);
        const { seasonPlayer, allTimePlayer } = response.data;

        const embed = new EmbedBuilder()
            .setTitle(`${seasonPlayer.name}'s Stats (Current Season)`)
            .setColor('#0099FF')
            .addFields(
                { name: 'Season ELO', value: `${seasonPlayer.elo}`, inline: true },
                { name: 'Season Wins', value: `${seasonPlayer.wins}`, inline: true },
                { name: 'Season Losses', value: `${seasonPlayer.losses}`, inline: true },
                { name: 'Season Win Rate', value: `${seasonPlayer.winRate}%`, inline: true },
                { name: 'All-Time ELO', value: `${allTimePlayer.elo}`, inline: true }
            )
            .setFooter({ text: 'Office Pool ELO System' });

        if (seasonPlayer.recentMatchesText) {
            embed.addFields({ name: 'Recent Seasonal Matches', value: seasonPlayer.recentMatchesText, inline: false });
        }
        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to get stats: ${formatError(error)}`);
    }
}

async function handleMyStats(message) {
    const playerId = message.author.id;
    try {
        const response = await axios.get(`${LOGIC_SERVICE_URL}/stats/mystats/${playerId}`);
        const { player, overallWinPercentage, opponentStatsDescription } = response.data;

        const embed = new EmbedBuilder()
            .setTitle(`Your All-Time Stats: ${player.name}`)
            .setColor('#1E90FF')
            .addFields(
                { name: 'Overall Win/Loss', value: `${player.wins}W / ${player.losses}L`, inline: true },
                { name: 'Overall Win Rate', value: `${overallWinPercentage}%`, inline: true },
                { name: '\u200B', value: '\u200B', inline: false },
                { name: 'Head-to-Head Records', value: opponentStatsDescription, inline: false }
            )
            .setFooter({ text: 'Office Pool ELO System - All-Time Personal Stats' });
        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to get detailed stats: ${formatError(error)}`);
    }
}

async function handleBreakerStats(message) {
    const args = message.content.split(/ +/);
    const isSeasonal = args.includes('season'); // Check if user typed "!pool breakerstats season"

    try {
        let url = `${LOGIC_SERVICE_URL}/stats/breaker`;
        let titleType = "All-Time";

        if (isSeasonal) {
            // 1. Fetch list to find current season ID
            const boardsRes = await axios.get(`${LOGIC_SERVICE_URL}/leaderboards`);
            const boards = boardsRes.data;
            // Find newest non-legacy board
            const seasonBoard = boards.find(b => !b.isLegacy && b.name.startsWith("Pool 20"));
            
            if (seasonBoard) {
                url += `?boardId=${seasonBoard.id}`;
                titleType = seasonBoard.name;
            } else {
                return message.reply("No active season found.");
            }
        }

        const response = await axios.get(url);
        const { totalMatchesWithBreakerInfo, breakerWins, overallBreakerWinPercentage, playerBreakStatsText } = response.data;

        const embed = new EmbedBuilder()
            .setTitle(`Breaker Statistics (${titleType})`)
            .setColor('#8A2BE2')
            .addFields(
                { name: 'Matches Analyzed', value: `${totalMatchesWithBreakerInfo}`, inline: false },
                { name: 'Overall Times Breaker Won', value: `${breakerWins}`, inline: false },
                { name: 'Overall Breaker Win %', value: `${overallBreakerWinPercentage}%`, inline: false },
                { name: 'Player Break Frequencies', value: playerBreakStatsText || "No stats available.", inline: false }
            )
            .setFooter({ text: 'Office Pool ELO System' });
        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to get breaker stats: ${formatError(error)}`);
    }
}

async function handleGenerateTournament(message, args) {
    const mentionedIds = message.mentions.users.map(user => user.id);
    try {
        const response = await axios.post(`${LOGIC_SERVICE_URL}/tournament`, { playerIds: mentionedIds });
        const { tournamentName, initialPlayerCount, bracketSize, byeCount, round1Matches, subsequentRoundsText } = response.data;

        const embed = new EmbedBuilder()
            .setTitle(`🏆 ${tournamentName} (Seasonal) 🏆`)
            .setColor('#FF9900')
            .setDescription(`Tournament with ${initialPlayerCount} players (seasonal ELOs).\nBracket Size: ${bracketSize}. ${byeCount > 0 ? `(${byeCount} byes)` : ''}`)
            .setFooter({ text: 'Office Pool Tournament | Göteborg Edition - Seasonal' });

        embed.addFields({ name: '--- Round 1 (Seasonal ELOs) ---', value: '\u200B' });
        round1Matches.forEach((matchText) => {
             embed.addFields({ name: matchText.name, value: matchText.value, inline: false });
        });

        if (subsequentRoundsText) {
            embed.addFields({ name: 'Subsequent Rounds & Breaks', value: subsequentRoundsText, inline: false });
        }
        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to generate tournament: ${formatError(error)}`);
    }
}

async function handleHelp(message) {
    const embed = new EmbedBuilder()
        .setTitle('Office Pool ELO Bot Commands')
        .setColor('#0099FF')
        .setDescription('Here are the available commands:')
        .addFields(
            { name: '!pool register [name]', value: 'Register yourself as a player', inline: false },
            { name: '!pool match @opponent', value: 'Record that you won a match', inline: false },
            { name: '!pool adminmatch @winner @loser', value: 'Record a match between two other players', inline: false },
            { name: '!pool undo', value: 'Revert the last recorded match', inline: false },
            { name: '!pool rankings', value: 'Show current seasonal player rankings', inline: false },
            { name: '!pool alltimerankings', value: 'Show all-time player rankings', inline: false },
            { name: '!pool stats [@player]', value: 'Show your/mentioned player\'s stats', inline: false },
            { name: '!pool mystats', value: 'Shows your detailed all-time statistics', inline: false },
            { name: '!pool tournament [@player1...]', value: 'Generate a tournament bracket', inline: false },
            { name: '!pool breakerstats', value: 'Show statistics on how often the breaker wins', inline: false },
            { name: '!pool help', value: 'Show this help message', inline: false }
        )
        .setFooter({ text: 'Office Pool ELO System' });
    message.reply({ embeds: [embed] });
}

// --- Discord Event Handlers ---
client.once('ready', () => {
    console.log(`Discord Listener logged in as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith('!pool')) return;
    const args = message.content.slice(5).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    switch (command) {
        case 'register': await handleRegister(message, args); break;
        case 'match': await handleRecordMatch(message, args); break;
        case 'adminmatch': await handleAdminMatch(message, args); break;
        case 'undo': await handleUndo(message); break;
        case 'rankings': await handleRankings(message, false); break;
        case 'alltimerankings': await handleRankings(message, true); break;
        case 'stats': await handleShowStats(message, args); break;
        case 'mystats': await handleMyStats(message); break;
        case 'breakerstats': await handleBreakerStats(message); break;
        case 'tournament': await handleGenerateTournament(message, args); break;
        case 'help': await handleHelp(message); break;
        default: message.reply('Unknown command. Type `!pool help` for a list of commands.');
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || !interaction.customId.startsWith('break_')) return;

    try {
        const [, winnerId, loserId, matchTimestamp, who] = interaction.customId.split('_');
        const breakerId = who === 'winner' ? winnerId : loserId;

        await axios.post(`${LOGIC_SERVICE_URL}/match/breaker`, { matchTimestamp, breakerId });

        const breakerUser = await client.users.fetch(breakerId);
        
        await interaction.update({
            content: `**Breaker:** ${interaction.user.username} selected **${breakerUser.username}** as the breaker for the match.`,
            components: []
        });
    } catch (error) {
        console.error("Error handling break button interaction:", error);
        await interaction.reply({ content: 'There was an error processing this action.', ephemeral: true });
    }
});


// --- Internet Connection & Startup Logic ---
async function waitForInternet() {
    while (true) {
        try {
            await dns.lookup('google.com');
            console.log("Internet connection established.");
            break;
        } catch (error) {
            console.log("Waiting for internet connection... retrying in 5 seconds.");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function startBot() {
    await waitForInternet();
    client.login(process.env.TOKEN);
}

// --- Notification Server for Web UI ---
const app = express();
app.use(express.json());

app.post('/notify/match-recorded', async (req, res) => {
    try {
        const { seasonalResult, allTimeResult, targetChannelId } = req.body;

        // Use the specific channel ID if provided, otherwise fallback to the .env default
        const channelToUse = targetChannelId || NOTIFICATION_CHANNEL_ID;

        if (!channelToUse) {
            console.log("No channel ID configured for this notification.");
            return res.status(200).send({ message: "Notification skipped." });
        }
        
        const channel = await client.channels.fetch(channelToUse);
        if (!channel) {
            console.error(`Notification channel with ID ${channelToUse} not found.`);
            return res.status(404).send({ error: "Notification channel not found." });
        }

        const embed = new EmbedBuilder()
            .setTitle('Match Result Recorded (from Web)')
            .setColor('#1E90FF') // Blue color for web entries
            .addFields(
                { name: 'Winner', value: `${seasonalResult.winner.name} (Season ELO: ${seasonalResult.winner.elo}, +${seasonalResult.elo.winnerGain})`, inline: false },
                { name: 'Loser', value: `${seasonalResult.loser.name} (Season ELO: ${seasonalResult.loser.elo}, -${seasonalResult.elo.loserLoss})`, inline: false },
                { name: 'All-Time ELOs', value: `${allTimeResult.winner.name}: ${allTimeResult.winner.elo} | ${allTimeResult.loser.name}: ${allTimeResult.loser.elo}`, inline: false }
            )
            .setFooter({ text: 'Office Pool ELO System' });
        
        await channel.send({ embeds: [embed] });
        res.status(200).send({ message: "Notification sent successfully." });

    } catch (error) {
        console.error("Error sending Discord notification:", error);
        res.status(500).send({ error: "Internal server error while sending notification." });
    }
});

app.listen(NOTIFICATION_SERVER_PORT, 'localhost', () => {
    console.log(`Notification server listening on http://localhost:${NOTIFICATION_SERVER_PORT}`);
});

startBot();



