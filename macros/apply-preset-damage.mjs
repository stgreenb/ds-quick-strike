// Preset Damage Macro - Applies pre-set damage to targeted tokens with confirmation
// Works with ds-quick-strike module to apply damage via socket to unowned tokens

const MODULE_ID = 'ds-quick-strike';

// === CONFIGURATION ===
// Edit these values to set your preset damage
const DAMAGE_AMOUNT = 5;        // Can be a number or dice string like "1d6+3"
const DAMAGE_TYPE = ''; // Options: "", "acid", "cold", "corruption", "fire", "holy", "lightning", "poison", "psychic", "sonic"
// =====================

async function applyPresetDamage() {
  const targets = Array.from(game.user.targets);
  
  if (targets.length === 0) {
    ui.notifications.warn("No targets selected. Target a token first.");
    return;
  }

  const targetNames = targets.map(t => t.name).join(', ');
  const damageDisplay = isNaN(parseInt(DAMAGE_AMOUNT)) ? DAMAGE_AMOUNT : DAMAGE_AMOUNT;
  const typeLabel = DAMAGE_TYPE || 'untyped';

  const confirmContent = `
    <div style="text-align: center; padding: 12px;">
      <p style="margin: 0 0 12px 0; font-size: 16px;">
        Apply <strong>${damageDisplay} ${typeLabel}</strong> damage to:
      </p>
      <p style="margin: 0; color: #666; font-size: 14px; font-weight: bold;">
        ${targetNames}
      </p>
    </div>
  `;

  const dialog = new Dialog({
    title: "Confirm Damage",
    content: confirmContent,
    buttons: {
      confirm: {
        label: "Apply Damage",
        callback: async () => {
          await applyDamageToTargets(targets, DAMAGE_AMOUNT, DAMAGE_TYPE);
        }
      },
      cancel: {
        label: "Cancel",
        callback: () => {
          ui.notifications.info("Damage cancelled");
        }
      }
    },
    default: "cancel"
  });
  
  dialog.render(true);
}

async function applyDamageToTargets(targets, amount, type) {
  // Parse the damage amount - handle dice notation
  let finalAmount;
  try {
    const roll = new ds.rolls.DamageRoll(String(amount));
    await roll.evaluate();
    finalAmount = roll.total;
  } catch (e) {
    finalAmount = Math.round(parseFloat(amount)) || 0;
  }

  if (finalAmount <= 0) {
    ui.notifications.error("Invalid damage amount");
    return;
  }

  // Get socket
  const socket = socketlib.registerModule(MODULE_ID);
  if (!socket) {
    ui.notifications.error("ds-quick-strike module not available");
    return;
  }

  const eventId = `preset-damage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Apply damage to each target
  for (const target of targets) {
    const owned = target.actor?.isOwner;
    
    if (owned || game.user.isGM) {
      // Direct apply for owned tokens
      const oldStamina = target.actor.system.stamina.value;
      const oldTemp = target.actor.system.stamina.temporary;
      
      await target.actor.system.takeDamage(finalAmount, { 
        type: type, 
        ignoredImmunities: [] 
      });
      
      const newStamina = target.actor.system.stamina.value;
      const newTemp = target.actor.system.stamina.temporary;
      
      ui.notifications.info(`${target.name}: ${oldStamina} (${oldTemp} temp) → ${newStamina} (${newTemp} temp)`);
    } else {
      // Use socket for unowned tokens
      const result = await socket.executeAsGM('applyDamageToTarget', {
        tokenId: target.id,
        amount: finalAmount,
        type: type || 'untyped',
        ignoredImmunities: [],
        sourceActorName: game.user.character?.name || game.user.name,
        sourceActorId: game.user.character?.id || null,
        sourceItemName: 'Preset Damage',
        sourcePlayerName: game.user.name,
        sourceItemId: null,
        eventId: eventId
      });

      if (result?.success) {
        ui.notifications.info(`Applied ${finalAmount} ${type || 'untyped'} damage to ${result.tokenName}`);
      } else {
        ui.notifications.error(`Failed to damage ${target.name}: ${result?.error || "Unknown error"}`);
      }
    }
  }
}

await applyPresetDamage();
