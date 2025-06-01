// Discord Pool ELO Bot
// Required packages: discord.js, dotenv, node-json-db

// Install packages with:
// npm install discord.js dotenv node-json-db

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Collection } = require('discord.js'); // Added Collection for potential future use
const { JsonDB, Config } = require('node-json-db');
const { DataError } = require('node-json-db/dist/lib/Errors'); // Import DataError for specific error handling

// --- Database Configuration ---
const ALL_TIME_DB_NAME = "poolEloDatabase";
const DEFAULT_ELO = 1000;
const K_FACTOR = 32; // How quickly ratings change
 
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
let currentSeasonDb = null; // Will hold the JsonDB instance for the current season

// --- Helper Functions for Seasonal Database ---

function getSeasonDbPath(date = new Date()) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0'); // Ensure two digits for month
    return `${ALL_TIME_DB_NAME}_${year}_${month}`;
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
        return currentSeasonDb; // Already connected to the correct season DB
    }

    console.log(`Attempting to load or initialize seasonal database: ${seasonDbPath}`);
    currentSeasonDb = new JsonDB(new Config(seasonDbPath, true, false, '/'));
    currentSeasonDb.db_name = seasonDbPath; // Store the path for checking

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
            throw error; // Rethrow if it's not a DataError (e.g. file system issue)
        }
    }
    return currentSeasonDb;
}


// Calculate new ELO ratings after a match
function calculateElo(winnerElo, loserElo) {
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));

    const newWinnerElo = Math.round(winnerElo + K_FACTOR * (1 - expectedWinner));
    const newLoserElo = Math.round(loserElo + K_FACTOR * (0 - expectedLoser));

    return {
        newWinnerElo,
        newLoserElo,
        winnerGain: newWinnerElo - winnerElo,
        loserLoss: loserElo - newLoserElo
    };
}

// Helper function to get player data from a specific DB
async function getPlayer(playerId, dbInstance) {
    try {
        return await dbInstance.getData(`/players/${playerId}`);
    } catch (error) {
        return null;
    }
}

