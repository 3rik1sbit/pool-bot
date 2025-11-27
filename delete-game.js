require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const readline = require('readline');

const prisma = new PrismaClient();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function listBoards() {
    const boards = await prisma.leaderboard.findMany({
        orderBy: { createdAt: 'desc' }
    });
    
    console.log("\n--- AVAILABLE LEADERBOARDS ---");
    boards.forEach(b => {
        console.log(`ID: ${b.id} | Name: ${b.name} | Type: ${b.gameType}`);
    });
    console.log("------------------------------\n");
}

async function deleteSystem(boardId) {
    // 1. Find the target board to get its gameType
    const target = await prisma.leaderboard.findUnique({ where: { id: boardId } });
    
    if (!target) {
        console.error("❌ Board not found.");
        return;
    }

    // 2. Find ALL boards sharing this gameType (All-Time + Seasons)
    const allBoardsInSystem = await prisma.leaderboard.findMany({
        where: { gameType: target.gameType }
    });

    console.log(`\n⚠️  WARNING: This will delete the entire "${target.name}" system.`);
    console.log(`   This includes ${allBoardsInSystem.length} leaderboards (All-Time & Seasons).`);
    
    const idsToDelete = allBoardsInSystem.map(b => b.id);

    // 3. Delete Logic
    // We must delete Matches -> Players -> Boards (in that order)
    const deletedMatches = await prisma.match.deleteMany({
        where: { leaderboardId: { in: idsToDelete } }
    });
    console.log(`   - Deleted ${deletedMatches.count} matches.`);

    const deletedPlayers = await prisma.player.deleteMany({
        where: { leaderboardId: { in: idsToDelete } }
    });
    console.log(`   - Deleted ${deletedPlayers.count} players.`);

    const deletedBoards = await prisma.leaderboard.deleteMany({
        where: { id: { in: idsToDelete } }
    });
    console.log(`   - Deleted ${deletedBoards.count} leaderboards.`);
    
    console.log("\n✅ Game System Deleted Successfully.");
}

async function main() {
    await listBoards();
    
    rl.question('Enter the UUID of the board you want to delete (or Ctrl+C to exit): ', async (id) => {
        if (id) {
            await deleteSystem(id.trim());
        }
        await prisma.$disconnect();
        rl.close();
    });
}

main().catch(e => console.error(e));
