/*
  Warnings:

  - Added the required column `eloChange` to the `Match` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Match" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leaderboardId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "winnerId" TEXT NOT NULL,
    "loserId" TEXT NOT NULL,
    "winnerElo" INTEGER NOT NULL,
    "loserElo" INTEGER NOT NULL,
    "eloChange" INTEGER NOT NULL,
    "breakerId" TEXT,
    CONSTRAINT "Match_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Match_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Match_loserId_fkey" FOREIGN KEY ("loserId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Match" ("breakerId", "id", "leaderboardId", "loserElo", "loserId", "timestamp", "winnerElo", "winnerId") SELECT "breakerId", "id", "leaderboardId", "loserElo", "loserId", "timestamp", "winnerElo", "winnerId" FROM "Match";
DROP TABLE "Match";
ALTER TABLE "new_Match" RENAME TO "Match";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
