// Discord Pool ELO Bot - Listener Service (Universal Update)
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const express = require('express');
const dns = require('dns').promises;

// --- CONFIGURATION ---
const LOGIC_SERVICE_URL = 'http://localhost:3005';
const NOTIFICATION_SERVER_PORT = 3006;
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

function formatError(error) {
    if (error.response && error.response.data && error.response.data.error) {
        return error.response.data.error;
    }
    return error.message;
}

// --- COMMANDS ---

async function handleRegister(message, args) {
    if (args.length < 1) return message.reply('Usage: `!pool register YourName`');
    const playerName = args.join(' ');
    const playerId = message.author.id;
    try {
        const response = await axios.post(`${LOGIC_SERVICE_URL}/register`, { playerId, playerName });
        message.channel.send(response.data.message || "Registered.");
    } catch (error) {
        message.reply(`Registration failed: ${formatError(error)}`);
    }
}

async function handleRecordMatch(message, args) {
    const winnerId = message.author.id;
    const mention = message.mentions.users.first();
    if (!mention) return message.reply('Usage: `!pool match @opponent`');
    const loserId = mention.id;

    try {
        // 1. Record Match
        const response = await axios.post(`${LOGIC_SERVICE_URL}/match`, { winnerId, loserId, source: 'discord' });

        // If universal logic returned simple message (not 1v1), handle gracefully
        if (!response.data.seasonalResult) {
             return message.reply("Match recorded (Multi-player mode).");
        }

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

        // 2. Create Buttons for Starter (Renamed from Breaker)
        // Prefix: start_
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`start_${winnerId}_${loserId}_${timestamp}_winner`).setLabel(seasonalResult.winner.name).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`start_${winnerId}_${loserId}_${timestamp}_loser`).setLabel(seasonalResult.loser.name).setStyle(ButtonStyle.Secondary)
        );

        message.reply({ embeds: [embed], components: [row], content: '**Starter:** Select who started/served/broke for this match.' });

    } catch (error) {
        message.reply(`Failed to record match: ${formatError(error)}`);
    }
}

async function handleAdminMatch(message, args) {
     if (message.mentions.users.size !== 2) return message.reply('Usage: `!pool adminmatch @winner @loser`');

    const mentionRegex = /<@!?(\d+)>/g;
    const matches = [...message.content.matchAll(mentionRegex)];
    const winnerId = matches[0][1];
    const loserId = matches[1][1];

    try {
        const response = await axios.post(`${LOGIC_SERVICE_URL}/match`, { winnerId, loserId, source: 'discord' });

        if (!response.data.seasonalResult) return message.reply("Match recorded.");

        const { seasonalResult, allTimeResult, timestamp } = response.data;
        const embed = new EmbedBuilder()
            .setTitle('Match Result Recorded (Admin)')
            .setColor('#00FF00')
            .setDescription(`${message.author.username} recorded a match.`)
            .addFields(
                { name: 'Winner', value: `${seasonalResult.winner.name} (Season ELO: ${seasonalResult.winner.elo}, +${seasonalResult.elo.winnerGain})`, inline: false },
                { name: 'Loser', value: `${seasonalResult.loser.name} (Season ELO: ${seasonalResult.loser.elo}, -${seasonalResult.elo.loserLoss})`, inline: false }
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`start_${winnerId}_${loserId}_${timestamp}_winner`).setLabel(seasonalResult.winner.name).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`start_${winnerId}_${loserId}_${timestamp}_loser`).setLabel(seasonalResult.loser.name).setStyle(ButtonStyle.Secondary)
        );

        message.reply({ embeds: [embed], components: [row], content: '**Starter:** Select who started.' });

    } catch (error) {
        message.reply(`Failed to record admin match: ${formatError(error)}`);
    }
}

async function handleUndo(message) {
    try {
        // Send empty object or specific ID if known. Universal backend defaults to Pool if ID missing/null.
        const response = await axios.post(`${LOGIC_SERVICE_URL}/undo`, { leaderboardId: null });

        const { seasonal } = response.data;
        const embed = new EmbedBuilder()
            .setTitle('Match Reverted')
            .setColor('#FF3300')
            .setDescription(`The last match has been reverted.`)
            .setFooter({ text: 'Office Pool ELO System' });

        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to undo match: ${formatError(error)}`);
    }
}

async function handleRankings(message, allTime = false) {
    try {
        // Logic: Get list, pick Legacy or Newest Season
        const boardsResponse = await axios.get(`${LOGIC_SERVICE_URL}/leaderboards`);
        const boards = boardsResponse.data;

        let targetBoard;
        if (allTime) targetBoard = boards.find(b => b.isLegacy);
        else targetBoard = boards.find(b => !b.isLegacy); // Newest non-legacy is current season

        if (!targetBoard) return message.reply("Leaderboard not found.");

        const dataResponse = await axios.get(`${LOGIC_SERVICE_URL}/leaderboard/${targetBoard.id}`);
        const { players } = dataResponse.data;

        const rankedPlayers = Object.values(players)
            .filter(p => (p.wins + p.losses) > 0)
            .sort((a, b) => b.elo - a.elo);

        const embed = new EmbedBuilder()
            .setTitle(`Rankings (${targetBoard.name})`)
            .setColor(allTime ? '#DAA520' : '#0099FF');

        if (rankedPlayers.length === 0) embed.setDescription('No matches yet.');
        else {
            rankedPlayers.slice(0, 10).forEach((player, index) => {
                embed.addFields({ name: `#${index + 1} ${player.name}`, value: `ELO: ${player.elo} | ${player.wins}W ${player.losses}L`, inline: false });
            });
        }
        message.reply({ embeds: [embed] });

    } catch (error) {
        message.reply(`Failed to get rankings: ${formatError(error)}`);
    }
}