// Undo last match (now considers both databases)
async function undoLastMatch(message) {
    try {
        await ensureCurrentSeasonDb();

        // --- Undo Seasonal Match ---
        const seasonalMatches = await currentSeasonDb.getData('/matches');
        if (!seasonalMatches || seasonalMatches.length === 0) {
            return message.reply('No matches found in the current season to undo.');
        }
        const lastSeasonalMatch = seasonalMatches.pop();

        const seasonalWinner = await getPlayer(lastSeasonalMatch.winnerId, currentSeasonDb);
        const seasonalLoser = await getPlayer(lastSeasonalMatch.loserId, currentSeasonDb);

        if (!seasonalWinner || !seasonalLoser) {
            // This might happen if a player was somehow removed from seasonal DB
            // or if the match data is corrupt. For robustness, try to restore from all-time.
            await currentSeasonDb.push('/matches', seasonalMatches); // Put it back if we can't process
            return message.reply('Could not find players from the last seasonal match. Seasonal data might be inconsistent.');
        }
        
        const sWinnerName = seasonalWinner.name; // Store before potential modification if name changes allowed
        const sLoserName = seasonalLoser.name;
        const sWinnerOldElo = seasonalWinner.elo + lastSeasonalMatch.winnerGain; // Correctly calculate original ELO
        const sLoserOldElo = seasonalLoser.elo - lastSeasonalMatch.loserLoss;   // Correctly calculate original ELO


        seasonalWinner.elo = seasonalWinner.elo - lastSeasonalMatch.winnerGain; // Revert ELO
        seasonalLoser.elo = seasonalLoser.elo + lastSeasonalMatch.loserLoss;   // Revert ELO
        seasonalWinner.wins--;
        seasonalLoser.losses--;
        seasonalWinner.matches = seasonalWinner.matches.filter(match => match.timestamp !== lastSeasonalMatch.timestamp);
        seasonalLoser.matches = seasonalLoser.matches.filter(match => match.timestamp !== lastSeasonalMatch.timestamp);

        await currentSeasonDb.push(`/players/${seasonalWinner.id}`, seasonalWinner);
        await currentSeasonDb.push(`/players/${seasonalLoser.id}`, seasonalLoser);
        await currentSeasonDb.push('/matches', seasonalMatches);

        // --- Undo All-Time Match ---
        // Find the corresponding all-time match using matchId (timestamp)
        let allTimeMatches = await allTimeDb.getData('/matches');
        const allTimeMatchIndex = allTimeMatches.findIndex(m => m.matchId === lastSeasonalMatch.matchId);

        if (allTimeMatchIndex === -1) {
            // This is a critical inconsistency. Log it and inform user.
            // The seasonal match was undone, but the all-time couldn't be found.
            console.error(`CRITICAL: Could not find all-time match with ID ${lastSeasonalMatch.matchId} to undo.`);
            message.reply(`Seasonal match reverted. However, the corresponding all-time match (ID: ${lastSeasonalMatch.matchId}) could not be found and undone. Please check manually.`);
             // Send seasonal confirmation anyway, as that part worked
            const embedSeasonalOnly = new EmbedBuilder()
                .setTitle('Seasonal Match Reverted (All-Time Error)')
                .setColor('#FFA500') // Orange for warning
                .setDescription(`The last seasonal match has been reverted. Corresponding all-time match NOT found.`)
                .addFields(
                    { name: 'Reverted Seasonal Match', value: `${sWinnerName} vs ${sLoserName}`, inline: false },
                    { name: `${sWinnerName} (Season)`, value: `${sWinnerOldElo} → ${seasonalWinner.elo} (-${lastSeasonalMatch.winnerGain} ELO)`, inline: true },
                    { name: `${sLoserName} (Season)`, value: `${sLoserOldElo} → ${seasonalLoser.elo} (+${lastSeasonalMatch.loserLoss} ELO)`, inline: true }
                )
                .setFooter({ text: 'Office Pool ELO System - Partial Undo' });
            message.channel.send({ embeds: [embedSeasonalOnly] }); // Use channel.send if reply was already used.
            return;
        }

        const lastAllTimeMatch = allTimeMatches[allTimeMatchIndex];
        allTimeMatches.splice(allTimeMatchIndex, 1); // Remove the match

        const allTimeWinner = await getPlayer(lastAllTimeMatch.winnerId, allTimeDb);
        const allTimeLoser = await getPlayer(lastAllTimeMatch.loserId, allTimeDb);

        if (!allTimeWinner || !allTimeLoser) {
             // This shouldn't happen if they were in the match, but good to check.
            console.error(`CRITICAL: Players from all-time match ID ${lastAllTimeMatch.matchId} not found in all-time DB.`);
            // At this point, seasonal is undone, all-time match entry is removed, but player stats can't be updated.
            // This is a partial failure.
            await allTimeDb.push('/matches', allTimeMatches); // Save the modified matches list
            message.reply(`Seasonal match reverted. All-time match entry removed. However, player data for all-time (ID: ${lastAllTimeMatch.matchId}) could not be fully reverted. Please check manually.`);
            return;
        }

        allTimeWinner.elo -= lastAllTimeMatch.winnerGain;
        allTimeLoser.elo += lastAllTimeMatch.loserLoss;
        allTimeWinner.wins--;
        allTimeLoser.losses--;
        allTimeWinner.matches = allTimeWinner.matches.filter(match => match.timestamp !== lastAllTimeMatch.timestamp); // Or match.matchId
        allTimeLoser.matches = allTimeLoser.matches.filter(match => match.timestamp !== lastAllTimeMatch.timestamp); // Or match.matchId

        await allTimeDb.push(`/players/${allTimeWinner.id}`, allTimeWinner);
        await allTimeDb.push(`/players/${allTimeLoser.id}`, allTimeLoser);
        await allTimeDb.push('/matches', allTimeMatches);

        // Send confirmation (reflecting seasonal changes primarily)
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


// Register a new player
async function registerPlayer(message, args) {
    if (args.length < 1) {
        return message.reply('Please provide a name. Usage: `!pool register YourName`');
    }

    const playerName = args.join(' ');
    const playerId = message.author.id;

    await ensureCurrentSeasonDb(); // Ensure seasonal DB is ready

    // Register in All-Time DB
    let existingAllTimePlayer = await getPlayer(playerId, allTimeDb);
    if (existingAllTimePlayer) {
        message.reply(`You are already registered in the all-time records as ${existingAllTimePlayer.name}.`);
    } else {
        const allTimePlayerData = {
            id: playerId, name: playerName, elo: DEFAULT_ELO,
            wins: 0, losses: 0, matches: []
        };
        await allTimeDb.push(`/players/${playerId}`, allTimePlayerData);
        message.channel.send(`Successfully registered **${playerName}** for all-time records with ELO ${DEFAULT_ELO}.`);
    }

    // Register in Seasonal DB
    let existingSeasonalPlayer = await getPlayer(playerId, currentSeasonDb);
    if (existingSeasonalPlayer) {
        // If they exist in seasonal, it means they were copied at season start or registered earlier this season
        message.channel.send(`You are already part of the current season (${existingSeasonalPlayer.name}, ELO: ${existingSeasonalPlayer.elo}).`);
    } else {
        // New to this season (either new player entirely, or joined mid-season after being in all-time)
        const seasonalPlayerData = {
            id: playerId, name: playerName, elo: DEFAULT_ELO, // All players start season with default ELO
            wins: 0, losses: 0, matches: []
        };
        await currentSeasonDb.push(`/players/${playerId}`, seasonalPlayerData);
        message.channel.send(`Added **${playerName}** to the current season with ELO ${DEFAULT_ELO}.`);
    }
}

// Record match result
async function recordMatch(message, args) {
    if (args.length < 1) {
        return message.reply('Please mention the player you defeated. Usage: `!pool match @opponent`');
    }

    await ensureCurrentSeasonDb(); // Crucial for getting seasonal data

    const winnerId = message.author.id;
    const mention = message.mentions.users.first();
    if (!mention) {
        return message.reply('Please mention the player you defeated.');
    }
    const loserId = mention.id;

    if (winnerId === loserId) {
        return message.reply('You cannot play against yourself.');
    }

    // Get players from both databases
    let seasonWinner = await getPlayer(winnerId, currentSeasonDb);
    let seasonLoser = await getPlayer(loserId, currentSeasonDb);
    let allTimeWinner = await getPlayer(winnerId, allTimeDb);
    let allTimeLoser = await getPlayer(loserId, allTimeDb);

    // Ensure players are registered (especially for seasonal, they might need to be added if it's their first game of season)
    if (!allTimeWinner) return message.reply('You (winner) need to register first with `!pool register YourName`.');
    if (!allTimeLoser) return message.reply(`The player you mentioned (loser) is not registered yet (all-time).`);

    // If players exist in all-time but not season (e.g. first game of new season for them), create seasonal entry
    if (!seasonWinner) {
        seasonWinner = { id: winnerId, name: allTimeWinner.name, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await currentSeasonDb.push(`/players/${winnerId}`, seasonWinner);
    }
    if (!seasonLoser) {
        seasonLoser = { id: loserId, name: allTimeLoser.name, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await currentSeasonDb.push(`/players/${loserId}`, seasonLoser);
    }
    
    const matchTimestamp = new Date().toISOString(); // Unique ID for the match

    // --- Seasonal ELO Calculation & Update ---
    const seasonalEloResult = calculateElo(seasonWinner.elo, seasonLoser.elo);
    seasonWinner.elo = seasonalEloResult.newWinnerElo;
    seasonWinner.wins++;
    seasonWinner.matches.push({
        opponent: loserId, result: 'win', eloChange: seasonalEloResult.winnerGain, timestamp: matchTimestamp
    });
    seasonLoser.elo = seasonalEloResult.newLoserElo;
    seasonLoser.losses++;
    seasonLoser.matches.push({
        opponent: winnerId, result: 'loss', eloChange: -seasonalEloResult.loserLoss, timestamp: matchTimestamp
    });
    const seasonalMatchData = {
        winnerId, loserId, winnerElo: seasonWinner.elo, loserElo: seasonLoser.elo,
        winnerGain: seasonalEloResult.winnerGain, loserLoss: seasonalEloResult.loserLoss,
        timestamp: matchTimestamp, matchId: matchTimestamp
    };
    await currentSeasonDb.push(`/players/${winnerId}`, seasonWinner);
    await currentSeasonDb.push(`/players/${loserId}`, seasonLoser);
    await currentSeasonDb.push('/matches[]', seasonalMatchData, true); // Append to matches array

    // --- All-Time ELO Calculation & Update ---
    const allTimeEloResult = calculateElo(allTimeWinner.elo, allTimeLoser.elo);
    allTimeWinner.elo = allTimeEloResult.newWinnerElo;
    allTimeWinner.wins++; // Increment all-time wins as well
    allTimeWinner.matches.push({
        opponent: loserId, result: 'win', eloChange: allTimeEloResult.winnerGain, timestamp: matchTimestamp
    });
    allTimeLoser.elo = allTimeEloResult.newLoserElo;
    allTimeLoser.losses++; // Increment all-time losses
    allTimeLoser.matches.push({
        opponent: winnerId, result: 'loss', eloChange: -allTimeEloResult.loserLoss, timestamp: matchTimestamp
    });
    const allTimeMatchData = {
        winnerId, loserId, winnerElo: allTimeWinner.elo, loserElo: allTimeLoser.elo,
        winnerGain: allTimeEloResult.winnerGain, loserLoss: allTimeEloResult.loserLoss,
        timestamp: matchTimestamp, matchId: matchTimestamp // Same matchId
    };
    await allTimeDb.push(`/players/${winnerId}`, allTimeWinner);
    await allTimeDb.push(`/players/${loserId}`, allTimeLoser);
    await allTimeDb.push('/matches[]', allTimeMatchData, true); // Append to matches array


    // Send confirmation (seasonal focus)
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
        new ButtonBuilder()
            .setCustomId(`break_${winnerId}_${loserId}_${matchTimestamp}_winner`)
            .setLabel(seasonWinner.name) // Use seasonal name, likely same
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`break_${winnerId}_${loserId}_${matchTimestamp}_loser`)
            .setLabel(seasonLoser.name)
            .setStyle(ButtonStyle.Secondary)
    );

    message.reply({
        embeds: [embed],
        components: [row],
        content: '**Breaker:** Select who made the break shot for this match.'
    });
}

// Show current (seasonal) rankings
async function showRankings(message) {
    try {
        await ensureCurrentSeasonDb();
        const players = await currentSeasonDb.getData('/players');

        if (Object.keys(players).length === 0) {
            return message.reply('No players are registered in the current season yet.');
        }

        const rankedPlayers = Object.values(players).sort((a, b) => b.elo - a.elo);

        const embed = new EmbedBuilder()
            .setTitle(`Office Pool Rankings (Current Season: ${getSeasonDbPath().split('_').slice(1).join('/')})`)
            .setColor('#0099FF')
            .setFooter({ text: 'Office Pool ELO System - Seasonal Rankings' });

        rankedPlayers.slice(0, 10).forEach((player, index) => {
            embed.addFields({
                name: `#${index + 1} ${player.name}`,
                value: `ELO: ${player.elo} | W: ${player.wins} | L: ${player.losses}`,
                inline: false
            });
        });

        message.reply({ embeds: [embed] });
    } catch (error) {
        console.error('Error showing seasonal rankings:', error);
        message.reply('Error retrieving seasonal rankings.');
    }
}

// Show All-Time rankings
async function showAllTimeRankings(message) {
    try {
        const players = await allTimeDb.getData('/players');

        if (Object.keys(players).length === 0) {
            return message.reply('No players are registered for all-time records yet.');
        }

        const rankedPlayers = Object.values(players).sort((a, b) => b.elo - a.elo);

        const embed = new EmbedBuilder()
            .setTitle('Office Pool Rankings (All-Time)')
            .setColor('#DAA520') // Gold-ish color
            .setFooter({ text: 'Office Pool ELO System - All-Time Rankings' });

        rankedPlayers.slice(0, 10).forEach((player, index) => {
            embed.addFields({
                name: `#${index + 1} ${player.name}`,
                value: `ELO: ${player.elo} | W: ${player.wins} | L: ${player.losses}`,
                inline: false
            });
        });

        message.reply({ embeds: [embed] });
    } catch (error) {
        console.error('Error showing all-time rankings:', error);
        message.reply('Error retrieving all-time rankings.');
    }
}


// Show player stats (seasonal focus, with all-time ELO)
async function showPlayerStats(message, args) {
    try {
        await ensureCurrentSeasonDb();
        let playerId;

        if (message.mentions.users.size > 0) {
            playerId = message.mentions.users.first().id;
        } else {
            playerId = message.author.id;
        }

        const seasonPlayer = await getPlayer(playerId, currentSeasonDb);
        const allTimePlayer = await getPlayer(playerId, allTimeDb); // Fetch all-time for comparison

        if (!seasonPlayer && !allTimePlayer) { // If not in either, truly not registered
             return message.reply('This player is not registered in any records yet.');
        }
        if (!seasonPlayer) { // In all-time but not played this season
            return message.reply(`**${allTimePlayer.name}** is registered all-time (ELO: ${allTimePlayer.elo}) but has no stats for the current season yet.`);
        }


        const embed = new EmbedBuilder()
            .setTitle(`${seasonPlayer.name}'s Stats (Current Season)`)
            .setColor('#0099FF')
            .addFields(
                { name: 'Season ELO', value: `${seasonPlayer.elo}`, inline: true },
                { name: 'Season Wins', value: `${seasonPlayer.wins}`, inline: true },
                { name: 'Season Losses', value: `${seasonPlayer.losses}`, inline: true },
                { name: 'Season Win Rate', value: `${seasonPlayer.wins + seasonPlayer.losses > 0 ? Math.round((seasonPlayer.wins / (seasonPlayer.wins + seasonPlayer.losses)) * 100) : 0}%`, inline: true }
            )
            .setFooter({ text: 'Office Pool ELO System' });

        if (allTimePlayer) {
            embed.addFields({ name: 'All-Time ELO', value: `${allTimePlayer.elo}`, inline: true });
        }


        if (seasonPlayer.matches.length > 0) {
            const recentMatches = seasonPlayer.matches.slice(-5).reverse();
            let matchesText = '';

            for (const match of recentMatches) {
                // Opponent name should be fetched from seasonal DB, or all-time as fallback.
                // For simplicity here, we assume opponent is in seasonal or it's less critical for this display.
                let opponent = await getPlayer(match.opponent, currentSeasonDb);
                if (!opponent) opponent = await getPlayer(match.opponent, allTimeDb); // Fallback
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

        function nextPowerOf2(n) { /* ... (same as before) ... */ 
            let power = 1;
            while (power < n) {
                power *= 2;
            }
            return power;
        }
        function shuffleArray(array) { /* ... (same as before) ... */ 
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
        
        // ... (rest of subsequent rounds logic - same as before, just ensure player data comes from seasonal)
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
        // ---

        message.reply({ embeds: [embed] });

    } catch (error) {
        console.error('Error generating tournament:', error);
        message.reply(`An error occurred while generating the tournament bracket: ${error.message}`);
    }
}


// Show help message (add new alltimerankings command)
async function showHelp(message) {
    const embed = new EmbedBuilder()
        .setTitle('Office Pool ELO Bot Commands')
        .setColor('#0099FF')
        .setDescription('Here are the available commands:')
        .addFields(
            { name: '!pool register [name]', value: 'Register yourself as a player (for all-time and current season)', inline: false },
            { name: '!pool match @opponent', value: 'Record that you won a match (updates seasonal and all-time ELO)', inline: false },
            { name: '!pool undo', value: 'Revert the last recorded match (seasonal & all-time)', inline: false },
            { name: '!pool rankings', value: 'Show current seasonal player rankings', inline: false },
            { name: '!pool alltimerankings', value: 'Show all-time player rankings', inline: false }, // New command
            { name: '!pool stats [@player]', value: 'Show your/mentioned player\'s seasonal stats (and all-time ELO)', inline: false },
            { name: '!pool tournament [@player1 @player2...]', value: 'Generate a tournament bracket (uses seasonal ELOs)', inline: false },
            { name: '!pool help', value: 'Show this help message', inline: false }
        )
        .setFooter({ text: 'Office Pool ELO System' });

    message.reply({ embeds: [embed] });
}

// --- generateSwedishPoolTournamentName and randomChoice (same as before) ---
function randomChoice(arr) {
  if (!arr || arr.length === 0) {
    return ""; 
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateSwedishPoolTournamentName() {
  const prefixes = [
    "Biljard", "Pool", "Kö", "Kritmagi", "Boll", "Klot", "Spel", "Hål", "Prick",
    "Rackare", "Klack", "Kant", "Stöt", "Krita", "Triangel", "Grön", "Snooker",
    "Vall", "Ficka", "Sänk", "Effekt", "Massé", "Vit", "Svart"
  ];
  const suffixes = [
    "mästerskapet", "turneringen", "kampen", "utmaningen", "duellen", "spelandet",
    "striden", "fajten", "tävlingen", "bataljen", "kalaset", "festen", "smällen",
    "stöten", "bragden", "träffen", "mötet", "drabbningen", "uppgörelsen",
    "ligan", "cupen", "serien", "racet", "jippot", "spektaklet", "finalen", "derbyt"
  ];
  const adjectives = [
    "Kungliga", "Magnifika", "Legendariska", "Otroliga", "Galna", "Vilda", "Episka",
    "Fantastiska", "Häftiga", "Glada", "Mäktiga", "Snabba", "Precisa", "Strategiska",
    "Oförglömliga", "Prestigefyllda", "Heta", "Svettiga", "Spännande", "Årliga",
    "Knivskarpa", "Ostoppbara", "Fruktade", "Ökända", "Hemliga", "Officiella",
    "Inofficiella", "Kollegiala", "Obarmhärtiga", "Avgörande"
  ];
  const puns = [
    "Kö-los Före Resten", "Boll-i-gare Än Andra", "Stöt-ande Bra Spel",
    "Hål-i-ett Sällskap", "Krit-iskt Bra", "Rack-a Ner På Motståndaren",
    "Klot-rent Mästerskap", "Kant-astiskt Spel", "Prick-säkra Spelare",
    "Tri-angel-utmaningen", "Kö-a För Segern", "Boll-virtuoserna",
    "Grön-saksodlare På Bordet", "Snooker-sväng Med Stil",
    "Stöt-i-rätt-hålet", "Klack-sparkarnas Kamp", "Krit-a På Näsan",
    "Rena Sänk-ningen", "Rack-a-rökare", "Helt Vall-galet",
    "Fick-lampornas Kamp", "Effekt-sökarna", "Värsta Vit-ingarna",
    "Svart-listade Spelare", "Triangel-dramat", "Krit-erianerna",
    "Boll-änska Ligan", "Måndags-Massé", "Fredags-Fajten", "Team-Stöten",
    "Projekt Pool", "Excel-lent Spel", "Kod & Klot", "Kaffe & Krita",
    "Fika & Fickor", "Vall-öften", "Stöt-tålig Personal",
    "Inga Sura Miner, Bara Sura Stötar"
  ];
  const locations = [
    "i Kungsbacka", "från Kungsbackaskogarna", "vid Kungsbackaån",
    "på Kungsbacka Torg", "i Göteborg", "på Hisingen", "vid Älvsborgsbron",
    "i Majorna", "i Götet", "på Västkusten", "i Halland", "vid Tjolöholm",
    "i Onsala", "i Fjärås", "i Anneberg", "runt Liseberg", "vid Feskekörka",
    "i Kontoret", "på Jobbet", "i Fikarummet", "vid Kaffeautomaten",
    "i Mötesrummet", "vid Skrivaren", "på Lagret", "i Källaren"
  ];
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
    await initializeAllTimeDatabase(); // Initialize the main all-time DB
    try {
        await ensureCurrentSeasonDb(); // Also ensure the current seasonal DB is ready on startup
    } catch (e) {
        console.error("CRITICAL: Could not initialize seasonal database on startup.", e);
        // Depending on how critical this is, you might want to prevent the bot from fully operating
        // or notify an admin. For now, it will log the error.
    }
    console.log("Bot is ready and databases are initialized/checked.");
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!pool')) return;

    const args = message.content.slice(5).trim().split(/ +/); // Corrected slice index from 6 to 5
    const command = args.shift().toLowerCase();

    try {
        // Ensure seasonal DB is ready before any command that might need it.
        // Some commands might not need it, but this is a safe general approach.
        // For commands like 'help', this is not strictly necessary but harmless.
        if (command !== 'help') { // 'help' command doesn't interact with DBs
             await ensureCurrentSeasonDb();
        }

        switch (command) {
            case 'register':
                await registerPlayer(message, args);
                break;
            case 'match':
                await recordMatch(message, args);
                break;
            case 'undo':
                await undoLastMatch(message);
                break;
            case 'rankings':
                await showRankings(message);
                break;
            case 'alltimerankings': // New command
                await showAllTimeRankings(message);
                break;
            case 'stats':
                await showPlayerStats(message, args);
                break;
            case 'tournament':
                await generateTournament(message, args);
                break;
            case 'help':
                await showHelp(message);
                break;
            default:
                message.reply('Unknown command. Type `!pool help` for a list of commands.');
        }
    } catch (error) {
        console.error(`Error handling command '!pool ${command}':`, error);
        message.reply('There was an error processing your command. Please check the bot logs.');
    }
});


client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('break_')) return;

    try {
        await ensureCurrentSeasonDb(); // Breaker info pertains to a seasonal match

        const [, winnerId, loserId, matchTimestamp, who] = interaction.customId.split('_');
        let breakerId;
        if (who === 'winner') breakerId = winnerId;
        else if (who === 'loser') breakerId = loserId;
        else return; // Should not happen

        // Find the match in the *seasonal* database
        let seasonalMatches = await currentSeasonDb.getData('/matches');
        const matchIndex = seasonalMatches.findIndex(m => m.matchId === matchTimestamp);

        if (matchIndex === -1) {
            await interaction.reply({ content: 'Could not find the seasonal match to update breaker info.', ephemeral: true });
            return;
        }
        
        seasonalMatches[matchIndex].breakerId = breakerId;
        await currentSeasonDb.push('/matches', seasonalMatches); // Save updated matches array

        // Also update the all-time match record if you store breakerId there.
        // For now, assuming breakerId is primarily a seasonal match detail.
        // If you want it in all-time too, duplicate the find & update logic for allTimeDb.
        // let allTimeMatches = await allTimeDb.getData('/matches');
        // const allTimeMatchIndex = allTimeMatches.findIndex(m => m.matchId === matchTimestamp);
        // if (allTimeMatchIndex !== -1) {
        //     allTimeMatches[allTimeMatchIndex].breakerId = breakerId;
        //     await allTimeDb.push('/matches', allTimeMatches);
        // }


        const winnerPlayer = await getPlayer(winnerId, currentSeasonDb) || await getPlayer(winnerId, allTimeDb);
        const loserPlayer = await getPlayer(loserId, currentSeasonDb) || await getPlayer(loserId, allTimeDb);
        const breakerPlayerName = breakerId === winnerId ? winnerPlayer.name : loserPlayer.name;


        await interaction.update({
            content: `**Breaker:** ${interaction.user.username} selected **${breakerPlayerName}** as the breaker for match ID ${matchTimestamp.slice(-6)}.`,
            components: []
        });

    } catch (error) {
        console.error("Error handling break button interaction:", error);
        await interaction.reply({ content: 'There was an error processing this action.', ephemeral: true });
    }
});


// Login to Discord with your client's token
client.login(process.env.TOKEN);
