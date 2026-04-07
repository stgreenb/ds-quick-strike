// Combined Damage + Condition Macro - Applies damage and a condition to targeted tokens
// Works with ds-quick-strike module to apply both via socket to unowned tokens

const MODULE_ID = 'ds-quick-strike';

const conditions = [
  'Slowed', 'Weakened', 'Bleeding', 'Dazed', 'Frightened', 
  'Grabbed', 'Prone', 'Restrained', 'Taunted'
];

const durations = ['save', 'turn', 'encounter', 'respite'];

async function applyDamageAndCondition() {
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

  const conditionForm = createFormGroup({
    label: "Condition",
    rootId: "conditionInput",
    input: createSelectInput({
      name: "condition",
      options: conditions.map(c => ({label: c, value: c}))
    })
  });

  const durationForm = createFormGroup({
    label: "Duration",
    rootId: "durationInput",
    input: createSelectInput({
      name: "duration",
      options: durations.map(d => ({label: d, value: d}))
    })
  });

  content.append(targetDisplay, damageForm, typeForm, conditionForm, durationForm);

  const fd = await ds.applications.api.DSDialog.input({
    content,
    window: {
      title: "Apply Damage + Condition",
      icon: "fa-solid fa-bolt"
    }
  });

  if (!fd) return;

  const damageValue = fd.damage?.trim() || "1d6";
  const damageType = fd.type || "untyped";
  const condition = fd.condition;
  const duration = fd.duration;

  await applyToTargets(targets, damageValue, damageType, condition, duration);
}

async function applyToTargets(targets, damageValue, type, condition, duration) {
  const socket = socketlib.registerModule(MODULE_ID);
  if (!socket) {
    ui.notifications.error("ds-quick-strike module not available");
    return;
  }

  let finalAmount;
  try {
    const roll = new ds.rolls.DamageRoll(String(damageValue));
    await roll.evaluate();
    finalAmount = roll.total;
  } catch (e) {
    finalAmount = Math.round(parseFloat(damageValue)) || 0;
  }

  if (finalAmount <= 0) {
    ui.notifications.error("Invalid damage amount: " + damageValue);
    return;
  }

  const durationObj = {
    type: 'draw-steel',
    label: duration === 'save' ? 'Save Ends' : 
           duration === 'turn' ? 'EoT' :
           duration === 'encounter' ? 'EoE' : 'Respite',
    end: { type: duration }
  };

  const eventId = `damage-condition-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const displayType = type || "untyped";

  const controlledTokens = canvas.tokens.controlled;
  const sourceActorUuid = controlledTokens.length > 0 ? controlledTokens[0].actor?.uuid : null;
  const sourceActorName = controlledTokens.length > 0 ? controlledTokens[0].actor?.name : game.user.character?.name || game.user.name;
  const sourceActorId = controlledTokens.length > 0 ? controlledTokens[0].actor?.id : game.user.character?.id || null;
  const targetedStatuses = ['frightened', 'grabbed', 'taunted'];
  const isTargetedStatus = targetedStatuses.includes(condition.toLowerCase());

  for (const target of targets) {
    const result = await socket.executeAsGM('applyDamageToTarget', {
      tokenId: target.id,
      amount: finalAmount,
      type: displayType,
      ignoredImmunities: [],
      sourceActorName: sourceActorName,
      sourceActorId: sourceActorId,
      sourceItemName: 'Damage + Condition',
      sourcePlayerName: game.user.name,
      sourceItemId: null,
      eventId: eventId
    });

    if (result?.success) {
      ui.notifications.info(`${target.name}: ${finalAmount} ${displayType} damage applied`);
    } else {
      ui.notifications.error(`Failed to damage ${target.name}: ${result?.error || "Unknown error"}`);
    }

    const statusResult = await socket.executeAsGM('applyStatusToTarget', {
      tokenId: target.id,
      statusName: condition,
      statusId: condition.toLowerCase(),
      effectUuid: null,
      sourceActorUuid: isTargetedStatus ? sourceActorUuid : null,
      sourceActorId: sourceActorId,
      sourceItemId: null,
      sourceItemName: condition,
      sourcePlayerName: game.user.name,
      ability: null,
      timestamp: Date.now(),
      duration: durationObj
    });

    if (statusResult?.success) {
      ui.notifications.info(`${target.name}: ${condition} applied`);
    } else {
      ui.notifications.error(`Failed to apply ${condition} to ${target.name}: ${statusResult?.error || "Unknown error"}`);
    }
  }
}

await applyDamageAndCondition();