async function handleShowStats(message, args) {
    const playerId = message.mentions.users.size > 0 ? message.mentions.users.first().id : message.author.id;
    try {
        // Default to Legacy Pool for Discord Stats
        const boardsResponse = await axios.get(`${LOGIC_SERVICE_URL}/leaderboards`);
        const legacyBoard = boardsResponse.data.find(b => b.isLegacy);

        if (!legacyBoard) return message.reply("System not initialized.");

        const response = await axios.get(`${LOGIC_SERVICE_URL}/leaderboard/${legacyBoard.id}/player/${playerId}`);
        const { currentElo, stats } = response.data;

        const embed = new EmbedBuilder()
            .setTitle(`Stats (Legacy Pool)`)
            .setColor('#0099FF')
            .addFields(
                { name: 'Current ELO', value: `${currentElo}`, inline: true },
                { name: 'Peak ELO', value: `${stats.peakElo}`, inline: true },
                { name: 'Win Rate', value: `${stats.winRate}%`, inline: true },
                { name: 'Streak', value: `${stats.currentStreak}`, inline: true },
                { name: 'Best Matchup', value: `${stats.favorite}`, inline: true },
                { name: 'Nemesis', value: `${stats.nemesis}`, inline: true }
            );
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
            .setTitle(`All-Time Stats: ${player.name}`)
            .setColor('#1E90FF')
            .addFields(
                { name: 'Overall Win/Loss', value: `${player.wins}W / ${player.losses}L`, inline: true },
                { name: 'Overall Win Rate', value: `${overallWinPercentage}%`, inline: true },
                { name: 'Head-to-Head', value: opponentStatsDescription || "No matches played.", inline: false }
            );
        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to get detailed stats: ${formatError(error)}`);
    }
}

async function handleBreakerStats(message) {
    // Updated to use "Starter" terminology internally, but keeps command name for users if you want
    const args = message.content.split(/ +/);
    const isSeasonal = args.includes('season');

    try {
        let url = `${LOGIC_SERVICE_URL}/stats/starter`;
        let titleType = "All-Time";

        if (isSeasonal) {
            const boardsRes = await axios.get(`${LOGIC_SERVICE_URL}/leaderboards`);
            const seasonBoard = boardsRes.data.find(b => !b.isLegacy && b.name.startsWith("Pool 20"));

            if (seasonBoard) {
                url += `?boardId=${seasonBoard.id}`;
                titleType = seasonBoard.name;
            } else {
                return message.reply("No active season found.");
            }
        }

        const response = await axios.get(url);
        const { totalMatchesWithStarterInfo, starterWins, overallStarterWinPercentage, playerStarterStatsText } = response.data;

        const embed = new EmbedBuilder()
            .setTitle(`Starter Statistics (${titleType})`)
            .setColor('#8A2BE2')
            .addFields(
                { name: 'Matches Analyzed', value: `${totalMatchesWithStarterInfo}`, inline: false },
                { name: 'Starter Win Rate', value: `${overallStarterWinPercentage}%`, inline: false },
                { name: 'Frequencies', value: playerStarterStatsText || "No stats available.", inline: false }
            );
        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to get starter stats: ${formatError(error)}`);
    }
}

async function handleGenerateTournament(message, args) {
    const mentionedIds = message.mentions.users.map(user => user.id);
    try {
        const response = await axios.post(`${LOGIC_SERVICE_URL}/tournament`, { playerIds: mentionedIds });
        const { tournamentName, initialPlayerCount, bracketSize, byeCount, round1Matches } = response.data;

        const embed = new EmbedBuilder()
            .setTitle(`🏆 ${tournamentName} 🏆`)
            .setColor('#FF9900')
            .setDescription(`Players: ${initialPlayerCount} | Bracket: ${bracketSize}`)
            .setFooter({ text: 'Office Pool Tournament' });

        embed.addFields({ name: 'Round 1', value: '\u200B' });
        round1Matches.forEach((m) => {
             embed.addFields({ name: m.name, value: m.value, inline: false });
        });
        message.reply({ embeds: [embed] });
    } catch (error) {
        message.reply(`Failed to generate tournament: ${formatError(error)}`);
    }
}

