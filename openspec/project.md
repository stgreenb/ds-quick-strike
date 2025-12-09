# Project Context

## Purpose
This project is a Foundry VTT module for the "Draw Steel" game system. Its primary goal is to solve a core permission issue in the system by enabling players to apply damage and healing to any NPC token, not just tokens they own.

This is achieved by implementing a secure "GM Relay" pattern. Player-initiated damage requests are sent via a socket to the Game Master (GM), who has the necessary permissions to process the request and apply the damage to the actor. This respects Foundry's security model while providing a much-needed feature for collaborative gameplay.

## Tech Stack
- **Primary Platform**: Foundry VTT (v13.0+)
- **Game System**: Draw Steel
- **Language**: JavaScript (ESM)
- **Core APIs**: Foundry VTT API, specifically:
    - `Hooks` for initialization (`Hooks.once("ready", ...)`).
    - `game.socket` for real-time client-GM communication.
    - `Dialog` for user confirmation prompts.
    - Core canvas and game objects (`canvas.tokens`, `game.messages`, `game.user`).
- **Configuration**: `module.json` manifest file.

## Project Conventions

### Code Style
- **Documentation**: JSDoc comments are used for modules and functions to explain their purpose, parameters, and return values.
- **Naming**: A `MODULE_NAME` constant is defined and used for socket channel naming and logging to ensure consistency. Function names are descriptive and follow a clear verb-noun pattern (e.g., `installDamageFix`, `sendDamageRequest`).
- **Logging**: `console.log`, `console.warn`, and `console.error` are used extensively for both debugging and creating a clear audit trail of actions (e.g., GM receiving a request, damage being applied).
- **Asynchronicity**: `async/await` is used for all asynchronous operations, particularly for dialogs and actor updates.

### Architecture Patterns
- **Socket-Based GM Relay**: The core architectural pattern is delegating actions. Players do not directly modify game data. Instead, they emit a socket event (`module.draw-steel-damage-fix`). A handler, registered *only* on the GM's client, listens for this event.
- **Permission-Aware Execution**: The GM's client is responsible for executing the actual `actor.system.takeDamage()` call, leveraging the GM's universal permissions to modify any actor. This is the key to bypassing player permission restrictions securely.
- **Monkey-Patching**: The module overrides the default `ds.rolls.DamageRoll.applyDamageCallback` function with its own socket-aware implementation. This is the entry point for intercepting the player's action.
- **Graceful Degradation**: The module checks for the correct system (`game.system.id === "draw-steel"`) and the existence of the necessary classes (`ds?.rolls?.DamageRoll`) before initializing.

### Testing Strategy
A manual testing strategy is defined with a clear checklist covering the main use cases:
1.  **Basic Damage**: A player successfully damages an NPC.
2.  **Multi-Target**: A confirmation dialog appears when applying damage to multiple tokens.
3.  **No GM Present**: Damage application fails gracefully if no GM is logged in to process the request.
4.  **Concurrency**: Multiple players can apply damage simultaneously without conflicts.
5.  **Audit Trail**: All actions are logged to the GM's console for verification.
6.  **Feature-Specific**: Shift-clicking to apply half-damage works as expected.

### Git Workflow
[Not specified in the provided document, but would typically include conventions for branching (e.g., `feature/`, `fix/`), commit messages, and pull requests.]

## Domain Context
- **Foundry VTT**: A virtual tabletop application for role-playing games. The environment is server-based with multiple clients (players and GMs).
- **Draw Steel**: A specific game system within Foundry VTT.
- **Actors & Tokens**: In Foundry, an `Actor` is the character sheet (data), and a `Token` is its representation on the game canvas. Users interact with tokens.
- **Permissions**: Foundry has a strict permission model. By default, users (players) can only modify actors they "own". GMs have ownership of all actors.
- **Sockets**: The real-time communication layer in Foundry, used to sync state between clients.

## Important Constraints
- **Active GM Required**: The core functionality is entirely dependent on a GM being logged into the game session. Without a GM, player damage requests will be sent but never processed.
- **Platform Version**: The implementation requires Foundry VTT version 13.0 or newer due to its socket system and API dependencies.
- **System Dependency**: This module is built exclusively for the "Draw Steel" system and will not activate for any other game system.

## External Dependencies
- **Foundry VTT**: The host application and platform.
- **Draw Steel System**: The module is a direct dependency and extension of this game system.