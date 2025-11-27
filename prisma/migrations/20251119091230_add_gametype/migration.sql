/*
  Warnings:

  - Added the required column `gameType` to the `Leaderboard` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Leaderboard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "gameType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discordChannelId" TEXT
);
INSERT INTO "new_Leaderboard" ("createdAt", "discordChannelId", "id", "name") SELECT "createdAt", "discordChannelId", "id", "name" FROM "Leaderboard";
DROP TABLE "Leaderboard";
ALTER TABLE "new_Leaderboard" RENAME TO "Leaderboard";
CREATE UNIQUE INDEX "Leaderboard_discordChannelId_key" ON "Leaderboard"("discordChannelId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