async function handleHelp(message) {
    const embed = new EmbedBuilder()
        .setTitle('Office Pool ELO Bot Commands')
        .setColor('#0099FF')
        .addFields(
            { name: '!pool register [name]', value: 'Register yourself', inline: false },
            { name: '!pool match @opponent', value: 'Record a win', inline: false },
            { name: '!pool undo', value: 'Revert last match', inline: false },
            { name: '!pool rankings', value: 'Current season standings', inline: false },
            { name: '!pool stats', value: 'Your stats', inline: false },
            { name: '!pool tournament @p1 @p2...', value: 'Generate bracket', inline: false },
            { name: '!pool help', value: 'Show this message', inline: false }
        );
    message.reply({ embeds: [embed] });
}

// --- EVENT HANDLERS ---
client.once('ready', () => {
    console.log(`Discord Listener logged in as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith('!pool')) return;
    const args = message.content.slice(5).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const commands = {
        'register': handleRegister,
        'match': handleRecordMatch,
        'adminmatch': handleAdminMatch,
        'undo': handleUndo,
        'rankings': (m) => handleRankings(m, false),
        'alltimerankings': (m) => handleRankings(m, true),
        'stats': handleShowStats,
        'mystats': handleMyStats,
        'breakerstats': handleBreakerStats, // Keeps old command name for users
        'tournament': handleGenerateTournament,
        'help': handleHelp
    };

    if (commands[command]) {
        await commands[command](message, args);
    } else {
        message.reply('Unknown command. Type `!pool help` for list.');
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    // Handle 'start_' prefix (New) AND 'break_' (Old/Legacy buttons still in chat)
    if (!interaction.customId.startsWith('start_') && !interaction.customId.startsWith('break_')) return;

    try {
        const parts = interaction.customId.split('_');
        // format: prefix_winnerId_loserId_timestamp_who
        const winnerId = parts[1];
        const loserId = parts[2];
        const matchTimestamp = parts[3];
        const who = parts[4];

        const starterId = who === 'winner' ? winnerId : loserId;

        await axios.post(`${LOGIC_SERVICE_URL}/match/starter`, { matchTimestamp, starterId });

        const starterUser = await client.users.fetch(starterId);

        await interaction.update({
            content: `**Starter:** ${interaction.user.username} selected **${starterUser.username}**.`,
            components: []
        });
    } catch (error) {
        // Silent fail on double-clicks
        try { await interaction.reply({ content: 'Already recorded.', ephemeral: true }); } catch(e){}
    }
});


// --- STARTUP ---
async function waitForInternet() {
    while (true) {
        try {
            await dns.lookup('google.com');
            console.log("Internet connection established.");
            break;
        } catch (error) {
            console.log("Waiting for internet...");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function startBot() {
    await waitForInternet();
    client.login(process.env.TOKEN);
}

// --- NOTIFICATION SERVER ---
const app = express();
app.use(express.json());

app.post('/notify/match-recorded', async (req, res) => {
    try {
        const { seasonalResult, allTimeResult, targetChannelId } = req.body;
        const channelToUse = targetChannelId || NOTIFICATION_CHANNEL_ID;

        if (!channelToUse) return res.status(200).send({ message: "Skipped." });

        const channel = await client.channels.fetch(channelToUse);
        if (!channel) return res.status(404).send({ error: "Channel not found." });

        const embed = new EmbedBuilder()
            .setTitle('Match Result Recorded (Web)')
            .setColor('#1E90FF')
            .addFields(
                { name: 'Winner', value: `${seasonalResult.winner.name} (Season: ${seasonalResult.winner.elo}, +${seasonalResult.elo.winnerGain})`, inline: false },
                { name: 'Loser', value: `${seasonalResult.loser.name} (Season: ${seasonalResult.loser.elo}, -${seasonalResult.elo.loserLoss})`, inline: false },
                { name: 'All-Time', value: `${allTimeResult.winner.name}: ${allTimeResult.winner.elo} | ${allTimeResult.loser.name}: ${allTimeResult.loser.elo}`, inline: false }
            )
            .setFooter({ text: 'Office Pool ELO System' });

        await channel.send({ embeds: [embed] });
        res.status(200).send({ message: "Sent." });
    } catch (error) {
        console.error("Notify Error:", error);
        res.status(500).send({ error: "Error." });
    }
});

app.listen(NOTIFICATION_SERVER_PORT, 'localhost', () => {
    console.log(`Notification server running on ${NOTIFICATION_SERVER_PORT}`);
});

startBot();