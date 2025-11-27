// Office Pool ELO Bot - Logic Service (Universal + Multi-Mode + Starter)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

// --- CONFIGURATION ---
const PORT = 3005;
const DEFAULT_ELO = 1000;
const K_FACTOR = 32;
const NOTIFICATION_URL = 'http://localhost:3006/notify/match-recorded';
const ALL_TIME_BOARD_NAME = "Office Pool (Legacy)"; 

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// --- CORE HELPERS ---

async function getSystemContext(allTimeBoardId) {
    const allTimeBoard = await prisma.leaderboard.findUnique({ where: { id: allTimeBoardId } });
    if (!allTimeBoard) throw new Error("Game System not found.");

    let baseName = allTimeBoard.name.replace(" (Legacy)", "").replace(" (All-Time)", "");
    if (baseName === "Office Pool") baseName = "Pool";

    const date = new Date();
    const seasonName = `${baseName} ${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;

    let seasonBoard = await prisma.leaderboard.findFirst({
        where: { name: seasonName, gameType: allTimeBoard.gameType }
    });

    if (!seasonBoard) {
        seasonBoard = await prisma.leaderboard.create({
            data: { 
                name: seasonName, 
                gameType: allTimeBoard.gameType,
                scoringType: allTimeBoard.scoringType,
                trackStarter: allTimeBoard.trackStarter
            }
        });
    }
    return { allTimeBoard, seasonBoard };
}

async function getOrCreatePlayer(leaderboardId, discordUserId, name) {
    let player = await prisma.player.findFirst({
        where: { leaderboardId: leaderboardId, discordUserId: discordUserId }
    });
    if (!player) {
        player = await prisma.player.create({
            data: { leaderboardId, discordUserId, name, elo: DEFAULT_ELO }
        });
    }
    return player;
}

// --- MATH ENGINE ---

function calculateMultiplayerElo(participants) {
    // participants: [{ id, elo, rank, team }]
    // rank: 1=1st, 2=2nd... Teams share ranks.
    
    // 1. Group by Team
    const teams = {};
    participants.forEach(p => {
        const teamKey = p.team !== undefined ? p.team : p.id;
        if (!teams[teamKey]) teams[teamKey] = { members: [], totalElo: 0, rank: p.rank };
        teams[teamKey].members.push(p);
        teams[teamKey].totalElo += p.elo;
    });

    const teamStats = Object.keys(teams).map(k => ({
        id: k,
        avgElo: teams[k].totalElo / teams[k].members.length,
        rank: teams[k].rank,
        eloChange: 0
    }));

    // 2. Pairwise Calculations
    const normalizedK = K_FACTOR / (teamStats.length - 1 || 1); 

    for (let i = 0; i < teamStats.length; i++) {
        for (let j = i + 1; j < teamStats.length; j++) {
            const teamA = teamStats[i];
            const teamB = teamStats[j];

            const expectedA = 1 / (1 + Math.pow(10, (teamB.avgElo - teamA.avgElo) / 400));
            
            let actualA;
            if (teamA.rank < teamB.rank) actualA = 1;      // A beat B
            else if (teamA.rank > teamB.rank) actualA = 0; // A lost to B
            else actualA = 0.5;                            // Draw

            const change = normalizedK * (actualA - expectedA);
            
            teamA.eloChange += change;
            teamB.eloChange -= change;
        }
    }

    // 3. Distribute
    const playerChanges = {};
    teamStats.forEach(t => {
        teams[t.id].members.forEach(p => {
            playerChanges[p.id] = Math.round(t.eloChange);
        });
    });

    return playerChanges;
}

// --- API ENDPOINTS ---

app.post('/leaderboard', async (req, res) => {
    const { name, scoringType, trackStarter } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required.' });

    try {
        const gameTypeUUID = `game_${Date.now()}`; 
        const allTimeBoard = await prisma.leaderboard.create({
            data: {
                name: `${name} (All-Time)`,
                gameType: gameTypeUUID,
                scoringType: scoringType || "1v1",
                trackStarter: trackStarter !== undefined ? trackStarter : true
            }
        });
        await getSystemContext(allTimeBoard.id); // Init season
        res.json(allTimeBoard);
    } catch (error) { res.status(500).json({ error: 'Failed to create system.' }); }
});

app.get('/leaderboards', async (req, res) => {
    try {
        const boards = await prisma.leaderboard.findMany({ orderBy: { createdAt: 'desc' } });
        const result = boards.map(b => ({
            id: b.id, name: b.name, isLegacy: b.name === ALL_TIME_BOARD_NAME, gameType: b.gameType
        }));
        result.sort((a, b) => { if (a.isLegacy) return -1; if (b.isLegacy) return 1; return 0; });
        res.json(result);
    } catch (error) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('/leaderboard/:id/seasons', async (req, res) => {
    const { id } = req.params;
    try {
        const rootBoard = await prisma.leaderboard.findUnique({ where: { id } });
        if(!rootBoard) return res.status(404).json({error: "Board not found"});
        
        const boards = await prisma.leaderboard.findMany({
            where: { gameType: rootBoard.gameType }, orderBy: { createdAt: 'desc' }
        });
        
        const allTime = boards.find(b => b.id === id || b.name.includes("(All-Time)") || b.name.includes("(Legacy)"));
        const seasons = boards.filter(b => b.id !== allTime?.id);
        res.json({ allTime, seasons });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/leaderboard/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Fetch Board Config
        const board = await prisma.leaderboard.findUnique({ where: { id } });
        const players = await prisma.player.findMany({ where: { leaderboardId: id }, orderBy: { elo: 'desc' } });
        
        // Include participants to support multi-player display
        const matches = await prisma.match.findMany({
            where: { leaderboardId: id },
            orderBy: { timestamp: 'desc' },
            take: 50,
            include: { participants: { include: { player: true } }, winner: true, loser: true }
        });

        const getStarterName = (starterId) => {
            if (!starterId) return null;
            const p = players.find(p => p.id === starterId);
            return p ? p.discordUserId : null; 
        };

        const formattedMatches = matches.map(m => {
            // Fallback for legacy 1v1 or standard view
            if (m.winnerId && m.loserId) {
                return {
                    winnerId: m.winner?.discordUserId,
                    loserId: m.loser?.discordUserId,
                    winnerGain: m.eloChange,
                    loserLoss: m.eloChange,
                    timestamp: m.timestamp,
                    result: 'win',
                    starterId: getStarterName(m.starterId) // Updated to starterId
                };
            } else {
                // Multi-player format
                return {
                    timestamp: m.timestamp,
                    isMulti: true,
                    starterId: getStarterName(m.starterId),
                    participants: m.participants.map(p => ({
                        name: p.player.name,
                        rank: p.rank,
                        eloChange: p.eloChange,
                        id: p.player.discordUserId
                    }))
                };
            }
        });

        const playerMap = {};
        players.forEach(p => playerMap[p.discordUserId] = { 
            id: p.discordUserId, internalId: p.id, name: p.name, elo: p.elo, wins: p.wins, losses: p.losses 
        });

        res.json({ 
            board: { trackStarter: board.trackStarter, scoringType: board.scoringType }, // Send config
            players: playerMap, 
            matches: formattedMatches 
        });
    } catch (error) { console.error(error); res.status(500).json({ error: 'Failed.' }); }
});

app.post('/leaderboard/:id/player', async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    try {
        const webId = `web_${Date.now()}`; 
        const newPlayer = await prisma.player.create({ data: { leaderboardId: id, discordUserId: webId, name, elo: DEFAULT_ELO } });
        res.json(newPlayer);
    } catch (error) { res.status(500).json({ error: "Failed." }); }
});

// --- MATCH RECORDING (UNIVERSAL) ---
app.post('/match', async (req, res) => {
    const { winnerId, loserId, participants, source, leaderboardId } = req.body;

    try {
        let systemId = leaderboardId;
        if (!systemId) {
            const legacy = await prisma.leaderboard.findFirst({ where: { name: ALL_TIME_BOARD_NAME } });
            systemId = legacy.id;
        }

        const { allTimeBoard, seasonBoard } = await getSystemContext(systemId);
        
        // FIX 1: Generate timestamp ONCE so both boards match perfectly
        const matchTimestamp = new Date(); 

        // 1. Convert inputs to participants array
        let inputParticipants = [];
        if (participants) {
            inputParticipants = participants;
        } else if (winnerId && loserId) {
            if (winnerId === loserId) return res.status(400).json({ error: 'Same player.' });
            inputParticipants = [ { id: winnerId, rank: 1, team: 1 }, { id: loserId, rank: 2, team: 2 } ];
        }

        // 2. Process Function
        const processBoard = async (board) => {
            const playerObjects = [];
            
            // Resolve Players
            for (const p of inputParticipants) {
                let dbPlayer = await prisma.player.findFirst({ where: { leaderboardId: board.id, discordUserId: p.id } });
                
                if (!dbPlayer && board.id === seasonBoard.id) {
                    const atPlayer = await prisma.player.findFirst({ where: { leaderboardId: allTimeBoard.id, discordUserId: p.id } });
                    if (atPlayer) dbPlayer = await getOrCreatePlayer(board.id, p.id, atPlayer.name);
                }
                if (!dbPlayer) throw new Error(`Player ${p.id} not found.`);
                playerObjects.push({ ...dbPlayer, rank: p.rank, team: p.team });
            }

            const mathInput = playerObjects.map(p => ({ id: p.id, elo: p.elo, rank: p.rank, team: p.team }));
            const eloChanges = calculateMultiplayerElo(mathInput);

            const participantRecords = [];
            for (const p of playerObjects) {
                const change = eloChanges[p.id];
                const isWin = p.rank === 1;
                await prisma.player.update({
                    where: { id: p.id },
                    data: { elo: p.elo + change, wins: isWin ? { increment: 1 } : undefined, losses: !isWin ? { increment: 1 } : undefined }
                });
                participantRecords.push({ playerId: p.id, rank: p.rank, startElo: p.elo, eloChange: change });
            }

            const match = await prisma.match.create({
                data: {
                    leaderboardId: board.id,
                    timestamp: matchTimestamp, // FIX 1: Use the shared timestamp
                    winnerId: inputParticipants.length === 2 ? playerObjects.find(p => p.rank===1).id : null,
                    loserId: inputParticipants.length === 2 ? playerObjects.find(p => p.rank===2).id : null,
                    winnerElo: inputParticipants.length === 2 ? playerObjects.find(p => p.rank===1).elo + eloChanges[playerObjects.find(p => p.rank===1).id] : null,
                    loserElo: inputParticipants.length === 2 ? playerObjects.find(p => p.rank===2).elo + eloChanges[playerObjects.find(p => p.rank===2).id] : null,
                    eloChange: inputParticipants.length === 2 ? Math.abs(eloChanges[playerObjects.find(p => p.rank===1).id]) : 0,
                    participants: { create: participantRecords }
                }
            });
            return { match };
        };

        const result = await processBoard(seasonBoard);
        await processBoard(allTimeBoard);

        if (source !== 'discord' && allTimeBoard.discordChannelId && inputParticipants.length === 2) {
             // (Keep notification logic)
        }

        res.json({ message: "Recorded", timestamp: matchTimestamp.toISOString() });

    } catch (error) { console.error(error); res.status(500).json({ error: error.message }); }
});

// 7. Set Starter (Universal)
app.post('/match/starter', async (req, res) => {
    // FIX 2: Accept leaderboardId
    const { matchTimestamp, starterId, leaderboardId } = req.body;
    if (!matchTimestamp || !starterId) return res.status(400).json({ error: 'Missing data.' });

    try {
        let systemId = leaderboardId;

        // Default to Legacy Pool if unknown (for Discord)
        if (!systemId) {
            const legacy = await prisma.leaderboard.findFirst({ where: { name: ALL_TIME_BOARD_NAME } });
            systemId = legacy.id;
        }

        const { allTimeBoard, seasonBoard } = await getSystemContext(systemId);

        const targetTime = new Date(matchTimestamp).getTime();
        const windowStart = new Date(targetTime - 1000);
        const windowEnd = new Date(targetTime + 1000);

        // Update All-Time
        const atStarter = await prisma.player.findFirst({ where: { leaderboardId: allTimeBoard.id, discordUserId: starterId } });
        let found = false;
        if (atStarter) {
            const m = await prisma.match.findFirst({ where: { leaderboardId: allTimeBoard.id, timestamp: { gte: windowStart, lte: windowEnd } } });
            if (m) { await prisma.match.update({ where: { id: m.id }, data: { starterId: atStarter.id } }); found = true; }
        }

        // Update Season
        const sStarter = await prisma.player.findFirst({ where: { leaderboardId: seasonBoard.id, discordUserId: starterId } });
        if (sStarter) {
            const m = await prisma.match.findFirst({ where: { leaderboardId: seasonBoard.id, timestamp: { gte: windowStart, lte: windowEnd } } });
            if (m) { await prisma.match.update({ where: { id: m.id }, data: { starterId: sStarter.id } }); found = true; }
        }

        if (found) return res.json({ message: 'Recorded.' });

        res.status(404).json({ error: 'Match not found.' });

    } catch (e) { res.status(500).json({ error: 'Failed.' }); }
});

// 8. Undo (Universal - Context Aware)
app.post('/undo', async (req, res) => {
    const { leaderboardId } = req.body; // <--- Accept the ID

    try {
        let systemId = leaderboardId;

        // Default to Legacy Pool if no ID provided (for Discord compatibility)
        if (!systemId) {
            const legacy = await prisma.leaderboard.findFirst({ where: { name: ALL_TIME_BOARD_NAME } });
            systemId = legacy.id;
        }

        // Use the helper to get the correct All-Time and Season boards for this system
        const { allTimeBoard, seasonBoard } = await getSystemContext(systemId);

        const undoLastMatch = async (boardId) => {
            const lastMatch = await prisma.match.findFirst({
                where: { leaderboardId: boardId }, orderBy: { timestamp: 'desc' },
                include: { participants: true, winner: true, loser: true }
            });
            if (!lastMatch) return null;

            if (lastMatch.participants.length > 0) {
                for (const p of lastMatch.participants) {
                    const isWin = p.rank === 1;
                    await prisma.player.update({
                        where: { id: p.playerId },
                        data: {
                            elo: { decrement: p.eloChange },
                            wins: isWin ? { decrement: 1 } : undefined,
                            losses: !isWin ? { decrement: 1 } : undefined
                        }
                    });
                }
            } else {
                // Legacy fallback
                const amount = lastMatch.eloChange || 0;
                await prisma.player.update({ where: { id: lastMatch.winnerId }, data: { elo: { decrement: amount }, wins: { decrement: 1 } } });
                await prisma.player.update({ where: { id: lastMatch.loserId }, data: { elo: { increment: amount }, losses: { decrement: 1 } } });
            }
            await prisma.match.delete({ where: { id: lastMatch.id } });
            return { winnerName: "Reverted", loserName: "Game" };
        };

        const sMatch = await undoLastMatch(seasonBoard.id);
        await undoLastMatch(allTimeBoard.id);

        if (!sMatch) return res.status(400).json({ error: "No matches to undo in this system." });
        res.json({ seasonal: { winnerName: "Reverted", loserName: "Match", eloGain: 0 }, allTime: {} });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ROBUST PLAYER STATS (With Starter Win %) ---
app.get('/leaderboard/:boardId/player/:playerId', async (req, res) => {
    const { boardId, playerId } = req.params;
    try {
        const player = await prisma.player.findFirst({ where: { leaderboardId: boardId, discordUserId: playerId } });
        if (!player) return res.status(404).json({ error: 'Player not found.' });

        const matches = await prisma.match.findMany({
            where: { 
                leaderboardId: boardId, 
                OR: [ { winnerId: player.id }, { loserId: player.id } ] 
            },
            orderBy: { timestamp: 'asc' },
            include: { winner: true, loser: true }
        });

        // --- STATS VARIABLES ---
        let netChange = 0;
        let starts = 0;      // Total times they started
        let winsOnStart = 0; // Total times they won when they started

        const cleanHistory = matches.map(m => {
            if (!m.winner || !m.loser) return null; 

            const isWin = m.winnerId === player.id;
            const change = isWin ? m.eloChange : -m.eloChange;
            netChange += change;

            // --- NEW: Starter Calculation ---
            if (m.starterId === player.id) {
                starts++;
                if (isWin) winsOnStart++;
            }

            return {
                timestamp: m.timestamp,
                eloChange: change,
                result: isWin ? 'win' : 'loss',
                opponent: isWin ? m.loser : m.winner
            };
        }).filter(m => m !== null);

        // Calculate Starter Win Rate
        const starterWinRate = starts > 0 ? Math.round((winsOnStart / starts) * 100) : 0;

        // --- STANDARD ELO REPLAY ---
        let runningElo = player.elo - netChange;
        let highestElo = runningElo;
        let lowestElo = runningElo;
        let currentStreak = 0;
        let streakType = null;
        const opponents = {};
        const graphData = [];

        for (const event of cleanHistory) {
            runningElo += event.eloChange;
            if (runningElo > highestElo) highestElo = runningElo;
            if (runningElo < lowestElo) lowestElo = runningElo;

            graphData.push({
                timestamp: event.timestamp,
                eloChange: event.eloChange,
                result: event.result,
		opponentName: event.opponent.name
            });

            if (streakType === event.result) currentStreak++;
            else { streakType = event.result; currentStreak = 1; }

            const oppId = event.opponent.discordUserId;
            if (!opponents[oppId]) opponents[oppId] = { name: event.opponent.name, wins: 0, losses: 0 };
            if (event.result === 'win') opponents[oppId].wins++; else opponents[oppId].losses++;
        }

        // --- RIVALS CALCULATION ---
        let nemesis = null; let favorite = null;
        let maxLossRate = -1; let maxWinRate = -1;
        const MIN_GAMES = 5;

        Object.values(opponents).forEach(opp => {
            const total = opp.wins + opp.losses;
            const winRate = opp.wins / total;
            const lossRate = opp.losses / total;

            if (total >= MIN_GAMES) {
                if (winRate > maxWinRate) { maxWinRate = winRate; favorite = `${opp.name} (${Math.round(winRate*100)}%)`; }
                if (lossRate > maxLossRate) { maxLossRate = lossRate; nemesis = `${opp.name} (${Math.round(lossRate*100)}%)`; }
            }
        });

        if (!nemesis) Object.values(opponents).forEach(o => { if(o.losses > maxLossRate) { maxLossRate=o.losses; nemesis=`${o.name} (${o.losses} L)`; } });
        if (!favorite) Object.values(opponents).forEach(o => { if(o.wins > maxWinRate) { maxWinRate=o.wins; favorite=`${o.name} (${o.wins} W)`; } });

        res.json({ 
            history: graphData, 
            currentElo: player.elo,
            stats: {
                peakElo: highestElo,
                lowestElo: lowestElo,
                currentStreak: currentStreak > 0 ? `${currentStreak} ${streakType === 'win' ? 'W' : 'L'}` : '0',
                totalGames: cleanHistory.length,
                winRate: cleanHistory.length > 0 ? Math.round((player.wins / cleanHistory.length) * 100) : 0,
                nemesis: nemesis || 'None',
                favorite: favorite || 'None',
                // NEW FIELDS
                starterWinRate: `${starterWinRate}%`,
                startsCount: starts
            }
        });

    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
});

app.get('/stats/starter', async (req, res) => {
    try {
        let targetBoardId = req.query.boardId;
        if (!targetBoardId) {
            const legacy = await prisma.leaderboard.findFirst({ where: { name: ALL_TIME_BOARD_NAME } });
            targetBoardId = legacy.id;
        }
        const matches = await prisma.match.findMany({ where: { leaderboardId: targetBoardId, starterId: { not: null } } });
        const players = await prisma.player.findMany({ where: { leaderboardId: targetBoardId } });
        const playerMap = {};
        players.forEach(p => playerMap[p.id] = p.name);

        let totalMatches = matches.length;
        let starterWins = 0;
        const counts = {}; const totals = {};

        for (const m of matches) {
            if (m.winnerId && m.starterId === m.winnerId) starterWins++;
            counts[m.starterId] = (counts[m.starterId] || 0) + 1;
            if (m.winnerId) totals[m.winnerId] = (totals[m.winnerId] || 0) + 1;
            if (m.loserId) totals[m.loserId] = (totals[m.loserId] || 0) + 1;
        }

        const overallWin = totalMatches > 0 ? ((starterWins / totalMatches) * 100).toFixed(2) : 0;
        const stats = Object.keys(counts).map(k => {
            const t = counts[k] || 0;
            const g = totals[k] || t;
            return { name: playerMap[k] || '?', timesStarted: t, totalGames: g, percentage: g > 0 ? (t/g)*100 : 0 };
        }).sort((a,b) => b.percentage - a.percentage);

        res.json({ 
            totalMatchesWithStarterInfo: totalMatches, 
            starterWins, 
            overallStarterWinPercentage: overallWin, 
            statsArray: stats 
        });
    } catch (error) { res.status(500).json({ error: 'Failed.' }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Logic Service running on ${PORT}`));
