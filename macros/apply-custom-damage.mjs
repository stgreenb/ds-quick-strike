// Custom Damage Macro - Applies custom damage to targeted tokens
// Shows targeted token names and allows input of damage value and type
// Works with ds-quick-strike module to apply damage via socket to unowned tokens

const MODULE_ID = 'ds-quick-strike';

async function applyCustomDamage() {
  const targets = Array.from(game.user.targets);
  
  if (targets.length === 0) {
    ui.notifications.warn("No targets selected. Target a token first.");
    return;
  }

  const targetNames = targets.map(t => t.name).join(', ');

  const {createFormGroup, createTextInput, createSelectInput} = foundry.applications.fields;
  
  const content = document.createElement("div");
  
  const targetDisplay = document.createElement("div");
  targetDisplay.style.cssText = "margin-bottom: 12px; padding: 8px; background: #f0f0f0; border-radius: 4px; font-weight: bold; color: #333;";
  targetDisplay.innerHTML = `Targets: ${targetNames}`;
  
  const damageForm = createFormGroup({
    label: "Damage",
    hint: "Enter a number (e.g., 5) or dice (e.g., 1d6+3)",
    rootId: "damageInput",
    input: createTextInput({ name: "damage", value: "1d6" })
  });

  const typeForm = createFormGroup({
    label: "Damage Type",
    rootId: "damageTypeInput",
    input: createSelectInput({
      name: "type",
      options: [
        {label: "Untyped", value: "", selected: true },
        {label: "Acid", value: "acid"},
        {label: "Cold", value: "cold"},
        {label: "Corruption", value: "corruption"},
        {label: "Fire", value: "fire"},
        {label: "Holy", value: "holy"},
        {label: "Lightning", value: "lightning"},
        {label: "Poison", value: "poison"},
        {label: "Psychic", value: "psychic"},
        {label: "Sonic", value: "sonic"}
      ]
    })
  });

  content.append(targetDisplay, damageForm, typeForm);

  const fd = await ds.applications.api.DSDialog.input({
    content,
    window: {
      title: "Apply Custom Damage",
      icon: "fa-solid fa-sword"
    }
  });

  if (!fd) return;

  const damageValue = fd.damage?.trim() || "1d6";
  const damageType = fd.type || "untyped";

  await applyDamageToTargets(targets, damageValue, damageType);
}

async function applyDamageToTargets(targets, damageValue, type) {
  let finalAmount;
  try {
    const roll = new ds.rolls.DamageRoll(damageValue);
    await roll.evaluate();
    finalAmount = roll.total;
  } catch (e) {
    finalAmount = Math.round(parseFloat(damageValue)) || 0;
  }

  if (finalAmount <= 0) {
    ui.notifications.error("Invalid damage amount: " + damageValue);
    return;
  }

  // Get socket
  const socket = socketlib.registerModule(MODULE_ID);
  if (!socket) {
    ui.notifications.error("ds-quick-strike module not available");
    return;
  }

  const eventId = `custom-damage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const displayType = type || "untyped";

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
        type: displayType,
        ignoredImmunities: [],
        sourceActorName: game.user.character?.name || game.user.name,
        sourceActorId: game.user.character?.id || null,
        sourceItemName: 'Custom Damage',
        sourcePlayerName: game.user.name,
        sourceItemId: null,
        eventId: eventId
      });

      if (result?.success) {
        ui.notifications.info(`Applied ${finalAmount} ${displayType} damage to ${result.tokenName}`);
      } else {
        ui.notifications.error(`Failed to damage ${target.name}: ${result?.error || "Unknown error"}`);
      }
    }
  }
}

await applyCustomDamage();
