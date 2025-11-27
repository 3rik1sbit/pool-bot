// rebuild_all_time.js
// A script to rebuild the all-time ELO database from seasonal database files.
// This version standardizes on using 'timestamp' as the unique match identifier.

const fs = require('fs');
const path = require('path');
const { JsonDB, Config } = require('node-json-db');

// --- CONFIGURATION ---
// The prefix of your seasonal database files.
const SEASONAL_DB_PREFIX = 'poolEloDatabase_';
// The name of the NEW all-time database file that will be created.
const NEW_ALL_TIME_DB_NAME = 'poolEloDatabase_REBUILT';
// The name of your original all-time database (for fetching player names).
const ORIGINAL_ALL_TIME_DB_NAME = 'poolEloDatabase';

const DEFAULT_ELO = 1000;
const K_FACTOR = 32;

// --- ELO Calculation Logic (copied from your bot) ---
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

async function runRebuild() {
    console.log('Starting the all-time database rebuild process...');

    const directory = '.';
    let allMatches = [];
    const allPlayersInfo = new Map(); // To store the latest name for each player ID

    // --- Step 1: Read all seasonal database files ---
    try {
        const files = fs.readdirSync(directory);
        const seasonalFiles = files.filter(file =>
            file.startsWith(SEASONAL_DB_PREFIX) && file.endsWith('.json')
        );

        if (seasonalFiles.length === 0) {
            console.error('No seasonal database files found. Make sure they are in the same directory as this script.');
            return;
        }

        console.log(`Found ${seasonalFiles.length} seasonal files to process.`);

        for (const file of seasonalFiles) {
            console.log(`- Processing ${file}...`);
            const data = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf-8'));
            if (data.matches && Array.isArray(data.matches)) {
                // Clean up the match object as we collect it
                const cleanedMatches = data.matches.map(match => {
                    // Ensure timestamp exists, using matchId as a fallback if necessary
                    const timestamp = match.timestamp || match.matchId;
                    const { matchId, ...rest } = match; // Destructure to remove matchId
                    return { ...rest, timestamp }; // Return the object with a guaranteed timestamp
                });
                allMatches.push(...cleanedMatches);
            }
            if (data.players) {
                for (const playerId in data.players) {
                    allPlayersInfo.set(playerId, data.players[playerId].name);
                }
            }
        }
    } catch (error) {
        console.error('Error reading seasonal files:', error);
        return;
    }

    // --- Step 1.5: Get player names from original all-time DB as a fallback ---
    try {
        const originalAllTimeFile = `${ORIGINAL_ALL_TIME_DB_NAME}.json`;
        if (fs.existsSync(originalAllTimeFile)) {
             const data = JSON.parse(fs.readFileSync(path.join(directory, originalAllTimeFile), 'utf-8'));
             if (data.players) {
                 for (const playerId in data.players) {
                     if (!allPlayersInfo.has(playerId)) {
                         allPlayersInfo.set(playerId, data.players[playerId].name);
                     }
                 }
             }
             console.log('Successfully loaded player names from original all-time DB.');
        }
    } catch (error) {
        console.warn('Could not read original all-time DB for player names, will rely only on seasonal data.', error.message);
    }


    // --- Step 2: Sort all matches chronologically ---
    allMatches.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    console.log(`Total matches collected and sorted: ${allMatches.length}`);

    // --- Step 3: Re-calculate all stats from scratch ---
    const newAllTimePlayers = {};

    for (const match of allMatches) {
        const { winnerId, loserId } = match;

        // Initialize players if they don't exist
        if (!newAllTimePlayers[winnerId]) {
            newAllTimePlayers[winnerId] = {
                id: winnerId,
                name: allPlayersInfo.get(winnerId) || `Player_${winnerId}`,
                elo: DEFAULT_ELO,
                wins: 0,
                losses: 0,
                matches: []
            };
        }
        if (!newAllTimePlayers[loserId]) {
            newAllTimePlayers[loserId] = {
                id: loserId,
                name: allPlayersInfo.get(loserId) || `Player_${loserId}`,
                elo: DEFAULT_ELO,
                wins: 0,
                losses: 0,
                matches: []
            };
        }

        const winner = newAllTimePlayers[winnerId];
        const loser = newAllTimePlayers[loserId];

        // Calculate ELO based on their current all-time rating
        const eloResult = calculateElo(winner.elo, loser.elo);

        // Update player stats
        winner.elo = eloResult.newWinnerElo;
        winner.wins++;
        winner.matches.push({
            opponent: loserId,
            result: 'win',
            eloChange: eloResult.winnerGain,
            timestamp: match.timestamp
        });

        loser.elo = eloResult.newLoserElo;
        loser.losses++;
        loser.matches.push({
            opponent: winnerId,
            result: 'loss',
            eloChange: -eloResult.loserLoss,
            timestamp: match.timestamp
        });

        // IMPORTANT: Update the match object with the re-calculated ELO changes
        match.winnerGain = eloResult.winnerGain;
        match.loserLoss = eloResult.loserLoss;
    }

    console.log('All matches re-processed and stats re-calculated.');

    // --- Step 4: Write to the new database file ---
    try {
        const newDb = new JsonDB(new Config(NEW_ALL_TIME_DB_NAME, true, true, '/'));
        await newDb.push('/players', newAllTimePlayers);
        await newDb.push('/matches', allMatches);
        console.log(`\n✅ Success! Rebuilt database has been saved to '${NEW_ALL_TIME_DB_NAME}.json'`);
    } catch (error) {
        console.error('Failed to write the new database file:', error);
    }
}

// Run the main function
runRebuild();

