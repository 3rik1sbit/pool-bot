import json
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import argparse
import os

def generate_elo_chart(json_file_path, output_image_path, output_csv_path):
    """
    Generates an ELO rating chart from pool game data in a JSON file.

    Args:
        json_file_path (str): Path to the input JSON file.
        output_image_path (str): Path to save the output PNG image.
        output_csv_path (str): Path to save the output CSV file with ELO history.
    """
    try:
        # 1. Load and Parse JSON Data from file
        with open(json_file_path, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"Error: The file {json_file_path} was not found.")
        return
    except json.JSONDecodeError:
        print(f"Error: Could not decode JSON from the file {json_file_path}.")
        return
    except Exception as e:
        print(f"An error occurred while reading the JSON file: {e}")
        return

    players_data = data.get('players', {})
    global_matches_data = data.get('matches', [])

    if not players_data or not global_matches_data:
        print("Error: 'players' or 'matches' data is missing or empty in the JSON file.")
        return

    # 2. Calculate Initial ELOs
    initial_elos = {}
    player_names = {}
    for player_id, player_info in players_data.items():
        player_names[player_id] = player_info.get('name', player_id) # Use ID if name is missing
        current_elo = player_info.get('elo', 1000) # Default ELO if missing
        
        # Sort personal matches by timestamp in descending order for reverse calculation
        personal_matches = player_info.get('matches', [])
        personal_matches_sorted = sorted(personal_matches, key=lambda x: x.get('timestamp', ''), reverse=True)
        
        for match in personal_matches_sorted:
            current_elo -= match.get('eloChange', 0)
        initial_elos[player_id] = current_elo

    # 3. Prepare Data for Plotting
    # Sort global matches by timestamp
    global_matches_sorted = sorted(global_matches_data, key=lambda x: x.get('timestamp', ''))
    num_global_games = len(global_matches_sorted)

    player_ids = list(players_data.keys())
    
    # Ensure all player IDs found in matches are in player_ids, or handle gracefully
    all_player_ids_in_matches = set()
    for game in global_matches_sorted:
        all_player_ids_in_matches.add(game['winnerId'])
        all_player_ids_in_matches.add(game['loserId'])
    
    for pid in all_player_ids_in_matches:
        if pid not in player_ids:
            # Add new player found in matches but not in players dict
            player_ids.append(pid)
            player_names[pid] = f"Player {pid}" # Generic name
            initial_elos[pid] = 1000 # Default initial ELO for new players
            print(f"Warning: Player ID {pid} found in matches but not in 'players' dictionary. Added with default ELO 1000.")


    elo_history_df = pd.DataFrame(index=range(num_global_games + 1), columns=player_ids, dtype=float)


    # Initialize ELOs at Global Game Index 0
    for player_id in player_ids:
        elo_history_df.loc[0, player_id] = initial_elos.get(player_id, 1000) # Default if somehow still missing

    # 4. Process Global Matches
    for k, game in enumerate(global_matches_sorted, start=1):
        # Copy ELOs from the previous state
        elo_history_df.loc[k] = elo_history_df.loc[k-1].copy()

        winner_id = game.get('winnerId')
        loser_id = game.get('loserId')
        winner_elo_after_game = game.get('winnerElo')
        loser_elo_after_game = game.get('loserElo')

        if winner_id and winner_elo_after_game is not None:
            if winner_id in elo_history_df.columns:
                elo_history_df.loc[k, winner_id] = winner_elo_after_game
            else:
                print(f"Warning: Winner ID {winner_id} from game {k} not in player list. Skipping ELO update for this winner.")
        
        if loser_id and loser_elo_after_game is not None:
            if loser_id in elo_history_df.columns:
                elo_history_df.loc[k, loser_id] = loser_elo_after_game
            else:
                print(f"Warning: Loser ID {loser_id} from game {k} not in player list. Skipping ELO update for this loser.")
            
    # Rename columns to player names for the legend
    elo_history_df_renamed = elo_history_df.rename(columns=player_names)

    # 5. Generate the Plot
    plt.figure(figsize=(15, 8))

    for player_name_col in elo_history_df_renamed.columns:
        plt.plot(elo_history_df_renamed.index, elo_history_df_renamed[player_name_col].astype(float), marker='o', markersize=3, linestyle='-', label=player_name_col)

    plt.title('Player ELO Rating Over Global Game Sequence', fontsize=16)
    plt.xlabel('Global Game Sequence Number', fontsize=14)
    plt.ylabel('ELO Rating', fontsize=14)

    ax = plt.gca()
    ax.xaxis.set_major_locator(ticker.MaxNLocator(integer=True))

    plt.legend(title='Players', bbox_to_anchor=(1.05, 1), loc='upper left')
    plt.grid(True, which='both', linestyle='--', linewidth=0.5)
    plt.tight_layout(rect=[0, 0, 0.85, 1]) # Adjust layout to make space for legend

    # Save the plot
    try:
        plt.savefig(output_image_path)
        print(f"Chart saved to {output_image_path}")
    except Exception as e:
        print(f"Error saving chart image to {output_image_path}: {e}")
    finally:
        plt.close()

    # Save the ELO history DataFrame to CSV
    try:
        elo_history_df_renamed.to_csv(output_csv_path)
        print(f"ELO history data saved to {output_csv_path}")
    except Exception as e:
        print(f"Error saving ELO history CSV to {output_csv_path}: {e}")

    print("\nInitial ELOs:")
    for player_id, elo in initial_elos.items():
        print(f"- {player_names.get(player_id, player_id)}: {elo}")

    print("\nFinal ELOs (after all global matches):")
    for player_name_col in elo_history_df_renamed.columns:
        final_elo = elo_history_df_renamed.loc[num_global_games, player_name_col] if num_global_games >=0 else initial_elos.get(player_ids[elo_history_df_renamed.columns.get_loc(player_name_col)], "N/A")
        print(f"- {player_name_col}: {final_elo}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate ELO rating chart from pool game JSON data.")
    parser.add_argument(
        "--json_path",
        type=str,
        default="/home/erik/Projects/Javascript/pool-bot/poolEloDatabase.json",
        help="Path to the input JSON file."
    )
    parser.add_argument(
        "--output_image",
        type=str,
        default="elo_rating_chart.png",
        help="Path to save the output PNG image."
    )
    parser.add_argument(
        "--output_csv",
        type=str,
        default="elo_history.csv",
        help="Path to save the output CSV file with ELO history."
    )
    args = parser.parse_args()

    generate_elo_chart(args.json_path, args.output_image, args.output_csv)
