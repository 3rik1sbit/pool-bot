// Discord Pool ELO Bot
// Required packages: discord.js, dotenv, node-json-db

// Install packages with:
// npm install discord.js dotenv node-json-db

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Collection } = require('discord.js');
const { JsonDB, Config } = require('node-json-db');
const { DataError } = require('node-json-db/dist/lib/Errors');

// --- Database Configuration ---
const DB_FOLDER = "poolDB";
const ALL_TIME_DB_NAME = `${DB_FOLDER}/poolEloDatabase`;
const DEFAULT_ELO = 1000;
const K_FACTOR = 32;

// Create a new client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// Initialize the all-time database
const allTimeDb = new JsonDB(new Config(ALL_TIME_DB_NAME, true, false, '/'));
let currentSeasonDb = null;

// --- Helper Functions for Seasonal Database ---

function getSeasonDbPath(date = new Date()) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    return `${DB_FOLDER}/poolEloDatabase_${year}_${month}`;
}

async function initializeAllTimeDatabase() {
    try {
        await allTimeDb.getData("/players");
    } catch (error) {
        if (error instanceof DataError) {
            await allTimeDb.push("/players", {});
            console.log("All-time database initialized with empty players collection");
        } else { throw error; }
    }
    try {
        await allTimeDb.getData("/matches");
    } catch (error) {
        if (error instanceof DataError) {
            await allTimeDb.push("/matches", []);
            console.log("All-time database initialized with empty matches collection");
        } else { throw error; }
    }
}

async function ensureCurrentSeasonDb() {
    const currentDate = new Date();
    const seasonDbPath = getSeasonDbPath(currentDate);

    if (currentSeasonDb && currentSeasonDb.db_name === seasonDbPath) {
        return currentSeasonDb;
    }

    console.log(`Attempting to load or initialize seasonal database: ${seasonDbPath}`);
    currentSeasonDb = new JsonDB(new Config(seasonDbPath, true, false, '/'));
    currentSeasonDb.db_name = seasonDbPath;

    try {
        await currentSeasonDb.getData("/players");
        console.log(`Successfully loaded seasonal database: ${seasonDbPath}`);
    } catch (error) {
        if (error instanceof DataError) {
            console.log(`Seasonal players collection for ${seasonDbPath} not found. Initializing...`);
            const allTimePlayers = await allTimeDb.getData("/players");
            const seasonalPlayers = {};
            for (const playerId in allTimePlayers) {
                seasonalPlayers[playerId] = {
                    id: allTimePlayers[playerId].id,
                    name: allTimePlayers[playerId].name,
                    elo: DEFAULT_ELO,
                    wins: 0,
                    losses: 0,
                    matches: []
                };
            }
            await currentSeasonDb.push("/players", seasonalPlayers);
            await currentSeasonDb.push("/matches", []);
            console.log(`Seasonal database ${seasonDbPath} initialized with players from all-time DB and reset ELO/stats.`);
        } else {
            console.error(`Error accessing seasonal database ${seasonDbPath}:`, error);
            throw error;
        }
    }
    return currentSeasonDb;
}

function calculateElo(winnerElo, loserElo) {
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));
    const newWinnerElo = Math.round(winnerElo + K_FACTOR * (1 - expectedWinner));
    const newLoserElo = Math.round(loserElo + K_FACTOR * (0 - expectedLoser));
    return { newWinnerElo, newLoserElo, winnerGain: newWinnerElo - winnerElo, loserLoss: loserElo - newLoserElo };
}

async function getPlayer(playerId, dbInstance) {
    try {
        return await dbInstance.getData(`/players/${playerId}`);
    } catch (error) {
        return null;
    }
}

