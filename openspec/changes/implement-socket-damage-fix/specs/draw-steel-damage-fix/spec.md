## ADDED Requirements

### Requirement: GM Relay for Damage Application
The system SHALL enable players to apply damage to any token by relaying the request through a GM client via a socket message.

#### Scenario: Player damages an unowned NPC
- **GIVEN** a Player is in a game with a GM
- **AND** there is an NPC token on the canvas that the Player does not own
- **WHEN** the Player initiates a damage action against the NPC token
- **THEN** the module SHALL send a socket message to the GM with the damage details
- **AND** the GM's client SHALL receive the message and apply the specified damage to the NPC actor.

#### Scenario: GM is not present
- **GIVEN** a Player is in a game without a GM
- **WHEN** the Player initiates a damage action against an NPC token
- **THEN** the socket message SHALL be sent but no damage will be applied, as no GM is present to process it.

### Requirement: Multi-Target Damage Confirmation
The system SHALL present a confirmation dialog to the user before applying damage to multiple targets.

#### Scenario: Player damages multiple NPCs
- **GIVEN** a Player has targeted more than one token
- **WHEN** the Player initiates a damage action
- **THEN** the system SHALL display a dialog listing the targeted tokens and the damage amount.
- **AND** damage SHALL only be applied if the Player confirms the action in the dialog.

#### Scenario: Player cancels multi-damage
- **GIVEN** a Player has targeted more than one token and is presented with the confirmation dialog
- **WHEN** the Player cancels the action in the dialog
- **THEN** no damage SHALL be applied to any token.

### Requirement: Support Half Damage
The system SHALL apply half damage if the user holds the Shift key while clicking the apply damage button.

#### Scenario: Player applies half damage
- **GIVEN** a damage roll result of 20
- **WHEN** the Player Shift-clicks the "Apply Damage" button
- **THEN** the system SHALL calculate the damage amount as 10
- **AND** apply 10 damage to the target.

### Requirement: Player-Initiated Healing
The system SHALL support applying healing in the same way it supports damage, using the GM relay.

#### Scenario: Player heals an unowned NPC
- **GIVEN** a Player is in a game with a GM
- **WHEN** the Player initiates a healing action against an unowned NPC token
- **THEN** the module SHALL send a socket message to the GM with the healing details.
- **AND** the GM's client SHALL apply the specified healing to the NPC actor.
