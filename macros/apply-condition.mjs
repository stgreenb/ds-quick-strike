// Apply Condition Macro - Applies conditions to targeted tokens
// Works with ds-quick-strike module to apply conditions via socket to unowned tokens

const MODULE_ID = 'ds-quick-strike';

const conditions = [
  'Slowed', 'Weakened', 'Bleeding', 'Dazed', 'Frightened', 
  'Grabbed', 'Prone', 'Restrained', 'Taunted'
];

const durations = ['save', 'turn', 'encounter', 'respite'];

async function applyCondition() {
  const targets = Array.from(game.user.targets);
  
  if (targets.length === 0) {
    ui.notifications.warn("No targets selected. Target a token first.");
    return;
  }

  const targetNames = targets.map(t => t.name).join(', ');

  const {createFormGroup, createSelectInput} = foundry.applications.fields;
  
  const content = document.createElement("div");
  
  const targetDisplay = document.createElement("div");
  targetDisplay.style.cssText = "margin-bottom: 12px; padding: 8px; background: #f0f0f0; border-radius: 4px; font-weight: bold; color: #333;";
  targetDisplay.innerHTML = `Targets: ${targetNames}`;
  
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

  content.append(targetDisplay, conditionForm, durationForm);

  const fd = await ds.applications.api.DSDialog.input({
    content,
    window: {
      title: "Apply Condition",
      icon: "fa-solid fa-bolt"
    }
  });

  if (!fd) return;

  const condition = fd.condition;
  const duration = fd.duration;

  await applyConditionToTargets(targets, condition, duration);
}

async function applyConditionToTargets(targets, condition, duration) {
  const socket = socketlib.registerModule(MODULE_ID);
  if (!socket) {
    ui.notifications.error("ds-quick-strike module not available");
    return;
  }

  const durationObj = {
    type: 'draw-steel',
    label: duration === 'save' ? 'Save Ends' : 
           duration === 'turn' ? 'EoT' :
           duration === 'encounter' ? 'EoE' : 'Respite',
    end: { type: duration }
  };

  const controlledTokens = canvas.tokens.controlled;
  const sourceActorUuid = controlledTokens.length > 0 ? controlledTokens[0].actor?.uuid : null;
  const targetedStatuses = ['frightened', 'grabbed', 'taunted'];
  const isTargetedStatus = targetedStatuses.includes(condition.toLowerCase());

  for (const target of targets) {
    const result = await socket.executeAsGM('applyStatusToTarget', {
      tokenId: target.id,
      statusName: condition,
      statusId: condition.toLowerCase(),
      effectUuid: null,
      sourceActorUuid: isTargetedStatus ? sourceActorUuid : null,
      sourceActorId: null,
      sourceItemId: null,
      sourceItemName: condition,
      sourcePlayerName: game.user.name,
      ability: null,
      timestamp: Date.now(),
      duration: durationObj
    });

    if (result?.success) {
      ui.notifications.info(`Applied ${condition} to ${target.name}`);
    } else {
      ui.notifications.error(`Failed to apply ${condition} to ${target.name}: ${result?.error || "Unknown error"}`);
    }
  }
}

await applyCondition();
