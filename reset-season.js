require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TARGET_SEASON = "Pool 2025-11";

async function resetSeason() {
    console.log(`🗑️  Deleting corrupted season: "${TARGET_SEASON}"...`);

    const seasonBoard = await prisma.leaderboard.findFirst({
        where: { name: TARGET_SEASON }
    });

    if (!seasonBoard) {
        console.log("❌ Season not found. Nothing to delete.");
        return;
    }

    // 1. Delete Matches first (Foreign Key Constraint)
    const deletedMatches = await prisma.match.deleteMany({
        where: { leaderboardId: seasonBoard.id }
    });
    console.log(`   - Deleted ${deletedMatches.count} matches.`);

    // 2. Delete Players second
    const deletedPlayers = await prisma.player.deleteMany({
        where: { leaderboardId: seasonBoard.id }
    });
    console.log(`   - Deleted ${deletedPlayers.count} players.`);

    // 3. Delete the Leaderboard row itself
    await prisma.leaderboard.delete({
        where: { id: seasonBoard.id }
    });
    console.log(`   - Deleted Leaderboard entry.`);

    console.log("✅ Cleanup complete. You can now run 'node seed-all-seasons.js'");
}

resetSeason()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