async function undoLastMatch(message) {
    try {
        await ensureCurrentSeasonDb();

        const seasonalMatches = await currentSeasonDb.getData('/matches');
        if (!seasonalMatches || seasonalMatches.length === 0) {
            return message.reply('No matches found in the current season to undo.');
        }
        const lastSeasonalMatch = seasonalMatches.pop();

        const seasonalWinner = await getPlayer(lastSeasonalMatch.winnerId, currentSeasonDb);
        const seasonalLoser = await getPlayer(lastSeasonalMatch.loserId, currentSeasonDb);

        if (!seasonalWinner || !seasonalLoser) {
            await currentSeasonDb.push('/matches', seasonalMatches);
            return message.reply('Could not find players from the last seasonal match. Seasonal data might be inconsistent.');
        }
        
        const sWinnerName = seasonalWinner.name;
        const sLoserName = seasonalLoser.name;
        const sWinnerOldElo = seasonalWinner.elo + lastSeasonalMatch.winnerGain;
        const sLoserOldElo = seasonalLoser.elo - lastSeasonalMatch.loserLoss;

        seasonalWinner.elo -= lastSeasonalMatch.winnerGain;
        seasonalLoser.elo += lastSeasonalMatch.loserLoss;
        seasonalWinner.wins--;
        seasonalLoser.losses--;
        seasonalWinner.matches = seasonalWinner.matches.filter(match => match.timestamp !== lastSeasonalMatch.timestamp);
        seasonalLoser.matches = seasonalLoser.matches.filter(match => match.timestamp !== lastSeasonalMatch.timestamp);

        await currentSeasonDb.push(`/players/${seasonalWinner.id}`, seasonalWinner);
        await currentSeasonDb.push(`/players/${seasonalLoser.id}`, seasonalLoser);
        await currentSeasonDb.push('/matches', seasonalMatches);

        // --- Undo All-Time Match ---
        let allTimeMatches = await allTimeDb.getData('/matches');
        // Find the corresponding all-time match using the unique timestamp
        const allTimeMatchIndex = allTimeMatches.findIndex(m => m.timestamp === lastSeasonalMatch.timestamp);

        if (allTimeMatchIndex === -1) {
            console.error(`CRITICAL: Could not find all-time match with timestamp ${lastSeasonalMatch.timestamp} to undo.`);
            message.reply(`Seasonal match reverted. However, the corresponding all-time match (Timestamp: ${lastSeasonalMatch.timestamp}) could not be found and undone. Please check manually.`);
            return;
        }

        const lastAllTimeMatch = allTimeMatches[allTimeMatchIndex];
        allTimeMatches.splice(allTimeMatchIndex, 1);

        const allTimeWinner = await getPlayer(lastAllTimeMatch.winnerId, allTimeDb);
        const allTimeLoser = await getPlayer(lastAllTimeMatch.loserId, allTimeDb);

        if (!allTimeWinner || !allTimeLoser) {
            console.error(`CRITICAL: Players from all-time match timestamp ${lastAllTimeMatch.timestamp} not found in all-time DB.`);
            await allTimeDb.push('/matches', allTimeMatches);
            message.reply(`Seasonal match reverted. All-time match entry removed. However, player data for all-time (Timestamp: ${lastAllTimeMatch.timestamp}) could not be fully reverted. Please check manually.`);
            return;
        }

        allTimeWinner.elo -= lastAllTimeMatch.winnerGain;
        allTimeLoser.elo += lastAllTimeMatch.loserLoss;
        allTimeWinner.wins--;
        allTimeLoser.losses--;
        allTimeWinner.matches = allTimeWinner.matches.filter(match => match.timestamp !== lastAllTimeMatch.timestamp);
        allTimeLoser.matches = allTimeLoser.matches.filter(match => match.timestamp !== lastAllTimeMatch.timestamp);

        await allTimeDb.push(`/players/${allTimeWinner.id}`, allTimeWinner);
        await allTimeDb.push(`/players/${allTimeLoser.id}`, allTimeLoser);
        await allTimeDb.push('/matches', allTimeMatches);

        const embed = new EmbedBuilder()
            .setTitle('Match Reverted (Season & All-Time)')
            .setColor('#FF3300')
            .setDescription(`The last match has been reverted in both seasonal and all-time records.`)
            .addFields(
                { name: 'Reverted Match', value: `${sWinnerName} vs ${sLoserName}`, inline: false },
                { name: `${sWinnerName} (Season)`, value: `${sWinnerOldElo} → ${seasonalWinner.elo} (-${lastSeasonalMatch.winnerGain} ELO)`, inline: true },
                { name: `${sLoserName} (Season)`, value: `${sLoserOldElo} → ${seasonalLoser.elo} (+${lastSeasonalMatch.loserLoss} ELO)`, inline: true },
                { name: `${allTimeWinner.name} (All-Time ELO)`, value: `${allTimeWinner.elo + lastAllTimeMatch.winnerGain} → ${allTimeWinner.elo}`, inline: true},
                { name: `${allTimeLoser.name} (All-Time ELO)`, value: `${allTimeLoser.elo - lastAllTimeMatch.loserLoss} → ${allTimeLoser.elo}`, inline: true}
            )
            .setFooter({ text: 'Office Pool ELO System' });
        message.reply({ embeds: [embed] });
    } catch (error) {
        console.error('Error undoing last match:', error);
        message.reply('Error undoing last match. Check console for details.');
    }
}

