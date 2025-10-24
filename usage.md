# Cope Terminal - Usage Guide

## What is Cope Terminal?

Cope Terminal is a parody, local-only web app that simulates a terminal interface for anonymous confessions, inspired by the culture of pump.fun and crypto trading. Users can submit their "confessions" about trading mishaps, regrets, or degen moments. Each confession is paired with a tongue-in-cheek "therapist" (cope) reply, emphasizing humor and self-awareness.

**All data is stored locally in your browser. Nothing is sent to any server.**

---

## Main Features

- **Anonymous Confessions:**  
  Use the `confess <your message>` command to submit a confession. Your confession is stored only in your browser.

- **Confession Feed:**  
  View recent confessions (yours and preloaded examples) with the `feed` command. Each confession is followed by a playful "cope" reply.

- **Terminal Experience:**  
  Interact using familiar terminal commands (`help`, `clear`, `about`, etc.) in a PowerShell-inspired interface.

- **Local & Private:**  
  All confessions and data remain on your device. No network or remote storage is used.

---

## How to Use

1. **Open the app in your browser.**
2. **Type `help`** to see available commands.
3. **Submit a confession:**  
   ```
   cope I bought the top and sold the bottom.
   ```
4. **View the feed:**  
   ```
   feed
   ```
5. **Clear the terminal:**  
   ```
   clear
   ```
6. **Learn about the project:**  
   ```
   about
   ```

---

## How replies are chosen (local-only)

- The app loads prompts from input.json and snarky responses from output.json (both local files).
- Your confession is matched to the closest prompt using simple word overlap.
- One response is picked at random from that prompt’s response list (avoids repeats session-by-session).
- Then a tiny local-only “brain” personalizes it:
  - Extracts light context (amounts, budget/sleep/revenge/risk themes, occasional $TICKER if present).
  - Picks a micro-style and applies tiny paraphrase/word swaps from a small synonyms list.
  - Adds a short intro (“On budget: …” or “Re $TROLL: …”) and/or a one-line checklist nudge (“Guardrail: size small.”).
  - Randomness is deterministic per message and day, so the same text is consistent within a day but feels fresh across days.
- If augmentation would reduce clarity, the app falls back to the original line.
- Nothing is sent to a server; all selection and augmentation happen in your browser.

---

## Intended Audience

- Crypto traders, pump.fun users, and anyone who enjoys crypto culture humor.
- Anyone seeking a safe, local, and anonymous way to "cope" with trading stories.

---

## Disclaimer

This project is for entertainment and parody only. It is not a real therapy tool and does not provide any medical or psychological advice.

For more, see [disclaimer.md](./disclaimer.md).
