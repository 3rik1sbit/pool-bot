// Office Pool ELO Bot - Logic Service
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { JsonDB, Config } = require('node-json-db');
const { DataError } = require('node-json-db/dist/lib/Errors');
const axios = require('axios');

// --- CONFIGURATION ---
const PORT = 3005;
const DB_FOLDER = "poolDB";
const ALL_TIME_DB_NAME = `${DB_FOLDER}/poolEloDatabase`;
const DEFAULT_ELO = 1000;
const K_FACTOR = 32;
const NOTIFICATION_URL = 'http://localhost:3006/notify/match-recorded';

// --- Express App Setup ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Database Initialization ---
const allTimeDb = new JsonDB(new Config(ALL_TIME_DB_NAME, true, false, '/'));
let currentSeasonDb = null;

// --- Helper Functions ---
function getSeasonDbPath(date = new Date()) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    return `${DB_FOLDER}/poolEloDatabase_${year}_${month}`;
}

async function ensureCurrentSeasonDb() {
    const seasonDbPath = getSeasonDbPath();
    if (currentSeasonDb && currentSeasonDb.db_name === seasonDbPath) {
        return currentSeasonDb;
    }
    currentSeasonDb = new JsonDB(new Config(seasonDbPath, true, false, '/'));
    currentSeasonDb.db_name = seasonDbPath;

    try {
        await currentSeasonDb.getData("/players");
    } catch (error) {
        if (error instanceof DataError) {
            const allTimePlayers = await allTimeDb.getData("/players");
            const seasonalPlayers = {};
            for (const playerId in allTimePlayers) {
                seasonalPlayers[playerId] = {
                    id: allTimePlayers[playerId].id,
                    name: allTimePlayers[playerId].name,
                    elo: DEFAULT_ELO, wins: 0, losses: 0, matches: []
                };
            }
            await currentSeasonDb.push("/players", seasonalPlayers);
            await currentSeasonDb.push("/matches", []);
        } else { throw error; }
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

async function getPlayer(playerId, db) {
    try {
        return await db.getData(`/players/${playerId}`);
    } catch (error) {
        return null;
    }
}

// ... (Other helper functions like Swedish tournament name generator)
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
  return randomChoice(nameStyles)().toUpperCase();
}


// --- API Endpoints ---
app.post('/register', async (req, res) => {
    const { playerId, playerName } = req.body;
    if (!playerId || !playerName) return res.status(400).json({ error: 'Player ID and name are required.' });

    let response = { message: '', seasonalMessage: '' };
    const allTimePlayer = await getPlayer(playerId, allTimeDb);

    if (allTimePlayer) {
        response.message = `You are already registered in all-time records as ${allTimePlayer.name}.`;
    } else {
        const playerData = { id: playerId, name: playerName, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await allTimeDb.push(`/players/${playerId}`, playerData);
        response.message = `Successfully registered **${playerName}** for all-time records.`;
    }

    await ensureCurrentSeasonDb();
    const seasonPlayer = await getPlayer(playerId, currentSeasonDb);
    if (seasonPlayer) {
        response.seasonalMessage = `You are already part of the current season.`;
    } else {
        const seasonalData = { id: playerId, name: playerName, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
        await currentSeasonDb.push(`/players/${playerId}`, seasonalData);
        response.seasonalMessage = `Added **${playerName}** to the current season.`;
    }
    res.json(response);
});

app.post('/match', async (req, res) => {
    const { winnerId, loserId, source } = req.body; // <-- Added source
    if (winnerId === loserId) return res.status(400).json({ error: 'Winner and loser cannot be the same person.' });
    
    await ensureCurrentSeasonDb();
    
    let allTimeWinner = await getPlayer(winnerId, allTimeDb);
    let allTimeLoser = await getPlayer(loserId, allTimeDb);
    if (!allTimeWinner || !allTimeLoser) return res.status(404).json({ error: 'One or both players not registered in all-time records.' });
    
    let seasonWinner = await getPlayer(winnerId, currentSeasonDb);
    let seasonLoser = await getPlayer(loserId, currentSeasonDb);
    if (!seasonWinner) {
        seasonWinner = { id: winnerId, name: allTimeWinner.name, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
    }
    if (!seasonLoser) {
        seasonLoser = { id: loserId, name: allTimeLoser.name, elo: DEFAULT_ELO, wins: 0, losses: 0, matches: [] };
    }

    const matchTimestamp = new Date().toISOString();

    // Update seasonal
    const seasonalElo = calculateElo(seasonWinner.elo, seasonLoser.elo);
    seasonWinner.elo = seasonalElo.newWinnerElo;
    seasonWinner.wins++;
    seasonWinner.matches.push({ opponent: loserId, result: 'win', eloChange: seasonalElo.winnerGain, timestamp: matchTimestamp });
    seasonLoser.elo = seasonalElo.newLoserElo;
    seasonLoser.losses++;
    seasonLoser.matches.push({ opponent: winnerId, result: 'loss', eloChange: -seasonalElo.loserLoss, timestamp: matchTimestamp });
    const seasonalMatchData = { winnerId, loserId, winnerElo: seasonWinner.elo, loserElo: seasonLoser.elo, winnerGain: seasonalElo.winnerGain, loserLoss: seasonalElo.loserLoss, timestamp: matchTimestamp };
    await currentSeasonDb.push(`/players/${winnerId}`, seasonWinner);
    await currentSeasonDb.push(`/players/${loserId}`, seasonLoser);
    await currentSeasonDb.push('/matches[]', seasonalMatchData);

    // Update all-time
    const allTimeElo = calculateElo(allTimeWinner.elo, allTimeLoser.elo);
    allTimeWinner.elo = allTimeElo.newWinnerElo;
    allTimeWinner.wins++;
    allTimeWinner.matches.push({ opponent: loserId, result: 'win', eloChange: allTimeElo.winnerGain, timestamp: matchTimestamp });
    allTimeLoser.elo = allTimeElo.newLoserElo;
    allTimeLoser.losses++;
    allTimeLoser.matches.push({ opponent: winnerId, result: 'loss', eloChange: -allTimeElo.loserLoss, timestamp: matchTimestamp });
    const allTimeMatchData = { winnerId, loserId, winnerElo: allTimeWinner.elo, loserElo: allTimeLoser.elo, winnerGain: allTimeElo.winnerGain, loserLoss: allTimeElo.loserLoss, timestamp: matchTimestamp };
    await allTimeDb.push(`/players/${winnerId}`, allTimeWinner);
    await allTimeDb.push(`/players/${loserId}`, allTimeLoser);
    await allTimeDb.push('/matches[]', allTimeMatchData);
    
    const responseData = {
        seasonalResult: { winner: seasonWinner, loser: seasonLoser, elo: seasonalElo },
        allTimeResult: { winner: allTimeWinner, loser: allTimeLoser, elo: allTimeElo },
        timestamp: matchTimestamp
    };

    // Notify Discord Listener ONLY if not from Discord ---
    if (source !== 'discord') {
        try {
       // HELPER: Remove the heavy match history to prevent 413 Payload Too Large errors
           const clean = (p) => {
               const { matches, ...rest } = p;
               return rest;
            };
	    // Create a lightweight payload for the notification service
            const notificationPayload = {
                seasonalResult: { 
                    winner: clean(seasonWinner), 
                    loser: clean(seasonLoser), 
                    elo: seasonalElo 
                },
                allTimeResult: { 
                    winner: clean(allTimeWinner), 
                    loser: clean(allTimeLoser), 
                    elo: allTimeElo 
                },
                timestamp: matchTimestamp
            };
	    await axios.post(NOTIFICATION_URL, notificationPayload);
            console.log(`Successfully sent notification for match ${matchTimestamp}`);
        } catch (error) {
            console.error(`Failed to send Discord notification for match ${matchTimestamp}. The match was still recorded. Error: ${error.message}`);
        }
    }

    res.json(responseData);
});

app.post('/match/breaker', async (req, res) => {
    const { matchTimestamp, breakerId } = req.body;
    if (!matchTimestamp || !breakerId) return res.status(400).json({ error: 'Timestamp and Breaker ID are required.' });
    
    try {
        await ensureCurrentSeasonDb();

        let allTimeMatches = await allTimeDb.getData('/matches');
        const allTimeMatchIndex = allTimeMatches.findIndex(m => m.timestamp === matchTimestamp);
        if (allTimeMatchIndex !== -1) {
            allTimeMatches[allTimeMatchIndex].breakerId = breakerId;
            await allTimeDb.push('/matches', allTimeMatches);
        } else {
             return res.status(404).json({ error: 'Match not found in all-time records.' });
        }

        let seasonalMatches = await currentSeasonDb.getData('/matches');
        const seasonalMatchIndex = seasonalMatches.findIndex(m => m.timestamp === matchTimestamp);
        if (seasonalMatchIndex !== -1) {
            seasonalMatches[seasonalMatchIndex].breakerId = breakerId;
            await currentSeasonDb.push('/matches', seasonalMatches);
        }
        
        res.json({ message: 'Breaker successfully recorded.' });
    } catch (error) {
        console.error("Error setting breaker:", error);
        res.status(500).json({ error: 'Failed to set breaker.' });
    }
});


app.post('/adminmatch', async (req, res) => {
    // This re-uses the /match logic after validating inputs
    const { winnerId, loserId, adminUsername } = req.body;
    if (!adminUsername) return res.status(400).json({ error: "Admin username is required." });
    
    // Call the same logic as a regular match
    app.handle({ method: 'POST', url: '/match', body: { winnerId, loserId } }, res);
});


app.post('/undo', async (req, res) => {
    try {
        await ensureCurrentSeasonDb();

        // Undo seasonal
        let seasonalMatches = await currentSeasonDb.getData('/matches');
        if (seasonalMatches.length === 0) throw new Error('No seasonal matches to undo.');
        const lastSeasonalMatch = seasonalMatches.pop();

        let sWinner = await getPlayer(lastSeasonalMatch.winnerId, currentSeasonDb);
        let sLoser = await getPlayer(lastSeasonalMatch.loserId, currentSeasonDb);

        const sWinnerOldElo = sWinner.elo + lastSeasonalMatch.winnerGain; // This is incorrect, should be current elo
        const sLoserOldElo = sLoser.elo - lastSeasonalMatch.loserLoss; // This is incorrect, should be current elo

        sWinner.elo -= lastSeasonalMatch.winnerGain;
        sLoser.elo += lastSeasonalMatch.loserLoss;
        sWinner.wins--;
        sLoser.losses--;
        sWinner.matches.pop();
        sLoser.matches.pop();
        
        await currentSeasonDb.push(`/players/${sWinner.id}`, sWinner);
        await currentSeasonDb.push(`/players/${sLoser.id}`, sLoser);
        await currentSeasonDb.push('/matches', seasonalMatches);

        // Undo all-time
        let allTimeMatches = await allTimeDb.getData('/matches');
        const allTimeMatchIndex = allTimeMatches.findIndex(m => m.timestamp === lastSeasonalMatch.timestamp);
        if (allTimeMatchIndex === -1) throw new Error('Could not find corresponding all-time match.');
        const lastAllTimeMatch = allTimeMatches.splice(allTimeMatchIndex, 1)[0];
        
        let aWinner = await getPlayer(lastAllTimeMatch.winnerId, allTimeDb);
        let aLoser = await getPlayer(lastAllTimeMatch.loserId, allTimeDb);

        const aWinnerOldElo = aWinner.elo + lastAllTimeMatch.winnerGain;
        const aLoserOldElo = aLoser.elo - lastAllTimeMatch.loserLoss;

        aWinner.elo -= lastAllTimeMatch.winnerGain;
        aLoser.elo += lastAllTimeMatch.loserLoss;
        aWinner.wins--;
        aLoser.losses--;
        aWinner.matches.pop();
        aLoser.matches.pop();
        
        await allTimeDb.push(`/players/${aWinner.id}`, aWinner);
        await allTimeDb.push(`/players/${aLoser.id}`, aLoser);
        await allTimeDb.push('/matches', allTimeMatches);
        
        res.json({
            seasonal: { winnerName: sWinner.name, loserName: sLoser.name, winnerOldElo: sWinner.elo + lastSeasonalMatch.winnerGain, loserOldElo: sLoser.elo - lastSeasonalMatch.loserLoss, winnerNewElo: sWinner.elo, loserNewElo: sLoser.elo, eloGain: lastSeasonalMatch.winnerGain, eloLoss: lastSeasonalMatch.loserLoss },
            allTime: { winnerName: aWinner.name, loserName: aLoser.name, winnerOldElo: aWinner.elo + lastAllTimeMatch.winnerGain, loserOldElo: aLoser.elo - lastAllTimeMatch.loserLoss, winnerNewElo: aWinner.elo, loserNewElo: aLoser.elo }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/rankings/:type', async (req, res) => {
    const { type } = req.params;
    const db = type === 'alltime' ? allTimeDb : await ensureCurrentSeasonDb();
    
    try {
        const players = await db.getData('/players');
        const activePlayers = Object.values(players).filter(p => (p.wins + p.losses) > 0);
        const rankedPlayers = activePlayers.sort((a, b) => b.elo - a.elo);
        
        let seasonName = null;
        if(type !== 'alltime') {
            const pathParts = getSeasonDbPath().split('_');
            seasonName = pathParts.slice(1).join('/');
        }
        
        res.json({ rankedPlayers, seasonName });
    } catch (error) {
        if (error instanceof DataError) {
             res.json({ rankedPlayers: [] }); // Send empty list if no players
        } else {
             res.status(500).json({ error: 'Failed to retrieve rankings.' });
        }
    }
});

app.get('/stats/player/:playerId', async (req, res) => {
    const { playerId } = req.params;
    await ensureCurrentSeasonDb();
    const seasonPlayer = await getPlayer(playerId, currentSeasonDb);
    const allTimePlayer = await getPlayer(playerId, allTimeDb);

    if (!allTimePlayer) return res.status(404).json({ error: 'Player not registered in all-time records.' });
    if (!seasonPlayer) return res.status(404).json({ error: 'Player has no stats for the current season.' });

    seasonPlayer.winRate = seasonPlayer.wins + seasonPlayer.losses > 0 ? Math.round((seasonPlayer.wins / (seasonPlayer.wins + seasonPlayer.losses)) * 100) : 0;
    
    const recentMatches = seasonPlayer.matches.slice(-5).reverse();
    let matchesText = '';
    const allPlayers = await currentSeasonDb.getData('/players');
    for (const match of recentMatches) {
        const opponentName = allPlayers[match.opponent]?.name || 'Unknown';
        const result = match.result === 'win' ? 'Won' : 'Lost';
        const eloChange = match.eloChange > 0 ? `+${match.eloChange}` : match.eloChange;
        const date = new Date(match.timestamp).toLocaleDateString();
        matchesText += `${result} vs ${opponentName} (ELO ${eloChange}) - ${date}\n`;
    }
    seasonPlayer.recentMatchesText = matchesText;
    
    res.json({ seasonPlayer, allTimePlayer });
});

app.get('/stats/mystats/:playerId', async (req, res) => {
     const { playerId } = req.params;
    try {
        const allPlayers = await allTimeDb.getData('/players');
        const player = allPlayers[playerId];
        if (!player) return res.status(404).json({ error: 'Player not found.' });

        const totalGames = player.wins + player.losses;
        const overallWinPercentage = totalGames > 0 ? ((player.wins / totalGames) * 100).toFixed(2) : 0;
        
        const opponentStats = {};
        player.matches.forEach(match => {
            if (!opponentStats[match.opponent]) {
                opponentStats[match.opponent] = { wins: 0, losses: 0, name: allPlayers[match.opponent]?.name || 'Unknown' };
            }
            if (match.result === 'win') opponentStats[match.opponent].wins++;
            else opponentStats[match.opponent].losses++;
        });

        let opponentStatsDescription = Object.entries(opponentStats)
            .sort(([,a],[,b]) => (b.wins+b.losses) - (a.wins+a.losses))
            .map(([,stats]) => `vs **${stats.name}**: ${stats.wins}W / ${stats.losses}L (${((stats.wins/(stats.wins+stats.losses))*100).toFixed(0)}%)`)
            .join('\n');
        
        res.json({ player, overallWinPercentage, opponentStatsDescription });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate detailed stats.' });
    }
});

app.get('/stats/breaker', async (req, res) => {
    try {
        const matches = await allTimeDb.getData('/matches');
        const allPlayers = await allTimeDb.getData('/players');
        
        let totalMatchesWithBreakerInfo = 0;
        let breakerWins = 0;
        const playerBreakCounts = {};
        const playerGamesWithBreakInfo = {};

        for (const match of matches) {
            if (match.breakerId) {
                totalMatchesWithBreakerInfo++;
                if (match.breakerId === match.winnerId) breakerWins++;
                
                playerBreakCounts[match.breakerId] = (playerBreakCounts[match.breakerId] || 0) + 1;
                playerGamesWithBreakInfo[match.winnerId] = (playerGamesWithBreakInfo[match.winnerId] || 0) + 1;
                playerGamesWithBreakInfo[match.loserId] = (playerGamesWithBreakInfo[match.loserId] || 0) + 1;
            }
        }
        
        const overallBreakerWinPercentage = totalMatchesWithBreakerInfo > 0 ? ((breakerWins / totalMatchesWithBreakerInfo) * 100).toFixed(2) : 0;
        
        const playerBreakStatsText = Object.keys(playerGamesWithBreakInfo)
            .map(playerId => {
                const timesBroke = playerBreakCounts[playerId] || 0;
                const totalGames = playerGamesWithBreakInfo[playerId];
                return {
                    name: allPlayers[playerId]?.name || 'Unknown',
                    percentage: (timesBroke / totalGames) * 100,
                    text: `• ${allPlayers[playerId]?.name || 'Unknown'}: Broke ${timesBroke} times (${((timesBroke / totalGames) * 100).toFixed(1)}% of their games)`
                };
            })
            .sort((a,b) => b.percentage - a.percentage)
            .map(stat => stat.text)
            .join('\n');

        res.json({ totalMatchesWithBreakerInfo, breakerWins, overallBreakerWinPercentage, playerBreakStatsText });
    } catch(error) {
        res.status(500).json({error: 'Failed to calculate breaker stats.'});
    }
});

app.post('/tournament', async (req, res) => {
    try {
        const { playerIds } = req.body; // Expects an array of Discord IDs
        await ensureCurrentSeasonDb();
        const seasonalPlayers = await currentSeasonDb.getData('/players');
        
        let playerList = playerIds && playerIds.length > 0
            ? playerIds.map(id => seasonalPlayers[id]).filter(Boolean)
            : Object.values(seasonalPlayers);
        
        if (playerList.length < 2) throw new Error('Not enough players for a tournament.');

        // Shuffle
        for (let i = playerList.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playerList[i], playerList[j]] = [playerList[j], playerList[i]];
        }

        const initialPlayerCount = playerList.length;
        const bracketSize = Math.pow(2, Math.ceil(Math.log2(initialPlayerCount)));
        const byeCount = bracketSize - initialPlayerCount;
        
        const round1Matches = [];
        let remainingPlayers = [...playerList];

        for (let i = 0; i < bracketSize / 2; i++) {
            const p1 = remainingPlayers.shift();
            const p2 = (i < byeCount) ? null : remainingPlayers.shift();
            round1Matches.push({ p1, p2 });
        }

        const tournamentName = generateSwedishPoolTournamentName();
        const round1MatchTexts = round1Matches.map((match, index) => {
            if (match.p2) {
                return {
                    name: `Match ${index + 1}`,
                    value: `**${match.p1.name}** (${match.p1.elo}) vs **${match.p2.name}** (${match.p2.elo})`
                };
            }
            return {
                name: `Match ${index + 1}`,
                value: `**${match.p1.name}** (${match.p1.elo}) - *Bye to next round*`
            };
        });

        // Subsequent rounds text generation can be complex, simplified for API
        const subsequentRoundsText = "Subsequent rounds will be determined by the winners of Round 1.";

        res.json({
            tournamentName,
            initialPlayerCount,
            bracketSize,
            byeCount,
            round1Matches: round1MatchTexts,
            subsequentRoundsText
        });

    } catch(error) {
        res.status(500).json({error: error.message});
    }
});

app.get('/seasons', (req, res) => {
    // This now correctly uses the existing DB_FOLDER constant
    const dbDirectory = path.join(__dirname, DB_FOLDER);
    const dbFileRegex = /^poolEloDatabase_(\d{4}_\d{2})\.json$/;

    fs.readdir(dbDirectory, (err, files) => {
        if (err) {
            console.error("Error reading database directory:", err);
            return res.status(500).json({ error: 'Unable to scan database directory.' });
        }

        const seasons = files
            .map(file => file.match(dbFileRegex))
            .filter(match => match !== null)
            .map(match => match[1]);

        seasons.sort().reverse();
        res.json(seasons);
    });
});

// --- Server Start ---
app.listen(PORT, '0.0.0.0', async () => {
    try {
        await allTimeDb.getData('/players');
    } catch(e) {
        if(e instanceof DataError) {
            await allTimeDb.push('/players', {});
            await allTimeDb.push('/matches', []);
        }
    }
    console.log(`ELO Logic Service running on http://0.0.0.0:${PORT}`);
});