async function registerPlayer(message, args) {
    if (args.length < 1) return message.reply('Please provide a name. Usage: `!pool register YourName`');
    const playerName = args.join(' ');
    const playerId = message.author.id;
    await ensureCurrentSeasonDb();

    let existingAllTimePlayer = await getPlayer(playerId, allTimeDb);
    if (existingAllTimePlayer) {
        message.reply(`You are already registered in the all-time records as ${existingAllTimePlayer.name}.`);
    } else {
        const allTimePlayerData = { id: playerId, name: playerName, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await allTimeDb.push(`/players/${playerId}`, allTimePlayerData);
        message.channel.send(`Successfully registered **${playerName}** for all-time records with ELO ${DEFAULT_ELO}.`);
    }

    let existingSeasonalPlayer = await getPlayer(playerId, currentSeasonDb);
    if (existingSeasonalPlayer) {
        message.channel.send(`You are already part of the current season (${existingSeasonalPlayer.name}, ELO: ${existingSeasonalPlayer.elo}).`);
    } else {
        const seasonalPlayerData = { id: playerId, name: playerName, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await currentSeasonDb.push(`/players/${playerId}`, seasonalPlayerData);
        message.channel.send(`Added **${playerName}** to the current season with ELO ${DEFAULT_ELO}.`);
    }
}

async function recordMatch(message, args) {
    if (args.length < 1) return message.reply('Please mention the player you defeated. Usage: `!pool match @opponent`');
    await ensureCurrentSeasonDb();

    const winnerId = message.author.id;
    const mention = message.mentions.users.first();
    if (!mention) return message.reply('Please mention the player you defeated.');
    const loserId = mention.id;

    if (winnerId === loserId) return message.reply('You cannot play against yourself.');

    let seasonWinner = await getPlayer(winnerId, currentSeasonDb);
    let seasonLoser = await getPlayer(loserId, currentSeasonDb);
    let allTimeWinner = await getPlayer(winnerId, allTimeDb);
    let allTimeLoser = await getPlayer(loserId, allTimeDb);

    if (!allTimeWinner) return message.reply('You (winner) need to register first with `!pool register YourName`.');
    if (!allTimeLoser) return message.reply(`The player you mentioned (loser) is not registered yet (all-time).`);

    if (!seasonWinner) {
        seasonWinner = { id: winnerId, name: allTimeWinner.name, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await currentSeasonDb.push(`/players/${winnerId}`, seasonWinner);
    }
    if (!seasonLoser) {
        seasonLoser = { id: loserId, name: allTimeLoser.name, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await currentSeasonDb.push(`/players/${loserId}`, seasonLoser);
    }
    
    const matchTimestamp = new Date().toISOString();

    const seasonalEloResult = calculateElo(seasonWinner.elo, seasonLoser.elo);
    seasonWinner.elo = seasonalEloResult.newWinnerElo;
    seasonWinner.wins++;
    seasonWinner.matches.push({ opponent: loserId, result: 'win', eloChange: seasonalEloResult.winnerGain, timestamp: matchTimestamp });
    seasonLoser.elo = seasonalEloResult.newLoserElo;
    seasonLoser.losses++;
    seasonLoser.matches.push({ opponent: winnerId, result: 'loss', eloChange: -seasonalEloResult.loserLoss, timestamp: matchTimestamp });
    const seasonalMatchData = { winnerId, loserId, winnerElo: seasonWinner.elo, loserElo: seasonLoser.elo, winnerGain: seasonalEloResult.winnerGain, loserLoss: seasonalEloResult.loserLoss, timestamp: matchTimestamp };
    await currentSeasonDb.push(`/players/${winnerId}`, seasonWinner);
    await currentSeasonDb.push(`/players/${loserId}`, seasonLoser);
    await currentSeasonDb.push('/matches[]', seasonalMatchData, true);

    const allTimeEloResult = calculateElo(allTimeWinner.elo, allTimeLoser.elo);
    allTimeWinner.elo = allTimeEloResult.newWinnerElo;
    allTimeWinner.wins++;
    allTimeWinner.matches.push({ opponent: loserId, result: 'win', eloChange: allTimeEloResult.winnerGain, timestamp: matchTimestamp });
    allTimeLoser.elo = allTimeEloResult.newLoserElo;
    allTimeLoser.losses++;
    allTimeLoser.matches.push({ opponent: winnerId, result: 'loss', eloChange: -allTimeEloResult.loserLoss, timestamp: matchTimestamp });
    const allTimeMatchData = { winnerId, loserId, winnerElo: allTimeWinner.elo, loserElo: allTimeLoser.elo, winnerGain: allTimeEloResult.winnerGain, loserLoss: allTimeEloResult.loserLoss, timestamp: matchTimestamp };
    await allTimeDb.push(`/players/${winnerId}`, allTimeWinner);
    await allTimeDb.push(`/players/${loserId}`, allTimeLoser);
    await allTimeDb.push('/matches[]', allTimeMatchData, true);

    const embed = new EmbedBuilder()
        .setTitle('Match Result Recorded (Seasonal)')
        .setColor('#00FF00')
        .addFields(
            { name: 'Winner', value: `${seasonWinner.name} (Season ELO: ${seasonWinner.elo}, +${seasonalEloResult.winnerGain})`, inline: false },
            { name: 'Loser', value: `${seasonLoser.name} (Season ELO: ${seasonLoser.elo}, -${seasonalEloResult.loserLoss})`, inline: false },
            { name: 'All-Time ELOs', value: `${allTimeWinner.name}: ${allTimeWinner.elo} | ${allTimeLoser.name}: ${allTimeLoser.elo}`, inline: false }
        )
        .setFooter({ text: 'Office Pool ELO System' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`break_${winnerId}_${loserId}_${matchTimestamp}_winner`).setLabel(seasonWinner.name).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`break_${winnerId}_${loserId}_${matchTimestamp}_loser`).setLabel(seasonLoser.name).setStyle(ButtonStyle.Secondary)
    );

    message.reply({ embeds: [embed], components: [row], content: '**Breaker:** Select who made the break shot for this match.' });
}

async function recordAdminMatch(message, args) {
    
    // 1. Validate that two *unique* users were mentioned. This check is still correct.
    if (message.mentions.users.size !== 2) {
        return message.reply('Please mention exactly two players. Usage: `!pool adminmatch @winner @loser`');
    }
    await ensureCurrentSeasonDb();

    // 2. Get the IDs in the correct order by parsing the message content.
    const mentionRegex = /<@!?(\d+)>/g;
    const matches = [...message.content.matchAll(mentionRegex)];
    const orderedMentionIds = matches.map(match => match[1]);
    
    const winnerId = orderedMentionIds[0];
    const loserId = orderedMentionIds[1];

    if (winnerId === loserId) {
        return message.reply('The winner and loser cannot be the same person.');
    }

    let seasonWinner = await getPlayer(winnerId, currentSeasonDb);
    let seasonLoser = await getPlayer(loserId, currentSeasonDb);
    let allTimeWinner = await getPlayer(winnerId, allTimeDb);
    let allTimeLoser = await getPlayer(loserId, allTimeDb);

    // 3. Updated error messages to be clearer for an admin
    // You will also need to get the User objects for their names in the error messages
    const winnerUser = message.mentions.users.get(winnerId);
    const loserUser = message.mentions.users.get(loserId);
    if (!allTimeWinner) return message.reply(`The winning player (${winnerUser.username}) needs to be registered first with \`!pool register\`.`);
    if (!allTimeLoser) return message.reply(`The losing player (${loserUser.username}) needs to be registered first with \`!pool register\`.`);

    if (!seasonWinner) {
        seasonWinner = { id: winnerId, name: allTimeWinner.name, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await currentSeasonDb.push(`/players/${winnerId}`, seasonWinner);
        message.channel.send(`Adding ${allTimeWinner.name} to the current season.`);
    }
    if (!seasonLoser) {
        seasonLoser = { id: loserId, name: allTimeLoser.name, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await currentSeasonDb.push(`/players/${loserId}`, seasonLoser);
        message.channel.send(`Adding ${allTimeLoser.name} to the current season.`);
    }

    const matchTimestamp = new Date().toISOString();

    // Seasonal update
    const seasonalEloResult = calculateElo(seasonWinner.elo, seasonLoser.elo);
    seasonWinner.elo = seasonalEloResult.newWinnerElo;
    seasonWinner.wins++;
    seasonWinner.matches.push({ opponent: loserId, result: 'win', eloChange: seasonalEloResult.winnerGain, timestamp: matchTimestamp });
    seasonLoser.elo = seasonalEloResult.newLoserElo;
    seasonLoser.losses++;
    seasonLoser.matches.push({ opponent: winnerId, result: 'loss', eloChange: -seasonalEloResult.loserLoss, timestamp: matchTimestamp });
    const seasonalMatchData = { winnerId, loserId, winnerElo: seasonWinner.elo, loserElo: seasonLoser.elo, winnerGain: seasonalEloResult.winnerGain, loserLoss: seasonalEloResult.loserLoss, timestamp: matchTimestamp };
    await currentSeasonDb.push(`/players/${winnerId}`, seasonWinner);
    await currentSeasonDb.push(`/players/${loserId}`, seasonLoser);
    await currentSeasonDb.push('/matches[]', seasonalMatchData, true);

    // All-time update
    const allTimeEloResult = calculateElo(allTimeWinner.elo, allTimeLoser.elo);
    allTimeWinner.elo = allTimeEloResult.newWinnerElo;
    allTimeWinner.wins++;
    allTimeWinner.matches.push({ opponent: loserId, result: 'win', eloChange: allTimeEloResult.winnerGain, timestamp: matchTimestamp });
    allTimeLoser.elo = allTimeEloResult.newLoserElo;
    allTimeLoser.losses++;
    allTimeLoser.matches.push({ opponent: winnerId, result: 'loss', eloChange: -allTimeEloResult.loserLoss, timestamp: matchTimestamp });
    const allTimeMatchData = { winnerId, loserId, winnerElo: allTimeWinner.elo, loserElo: allTimeLoser.elo, winnerGain: allTimeEloResult.winnerGain, loserLoss: allTimeEloResult.loserLoss, timestamp: matchTimestamp };
    await allTimeDb.push(`/players/${winnerId}`, allTimeWinner);
    await allTimeDb.push(`/players/${loserId}`, allTimeLoser);
    await allTimeDb.push('/matches[]', allTimeMatchData, true);

    const embed = new EmbedBuilder()
        .setTitle('Match Result Recorded (Admin)')
        .setColor('#00FF00')
        .setDescription(`${message.author.username} recorded a match.`)
        .addFields(
            { name: 'Winner', value: `${seasonWinner.name} (Season ELO: ${seasonWinner.elo}, +${seasonalEloResult.winnerGain})`, inline: false },
            { name: 'Loser', value: `${seasonLoser.name} (Season ELO: ${seasonLoser.elo}, -${seasonalEloResult.loserLoss})`, inline: false },
            { name: 'All-Time ELOs', value: `${allTimeWinner.name}: ${allTimeWinner.elo} | ${allTimeLoser.name}: ${allTimeLoser.elo}`, inline: false }
        )
        .setFooter({ text: 'Office Pool ELO System' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`break_${winnerId}_${loserId}_${matchTimestamp}_winner`).setLabel(seasonWinner.name).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`break_${winnerId}_${loserId}_${matchTimestamp}_loser`).setLabel(seasonLoser.name).setStyle(ButtonStyle.Secondary)
    );

    message.reply({ embeds: [embed], components: [row], content: '**Breaker:** Select who made the break shot for this match.' });
}

async function showRankings(message) {
    try {
        await ensureCurrentSeasonDb();
        const players = await currentSeasonDb.getData('/players');
        const activePlayers = Object.values(players).filter(player => (player.wins + player.losses) > 0);

        if (activePlayers.length === 0) {
            return message.reply('No players have recorded any games in the current season yet.');
        }

        const rankedPlayers = activePlayers.sort((a, b) => b.elo - a.elo);
        const currentPath = getSeasonDbPath();
        const seasonName = currentPath.split('_').slice(1).join('/');
        const embed = new EmbedBuilder()
            .setTitle(`Office Pool Rankings (Current Season: ${seasonName})`)
            .setColor('#0099FF')
            .setFooter({ text: 'Office Pool ELO System - Seasonal Rankings' });

        rankedPlayers.slice(0, 10).forEach((player, index) => {
            embed.addFields({ name: `#${index + 1} ${player.name}`, value: `ELO: ${player.elo} | W: ${player.wins} | L: ${player.losses}`, inline: false });
        });
        message.reply({ embeds: [embed] });
    } catch (error) {
        console.error('Error showing seasonal rankings:', error);
        if (error instanceof DataError) {
             message.reply('No players are registered in the current season yet.');
        } else {
             message.reply('An error occurred while retrieving seasonal rankings.');
        }
    }
}

async function showAllTimeRankings(message) {
    try {
        const players = await allTimeDb.getData('/players');
        if (Object.keys(players).length === 0) return message.reply('No players are registered for all-time records yet.');
        const rankedPlayers = Object.values(players).sort((a, b) => b.elo - a.elo);
        const embed = new EmbedBuilder()
            .setTitle('Office Pool Rankings (All-Time)')
            .setColor('#DAA520')
            .setFooter({ text: 'Office Pool ELO System - All-Time Rankings' });
        rankedPlayers.slice(0, 10).forEach((player, index) => {
            embed.addFields({ name: `#${index + 1} ${player.name}`, value: `ELO: ${player.elo} | W: ${player.wins} | L: ${player.losses}`, inline: false });
        });
        message.reply({ embeds: [embed] });
    } catch (error) {
        console.error('Error showing all-time rankings:', error);
        message.reply('Error retrieving all-time rankings.');
    }
}

async function showPlayerStats(message, args) {
    try {
        await ensureCurrentSeasonDb();
        let playerId = message.mentions.users.size > 0 ? message.mentions.users.first().id : message.author.id;
        const seasonPlayer = await getPlayer(playerId, currentSeasonDb);
        const allTimePlayer = await getPlayer(playerId, allTimeDb);

        if (!allTimePlayer) return message.reply('This player is not registered in any records yet.');
        if (!seasonPlayer) return message.reply(`**${allTimePlayer.name}** is registered all-time (ELO: ${allTimePlayer.elo}) but has no stats for the current season yet.`);

        const embed = new EmbedBuilder()
            .setTitle(`${seasonPlayer.name}'s Stats (Current Season)`)
            .setColor('#0099FF')
            .addFields(
                { name: 'Season ELO', value: `${seasonPlayer.elo}`, inline: true },
                { name: 'Season Wins', value: `${seasonPlayer.wins}`, inline: true },
                { name: 'Season Losses', value: `${seasonPlayer.losses}`, inline: true },
                { name: 'Season Win Rate', value: `${seasonPlayer.wins + seasonPlayer.losses > 0 ? Math.round((seasonPlayer.wins / (seasonPlayer.wins + seasonPlayer.losses)) * 100) : 0}%`, inline: true },
                { name: 'All-Time ELO', value: `${allTimePlayer.elo}`, inline: true }
            )
            .setFooter({ text: 'Office Pool ELO System' });

        if (seasonPlayer.matches.length > 0) {
            const recentMatches = seasonPlayer.matches.slice(-5).reverse();
            let matchesText = '';
            for (const match of recentMatches) {
                let opponent = await getPlayer(match.opponent, currentSeasonDb) || await getPlayer(match.opponent, allTimeDb);
                const opponentName = opponent ? opponent.name : 'Unknown Player';
                const result = match.result === 'win' ? 'Won' : 'Lost';
                const eloChange = match.eloChange > 0 ? `+${match.eloChange}` : match.eloChange;
                const date = new Date(match.timestamp).toLocaleDateString();
                matchesText += `${result} vs ${opponentName} (Season ELO ${eloChange}) - ${date}\n`;
            }
            embed.addFields({ name: 'Recent Seasonal Matches', value: matchesText || 'No matches yet', inline: false });
        }
        message.reply({ embeds: [embed] });
    } catch (error) {
        console.error("Error showing player stats:", error);
        message.reply("Error retrieving player stats.");
    }
}

// Generate tournament bracket (uses seasonal ELOs)
async function generateTournament(message, args) {
    try {
        await ensureCurrentSeasonDb(); // Ensure we have seasonal data

        function nextPowerOf2(n) {
            let power = 1;
            while (power < n) {
                power *= 2;
            }
            return power;
        }
        function shuffleArray(array) {
            const newArray = [...array];
            for (let i = newArray.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
            }
            return newArray;
        }

        let playerList = [];

        if (message.mentions.users.size > 0) {
            for (const [id, user] of message.mentions.users) {
                const player = await getPlayer(id, currentSeasonDb); // Use seasonal DB
                if (player) {
                    playerList.push(player);
                } else {
                     message.channel.send(`${user.username} is not registered or has not played in the current season.`);
                }
            }
            if (playerList.length < 2) {
                return message.reply('Please mention at least 2 registered (seasonal) players for the tournament.');
            }
        } else {
            const seasonalPlayers = await currentSeasonDb.getData('/players'); // Use seasonal DB
            playerList = Object.values(seasonalPlayers);
            if (playerList.length < 2) {
                return message.reply('Need at least 2 players in the current season for a tournament.');
            }
        }

        playerList = shuffleArray(playerList);
        const initialPlayerCount = playerList.length;
        const bracketSize = nextPowerOf2(initialPlayerCount);
        const round1Matches = [];
        let remainingPlayers = [...playerList];
        const byeCount = bracketSize - initialPlayerCount;

        for (let i = 0; i < bracketSize / 2; i++) {
            const matchIndex = i + 1;
            if (i < byeCount) {
                if (remainingPlayers.length > 0) {
                    round1Matches.push({ matchNumber: matchIndex, player1: remainingPlayers.shift(), player2: null, breaker: 'player1' });
                }
            } else {
                if (remainingPlayers.length >= 2) {
                    round1Matches.push({ matchNumber: matchIndex, player1: remainingPlayers.shift(), player2: remainingPlayers.shift(), breaker: Math.random() < 0.5 ? 'player1' : 'player2' });
                }
            }
        }
        
        const tournamentName = generateSwedishPoolTournamentName().toUpperCase();
        const embed = new EmbedBuilder()
            .setTitle(`🏆 ${tournamentName} (Seasonal) 🏆`)
            .setColor('#FF9900')
            .setDescription(`Tournament with ${initialPlayerCount} players (seasonal ELOs).\nBracket Size: ${bracketSize}. ${byeCount > 0 ? `(${byeCount} byes)` : ''}`)
            .setFooter({ text: 'Office Pool Tournament | Göteborg Edition - Seasonal' });

        embed.addFields({ name: '--- Round 1 (Seasonal ELOs) ---', value: '\u200B' });
        round1Matches.forEach((match) => {
            if (match.player2) {
                const breakerName = match.breaker === 'player1' ? match.player1.name : match.player2.name;
                embed.addFields({
                    name: `Match ${match.matchNumber}`,
                    value: `**${match.player1.name}** (${match.player1.elo} ELO) vs **${match.player2.name}** (${match.player2.elo} ELO)\n*${breakerName} breaks first*`,
                    inline: false
                });
            } else if (match.player1) {
                embed.addFields({
                    name: `Match ${match.matchNumber}`,
                    value: `**${match.player1.name}** (${match.player1.elo} ELO) - *Bye to next round*`,
                    inline: false
                });
            }
        });
        
        const subsequentBreaksInfo = [];
        let currentMatchNumber = round1Matches.length;
        let matchesInPreviousRound = round1Matches.length;
        let roundCounter = 2;
        let prereqRoundStartMatchNumber = 1;

        while (matchesInPreviousRound > 1) {
            const matchesInCurrentRound = matchesInPreviousRound / 2;
            const roundTitle = `--- Round ${roundCounter} ${matchesInCurrentRound === 1 ? '(Final)' : matchesInCurrentRound === 2 ? '(Semi-Finals)' : ''} ---`;
            subsequentBreaksInfo.push(`\n**${roundTitle}**`);

            for (let i = 0; i < matchesInCurrentRound; i++) {
                currentMatchNumber++;
                const prereqMatch1Index = prereqRoundStartMatchNumber + (2 * i);
                const prereqMatch2Index = prereqRoundStartMatchNumber + (2 * i) + 1;
                const breakerMatchIndex = prereqMatch1Index;
                const matchDescription = `Match ${currentMatchNumber}: Winner M${prereqMatch1Index} vs Winner M${prereqMatch2Index}\n*Winner of Match ${breakerMatchIndex} breaks first*`;
                subsequentBreaksInfo.push(matchDescription);
            }
            prereqRoundStartMatchNumber = currentMatchNumber - matchesInCurrentRound + 1;
            matchesInPreviousRound = matchesInCurrentRound;
            roundCounter++;
        }

        if (subsequentBreaksInfo.length > 0) {
            let subsequentBreaksValue = subsequentBreaksInfo.join('\n');
            if (subsequentBreaksValue.length > 1024) {
                subsequentBreaksValue = subsequentBreaksValue.substring(0, 1021) + '...';
            }
            embed.addFields({ name: 'Subsequent Rounds & Breaks', value: subsequentBreaksValue, inline: false });
        }

        message.reply({ embeds: [embed] });

    } catch (error) {
        console.error('Error generating tournament:', error);
        message.reply(`An error occurred while generating the tournament bracket: ${error.message}`);
    }
}

// Show your own detailed all-time stats
async function showMyStats(message) {
    try {
        const requesterId = message.author.id;

        const allPlayers = await allTimeDb.getData('/players');
        const player = allPlayers[requesterId];

        if (!player) {
            return message.reply('You are not registered. Use `!pool register YourName` to get started.');
        }

        const allMatches = await allTimeDb.getData('/matches');
        const playerMatches = allMatches.filter(m => m.winnerId === requesterId || m.loserId === requesterId);

        if (playerMatches.length === 0) {
            return message.reply('You have not played any matches yet.');
        }

        const totalGames = player.wins + player.losses;
        const overallWinPercentage = totalGames > 0 ? (player.wins / totalGames) * 100 : 0;
        const opponentStats = {};

        for (const match of playerMatches) {
            const opponentId = match.winnerId === requesterId ? match.loserId : match.winnerId;
            if (!opponentStats[opponentId]) {
                opponentStats[opponentId] = {
                    wins: 0,
                    losses: 0,
                    name: allPlayers[opponentId] ? allPlayers[opponentId].name : 'Unknown Player'
                };
            }
            if (match.winnerId === requesterId) {
                opponentStats[opponentId].wins++;
            } else {
                opponentStats[opponentId].losses++;
            }
        }

        let opponentStatsDescription = '';
        const sortedOpponents = Object.entries(opponentStats).sort(([, a], [, b]) => {
            const aTotal = a.wins + a.losses;
            const bTotal = b.wins + b.losses;
            return bTotal - aTotal;
        });

        for (const [opponentId, stats] of sortedOpponents) {
            const total = stats.wins + stats.losses;
            const percentage = total > 0 ? (stats.wins / total) * 100 : 0;
            opponentStatsDescription += `vs **${stats.name}**: ${stats.wins}W / ${stats.losses}L (${percentage.toFixed(0)}%)\n`;
        }

        if (!opponentStatsDescription) {
            opponentStatsDescription = 'No matches found against any opponent.';
        }

        const embed = new EmbedBuilder()
            .setTitle(`Your All-Time Stats: ${player.name}`)
            .setColor('#1E90FF')
            .addFields(
                { name: 'Overall Win/Loss', value: `${player.wins}W / ${player.losses}L`, inline: true },
                { name: 'Overall Win Rate', value: `${overallWinPercentage.toFixed(2)}%`, inline: true },
                { name: '\u200B', value: '\u200B', inline: false },
                { name: 'Head-to-Head Records', value: opponentStatsDescription, inline: false }
            )
            .setFooter({ text: 'Office Pool ELO System - All-Time Personal Stats' });

        message.reply({ embeds: [embed] });

    } catch (error) {
        console.error("Error showing my stats:", error);
        if (error instanceof DataError) {
             message.reply('Could not retrieve all necessary data. Have any matches been played?');
        } else {
             message.reply("An error occurred while retrieving your stats.");
        }
    }
}

async function showBreakerStats(message) {
    try {
        let matches;
        let allPlayers;
        try {
            matches = await allTimeDb.getData('/matches');
            allPlayers = await allTimeDb.getData('/players');
        } catch (e) {
            if (e instanceof DataError) {
                return message.reply('No all-time match data found. Play some matches first!');
            }
            throw e;
        }

        if (!matches || matches.length === 0) {
            return message.reply('No matches found in the all-time records to analyze for breaker stats.');
        }

        let totalMatchesWithBreakerInfo = 0;
        let breakerWins = 0;
        const playerBreakCounts = {};
        const playerGamesWithBreakInfo = {};

        for (const match of matches) {
            if (match.breakerId && typeof match.breakerId === 'string' && match.breakerId.trim() !== '') {
                totalMatchesWithBreakerInfo++;
                if (match.breakerId === match.winnerId) {
                    breakerWins++;
                }
                const breakerId = match.breakerId;
                playerBreakCounts[breakerId] = (playerBreakCounts[breakerId] || 0) + 1;
                if (match.winnerId) {
                    playerGamesWithBreakInfo[match.winnerId] = (playerGamesWithBreakInfo[match.winnerId] || 0) + 1;
                }
                if (match.loserId && match.winnerId !== match.loserId) {
                    playerGamesWithBreakInfo[match.loserId] = (playerGamesWithBreakInfo[match.loserId] || 0) + 1;
                }
            }
        }

        if (totalMatchesWithBreakerInfo === 0) {
            return message.reply('No matches with breaker information found in the all-time records. Make sure to select who broke after reporting a match!');
        }

        const overallBreakerWinPercentage = (breakerWins / totalMatchesWithBreakerInfo) * 100;

        let playerBreakStatsText = "No individual player break statistics available.";
        const relevantPlayerIds = Object.keys(playerGamesWithBreakInfo);

        if (relevantPlayerIds.length > 0) {
            const breakStatsArray = [];
            for (const playerId of relevantPlayerIds) {
                const timesBroke = playerBreakCounts[playerId] || 0;
                const totalGamesForPlayerWithBreakInfo = playerGamesWithBreakInfo[playerId];
                const playerBreakPercentage = (timesBroke / totalGamesForPlayerWithBreakInfo) * 100;
                const playerName = allPlayers[playerId] ? allPlayers[playerId].name : `Player ID ${playerId}`;
                breakStatsArray.push({ name: playerName, timesBroke, totalGamesWithInfo: totalGamesForPlayerWithBreakInfo, breakPercentage: playerBreakPercentage });
            }

            breakStatsArray.sort((a, b) => {
                if (b.breakPercentage !== a.breakPercentage) return b.breakPercentage - a.breakPercentage;
                if (b.timesBroke !== a.timesBroke) return b.timesBroke - a.timesBroke;
                return a.name.localeCompare(b.name);
            });
            
            const displayLimit = 15;
            if (breakStatsArray.length > 0) {
                playerBreakStatsText = breakStatsArray
                    .slice(0, displayLimit)
                    .map(stat => `• ${stat.name}: Broke ${stat.timesBroke} times (${stat.breakPercentage.toFixed(1)}% of their ${stat.totalGamesWithInfo} games with break info)`)
                    .join('\n');
                if (breakStatsArray.length > displayLimit) {
                    playerBreakStatsText += `\n...and ${breakStatsArray.length - displayLimit} more player(s).`;
                }
            }
        }

        const embed = new EmbedBuilder()
            .setTitle(`Breaker Statistics (All-Time)`)
            .setColor('#8A2BE2')
            .addFields(
                { name: 'Matches Analyzed (with any breaker info)', value: `${totalMatchesWithBreakerInfo}`, inline: false },
                { name: 'Overall Times Breaker Won Match', value: `${breakerWins}`, inline: false },
                { name: 'Overall Breaker Win Percentage', value: `${overallBreakerWinPercentage.toFixed(2)}%`, inline: false },
                { name: 'Player Break Frequencies (Ranked by % of Own Games Breaking)', value: playerBreakStatsText, inline: false }
            )
            .setFooter({ text: 'Office Pool ELO System - All-Time Stats' });

        message.reply({ embeds: [embed] });

    } catch (error) {
        console.error('Error calculating all-time breaker stats:', error);
        message.reply('An error occurred while calculating all-time breaker statistics. Please check the bot logs.');
    }
}

// Show help message
async function showHelp(message) {
    const embed = new EmbedBuilder()
        .setTitle('Office Pool ELO Bot Commands')
        .setColor('#0099FF')
        .setDescription('Here are the available commands:')
        .addFields(
            { name: '!pool register [name]', value: 'Register yourself as a player (for all-time and current season)', inline: false },
            { name: '!pool match @opponent', value: 'Record that you won a match (updates seasonal and all-time ELO)', inline: false },
            { name: '!pool adminmatch @winner @loser', value: 'Record a match between two other players', inline: false },
            { name: '!pool undo', value: 'Revert the last recorded match (seasonal & all-time)', inline: false },
            { name: '!pool rankings', value: 'Show current seasonal player rankings', inline: false },
            { name: '!pool alltimerankings', value: 'Show all-time player rankings', inline: false },
            { name: '!pool stats [@player]', value: 'Show your/mentioned player\'s seasonal stats (and all-time ELO)', inline: false },
            { name: '!pool mystats', value: 'Shows your detailed all-time statistics against every opponent.', inline: false },
	        { name: '!pool tournament [@player1 @player2...]', value: 'Generate a tournament bracket (uses seasonal ELOs)', inline: false },
            { name: '!pool breakerstats', value: 'Show statistics on how often the breaker wins (all-time)', inline: false },
	        { name: '!pool help', value: 'Show this help message', inline: false }
        )
        .setFooter({ text: 'Office Pool ELO System' });

    message.reply({ embeds: [embed] });
}

function randomChoice(arr) {
  if (!arr || arr.length === 0) return ""; 
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateSwedishPoolTournamentName() {
  const prefixes = ["Biljard", "Pool", "Kö", "Kritmagi", "Boll", "Klot", "Spel", "Hål", "Prick", "Rackare", "Klack", "Kant", "Stöt", "Krita", "Triangel", "Grön", "Snooker", "Vall", "Ficka", "Sänk", "Effekt", "Massé", "Vit", "Svart"];
  const suffixes = ["mästerskapet", "turneringen", "kampen", "utmaningen", "duellen", "spelandet", "striden", "fajten", "tävlingen", "bataljen", "kalaset", "festen", "smällen", "stöten", "bragden", "träffen", "mötet", "drabbningen", "uppgörelsen", "ligan", "cupen", "serien", "racet", "jippot", "spektaklet", "finalen", "derbyt"];
  const adjectives = ["Kungliga", "Magnifika", "Legendariska", "Otroliga", "Galna", "Vilda", "Episka", "Fantastiska", "Häftiga", "Glada", "Mäktiga", "Snabba", "Precisa", "Strategiska", "Oförglömliga", "Prestigefyllda", "Heta", "Svettiga", "Spännande", "Årliga", "Knivskarpa", "Ostoppbara", "Fruktade", "Ökända", "Hemliga", "Officiella", "Inofficiella", "Kollegiala", "Obarmhärtiga", "Avgörande"];
  const puns = ["Kö-los Före Resten", "Boll-i-gare Än Andra", "Stöt-ande Bra Spel", "Hål-i-ett Sällskap", "Krit-iskt Bra", "Rack-a Ner På Motståndaren", "Klot-rent Mästerskap", "Kant-astiskt Spel", "Prick-säkra Spelare", "Tri-angel-utmaningen", "Kö-a För Segern", "Boll-virtuoserna", "Grön-saksodlare På Bordet", "Snooker-sväng Med Stil", "Stöt-i-rätt-hålet", "Klack-sparkarnas Kamp", "Krit-a På Näsan", "Rena Sänk-ningen", "Rack-a-rökare", "Helt Vall-galet", "Fick-lampornas Kamp", "Effekt-sökarna", "Värsta Vit-ingarna", "Svart-listade Spelare", "Triangel-dramat", "Krit-erianerna", "Boll-änska Ligan", "Måndags-Massé", "Fredags-Fajten", "Team-Stöten", "Projekt Pool", "Excel-lent Spel", "Kod & Klot", "Kaffe & Krita", "Fika & Fickor", "Vall-öften", "Stöt-tålig Personal", "Inga Sura Miner, Bara Sura Stötar"];
  const locations = ["i Kungsbacka", "från Kungsbackaskogarna", "vid Kungsbackaån", "på Kungsbacka Torg", "i Göteborg", "på Hisingen", "vid Älvsborgsbron", "i Majorna", "i Götet", "på Västkusten", "i Halland", "vid Tjolöholm", "i Onsala", "i Fjärås", "i Anneberg", "runt Liseberg", "vid Feskekörka", "i Kontoret", "på Jobbet", "i Fikarummet", "vid Kaffeautomaten", "i Mötesrummet", "vid Skrivaren", "på Lagret", "i Källaren"];
  const nameStyles = [
    () => `Det ${randomChoice(adjectives)} ${randomChoice(prefixes)}${randomChoice(suffixes)}`,
    () => `${randomChoice(prefixes)}${randomChoice(suffixes)} ${randomChoice(locations)}`,
    () => `${randomChoice(puns)}`,
    () => `${new Date().getFullYear()} års ${randomChoice(prefixes)}${randomChoice(suffixes)}`,
    () => `${randomChoice(prefixes)}-${randomChoice(prefixes)} ${randomChoice(suffixes)}`,
    () => `Den ${randomChoice(adjectives)} ${randomChoice(puns)}`,
    () => `${randomChoice(puns)} ${randomChoice(locations)}`
  ];
  const generatedName = randomChoice(nameStyles)();
  return generatedName.toUpperCase();
}

// --- Client Event Handlers ---

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await initializeAllTimeDatabase();
    try {
        await ensureCurrentSeasonDb();
    } catch (e) {
        console.error("CRITICAL: Could not initialize seasonal database on startup.", e);
    }
    console.log("Bot is ready and databases are initialized/checked.");
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith('!pool')) return;
    const args = message.content.slice(5).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    try {
        // Most commands need the seasonal DB. We can check for the few that don't.
        if (command !== 'help' && command !== 'alltimerankings' && command !== 'mystats' && command !== 'breakerstats') {
             await ensureCurrentSeasonDb();
        }
        switch (command) {
            case 'register': await registerPlayer(message, args); break;
            case 'match': await recordMatch(message, args); break;
            case 'adminmatch': await recordAdminMatch(message, args); break;
            case 'undo': await undoLastMatch(message); break;
            case 'rankings': await showRankings(message); break;
            case 'alltimerankings': await showAllTimeRankings(message); break;
            case 'stats': await showPlayerStats(message, args); break;
            case 'mystats': await showMyStats(message); break;
            case 'tournament': await generateTournament(message, args); break;
            case 'breakerstats': await showBreakerStats(message); break;
            case 'help': await showHelp(message); break;
            default: message.reply('Unknown command. Type `!pool help` for a list of commands.');
        }
    } catch (error) {
        console.error(`Error handling command '!pool ${command}':`, error);
        message.reply('There was an error processing your command. Please check the bot logs.');
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || !interaction.customId.startsWith('break_')) return;

    try {
        await ensureCurrentSeasonDb();

        const [, winnerId, loserId, matchTimestamp, who] = interaction.customId.split('_');
        const breakerId = who === 'winner' ? winnerId : loserId;

        // Find the match in the seasonal database using the timestamp
        let seasonalMatches = await currentSeasonDb.getData('/matches');
        const matchIndex = seasonalMatches.findIndex(m => m.timestamp === matchTimestamp);

        if (matchIndex === -1) {
            // It's possible the button is clicked after a new season started and the match is no longer in the current seasonal DB.
            // We'll just update the all-time record in that case.
            console.log(`Breaker button: Match ${matchTimestamp} not found in current seasonal DB. Checking all-time.`);
        } else {
            seasonalMatches[matchIndex].breakerId = breakerId;
            await currentSeasonDb.push('/matches', seasonalMatches);
        }

        // Also update the all-time match record
        let allTimeMatches = await allTimeDb.getData('/matches');
        const allTimeMatchIndex = allTimeMatches.findIndex(m => m.timestamp === matchTimestamp);
        if (allTimeMatchIndex !== -1) {
            allTimeMatches[allTimeMatchIndex].breakerId = breakerId;
            await allTimeDb.push('/matches', allTimeMatches);
        } else {
             await interaction.reply({ content: 'Could not find the original match in the all-time records to update.', ephemeral: true });
             return;
        }

        const breakerPlayer = await getPlayer(breakerId, allTimeDb);
        const breakerPlayerName = breakerPlayer ? breakerPlayer.name : 'The breaker';

        await interaction.update({
            content: `**Breaker:** ${interaction.user.username} selected **${breakerPlayerName}** as the breaker for the match.`,
            components: []
        });
    } catch (error) {
        console.error("Error handling break button interaction:", error);
        await interaction.reply({ content: 'There was an error processing this action.', ephemeral: true });
    }
});

client.login(process.env.TOKEN);

