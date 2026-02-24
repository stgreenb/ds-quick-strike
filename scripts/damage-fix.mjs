const MODULE_ID = 'ds-quick-strike';

let socket;
let damageHistory = [];
const originalTakeDamageMap = new Map();

/**
 * Initialize when SocketLib is ready
 */
Hooks.once('socketlib.ready', () => {
  try {
    socket = socketlib.registerModule(MODULE_ID);

    // Wrapped handlers with type coercion
    socket.register('applyDamageToTarget', async (data) => {
      // Ensure amount is coerced to integer
      if (typeof data.amount === 'string') {
        data.amount = Math.round(parseFloat(data.amount) || 0);
      }
      if (isNaN(data.amount)) {
        console.error(`${MODULE_ID}: Invalid damage amount: ${data.amount}`);
        return { success: false, error: "Invalid damage amount" };
      }
      return handleGMDamageApplication(data);
    });

    socket.register('applyHealToTarget', async (data) => {
      // Ensure amount is coerced to integer
      if (typeof data.amount === 'string') {
        data.amount = Math.round(parseFloat(data.amount) || 0);
      }
      if (isNaN(data.amount)) {
        console.error(`${MODULE_ID}: Invalid healing amount: ${data.amount}`);
        return { success: false, error: "Invalid healing amount" };
      }
      return handleGMHealApplication(data);
    });

    socket.register('undoLastDamage', handleGMUndoDamage);
    socket.register('applyStatusToTarget', handleGMApplyStatus);
    socket.register('undoStatusApplication', handleGMUndoStatus);
    console.log(`${MODULE_ID}: SocketLib registered successfully`);
  } catch (error) {
    console.error(`${MODULE_ID}: Failed to register socketlib:`, error);
  }
});

/**
 * Setup when ready
 */
Hooks.once('ready', () => {
  // Register module settings
  game.settings.register(MODULE_ID, 'publicDamageLog', {
    name: 'Public Damage Log',
    hint: 'Post damage and healing to public chat (undo buttons remain private)',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, 'publicStatusLog', {
    name: 'Public Status Log',
    hint: 'Post status applications to public chat (undo buttons remain GM-only)',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });

  if (game.user.isGM) {
    hookIntoActorDamage();
  }

  const waitForDependencies = () => {
    if (!globalThis.ds?.rolls?.DamageRoll || !socket) {
      setTimeout(waitForDependencies, 100);
      return;
    }

    installDamageOverride();
    installApplyEffectOverride();
  };

  waitForDependencies();
});

/**
 * Override Draw Steel 0.10.0 applyEffect action to route through GM relay
 */
function installApplyEffectOverride() {
  const AbilityResultPart = globalThis.ds?.data?.pseudoDocuments?.messageParts?.AbilityResult;
  if (!AbilityResultPart) {
    return;
  }

  const originalApplyEffect = AbilityResultPart.ACTIONS.applyEffect;
  if (!originalApplyEffect) {
    return;
  }

  AbilityResultPart.ACTIONS.applyEffect = async function(event, target) {
    event.preventDefault();
    event.stopPropagation();

    const statusId = target.dataset.effectId;
    const effectUuid = target.dataset.uuid;
    const statusName = target.textContent.trim();

    const message = this.message;
    let targetTokens = [];
    
    if (message.system?.targetTokens?.size > 0) {
      const tokenDocs = Array.from(message.system.targetTokens);
      targetTokens = tokenDocs.map(doc => canvas.tokens.get(doc.id)).filter(t => t);
    }
    
    if (!targetTokens.length) {
      targetTokens = Array.from(game.user.targets);
    }

    if (!targetTokens.length && game.user.isGM) {
      targetTokens = canvas.tokens.controlled;
    }

    if (!targetTokens.length) {
      ui.notifications.warn("Select a target to apply status");
      return;
    }

    const ownedTokens = targetTokens.filter(t => t.actor?.isOwner);
    const unownedTokens = targetTokens.filter(t => !t.actor?.isOwner);

    if (unownedTokens.length === 0 && !game.user.isGM) {
      return originalApplyEffect.call(this, event, target);
    }

    if (unownedTokens.length === 0 && game.user.isGM) {
      const abilityData = await extractAbilityDataFromMessage(message);
      const eventId = `status-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      for (const token of targetTokens) {
        await applyStatusWithLogging({
          token,
          statusId,
          statusName,
          effectUuid,
          sourceActorId: abilityData?.sourceActorId || null,
          sourceItemId: abilityData?.itemId || null,
          sourceItemName: abilityData?.itemName || statusName,
          sourcePlayerName: game.user.name,
          ability: abilityData?.ability || null,
          duration: abilityData?.duration || null,
          eventId
        });
      }
      return;
    }

    if (!socket) {
      ui.notifications.error("Socket not available");
      return;
    }

    const gmUser = game.users.find(u => u.isGM && u.active);
    if (!gmUser) {
      ui.notifications.warn("No GM available to apply status");
      return;
    }

    for (const token of unownedTokens) {
      const abilityData = await extractAbilityDataFromMessage(message);
      
      const result = await socket.executeAsGM("applyStatusToTarget", {
        tokenId: token.id,
        statusName,
        statusId,
        statusUuid: effectUuid,
        sourceActorId: abilityData?.sourceActorId || null,
        sourceItemId: abilityData?.itemId || null,
        sourceItemName: abilityData?.itemName || statusName,
        sourcePlayerName: game.user.name,
        ability: abilityData?.ability || null,
        timestamp: Date.now(),
        duration: abilityData?.duration || null
      });

      if (result?.success) {
        ui.notifications.info(`Applied ${statusName} to ${token.name}`);
      } else {
        ui.notifications.error(`Failed: ${result?.error || "Unknown error"}`);
      }
    }

    if (ownedTokens.length > 0) {
      const originalControlled = canvas.tokens.controlled;
      canvas.tokens.controlled = ownedTokens;
      
      try {
        await originalApplyEffect.call(this, event, target);
      } finally {
        canvas.tokens.controlled = originalControlled;
      }
    }
  };
}

/**
 * Hook into ALL actor damage/healing to capture direct GM actions
 */
function hookIntoActorDamage() {
  Hooks.on('createActor', (actor) => {
    wrapActorTakeDamage(actor);
  });

  game.actors.forEach(actor => {
    wrapActorTakeDamage(actor);
  });
}

/**
 * Wrap an actor's takeDamage method to log damage
 */
function wrapActorTakeDamage(actor) {
  if (!actor.system.takeDamage) return;

  if (originalTakeDamageMap.has(actor.id)) return;

  const originalTakeDamage = actor.system.takeDamage.bind(actor.system);
  originalTakeDamageMap.set(actor.id, originalTakeDamage);

  actor.system.takeDamage = async function(amount, options = {}) {
    // Actor method guard
    amount = Math.round(parseFloat(amount) || 0);

    const preStamina = getStaminaSnapshot(actor);

    const result = await originalTakeDamage(amount, options);

    const postStamina = getStaminaSnapshot(actor);
    const damageType = options.type || 'untyped';

    const caller = new Error().stack;
    const isSocketCall = caller.includes('handleGMDamageApplication') ||
                         caller.includes('handleGMHealApplication');

    const sourceItemId = options.sourceItemId || null;
    const eventId = `damage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const sourceActorId = game.user.character?.id || game.user.id;

    if (!isSocketCall && amount > 0) {
      await logDamageToChat({
        type: 'damage',
        amount: amount,
        damageType: damageType,
        targetName: actor.name,
        targetTokenId: actor.getActiveTokens()[0]?.id || null,
        targetActorId: actor.id,
        originalStamina: preStamina,
        newStamina: postStamina,
        sourceActorId: sourceActorId,
        sourcePlayerName: game.user.name,
        source: 'direct',
        sourceItemId: sourceItemId,
        eventId: eventId,
        timestamp: Date.now()
      });
    }

    return result;
  };
}

/**
 * Install the damage callback override
 */
function installDamageOverride() {
  const OriginalDamageRoll = globalThis.ds.rolls.DamageRoll;
  const originalCallback = OriginalDamageRoll.applyDamageCallback;

  OriginalDamageRoll.applyDamageCallback = async function(event) {
    try {
      const target = event.currentTarget;
      const li = target.closest("[data-message-id]");
      if (!li) return;

      const message = game.messages.get(li.dataset.messageId);
      if (!message) return;

      const rollIndex = target.dataset.index;
      
      const partElement = target.closest("[data-message-part]");
      let roll;
      if (partElement && message.system?.parts) {
        const partId = partElement.dataset.messagePart;
        const part = message.system.parts.get(partId);
        if (part && part.rolls) {
          roll = part.rolls[rollIndex];
        }
      }
      if (!roll) {
        roll = message.rolls[rollIndex];
      }
      if (!roll) return;

      let amount = roll.total;
      const isHalf = event.shiftKey;
      if (isHalf) {
        amount = Math.floor(amount / 2);
      }

      const targets = Array.from(game.user.targets);

      // Check for self-damage and warn player
      const proceedWithDamage = await checkForSelfDamage(targets, amount, roll.isHeal, MODULE_ID);
      if (!proceedWithDamage) return;

      // Get source actor name and ID from message speaker
      let sourceActorName = 'Unknown Source';
      let sourceActorId = null;
      let sourceItemName = 'Attack';

      if (message.speaker?.actor) {
        const sourceActor = game.actors.get(message.speaker.actor);
        if (sourceActor) {
          sourceActorName = sourceActor.name;
          sourceActorId = sourceActor.id;

          if (message.speaker?.item) {
            const sourceItem = sourceActor.items.get(message.speaker.item);
            if (sourceItem) {
              sourceItemName = sourceItem.name;
            }
          } else {
            // Try to get item UUID from 0.10.0 parts system
            let itemUuid = message.system?.uuid;
            if (!itemUuid && partElement && message.system?.parts) {
              const partId = partElement.dataset.messagePart;
              const part = message.system.parts.get(partId);
              if (part?.abilityUuid) {
                itemUuid = part.abilityUuid;
              }
            }
            if (itemUuid) {
              try {
                const sourceItem = await fromUuid(itemUuid);
                if (sourceItem) {
                  sourceItemName = sourceItem.name;
                }
              } catch (e) {
                console.warn(`${MODULE_ID}: Could not load item from UUID: ${itemUuid}`, e);
              }
            }
          }
        }
      }

      // Always use socket handlers for consistent logging
      if (socket) {
        await applyDamageViaSocket(targets, roll, amount, sourceActorName, sourceActorId, sourceItemName);
      } else {
        await originalCallback.call(this, event);
      }
    } catch (error) {
      console.error(`${MODULE_ID}:`, error);
      ui.notifications.error("Failed to apply damage");
    }
  };
}

/**
 * Check for self-damage and warn player before applying
 */
async function checkForSelfDamage(targets, amount, isHeal, moduleId) {
  const playerCharacter = game.user.character;
  if (!playerCharacter) return true;

  const selfDamageTargets = targets.filter(t => t.actor.id === playerCharacter.id);

  if (selfDamageTargets.length > 0 && !isHeal) {
    const targetName = selfDamageTargets[0].name;

    return new Promise(resolve => {
      const dialog = new Dialog({
        title: "⚠️ Self-Damage Warning",
        content: `<div style="text-align: center; padding: 12px;">
                    <p style="margin: 0 0 12px 0; font-size: 16px;">
                      You're about to deal <strong>${amount}</strong> damage to yourself!
                    </p>
                    <p style="margin: 0; color: #666; font-size: 14px;">
                      <strong>${targetName}</strong>
                    </p>
                  </div>`,
        buttons: {
          confirm: {
            label: "Confirm",
            callback: () => resolve(true)
          },
          cancel: {
            label: "Cancel",
            callback: () => {
              ui.notifications.warn(`Damage to ${targetName} cancelled`);
              resolve(false);
            }
          }
        },
        default: "cancel"
      });
      dialog.render(true);
    });
  }

  return true;
}

/**
 * Send damage request to GM via socket
 */
async function applyDamageViaSocket(targets, roll, amount, sourceActorName, sourceActorId, sourceItemName) {
  try {
    for (const target of targets) {
      const eventId = `damage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      if (roll.isHeal) {
        const result = await socket.executeAsGM('applyHealToTarget', {
          tokenId: target.id,
          amount: amount,
          type: roll.type,
          sourceActorName: sourceActorName,
          sourceActorId: sourceActorId,
          sourceItemName: sourceItemName,
          sourcePlayerName: game.user.name,
          sourceItemId: roll.sourceItemId || null,
          eventId: eventId
        });

        if (result.success) {
          ui.notifications.info(`Healed ${target.name} for ${amount}`);
        } else {
          ui.notifications.error(`Failed to heal ${target.name}: ${result.error}`);
        }
      } else {
        const result = await socket.executeAsGM('applyDamageToTarget', {
          tokenId: target.id,
          amount: amount,
          type: roll.type,
          ignoredImmunities: roll.ignoredImmunities || [],
          sourceActorName: sourceActorName,
          sourceActorId: sourceActorId,
          sourceItemName: sourceItemName,
          sourcePlayerName: game.user.name,
          sourceItemId: roll.sourceItemId || null,
          eventId: eventId
        });

        if (result.success) {
          ui.notifications.info(`Damaged ${target.name} for ${amount}`);
        } else {
          ui.notifications.error(`Failed to damage ${target.name}: ${result.error}`);
        }
      }
    }
  } catch (error) {
    console.error(`${MODULE_ID}: Socket error:`, error);
    ui.notifications.error("Socket communication failed");
  }
}

/**
 * Get stamina snapshot
 */
function getStaminaSnapshot(actor) {
  const permanent = actor.system?.stamina?.value ?? 0;
  const temporary = actor.system?.stamina?.temporary ?? 0;

  return { permanent, temporary };
}

/**
 * Check if actor is a Hero character
 */
function isHero(actor) {
  const type = actor.type || actor.system?.type;
  return type === 'character' || type === 'hero';
}

/**
 * Apply stamina bounds based on actor type
 */
function applyStaminaBounds(actor, staminaSnapshot) {
  const max = actor.system?.stamina?.max || 0;
  const min = actor.system?.stamina?.min || 0;

  let permanent = staminaSnapshot.permanent;

  if (isHero(actor)) {
    permanent = Math.max(min, Math.min(max, permanent));
  } else {
    permanent = Math.max(0, Math.min(max, permanent));
  }

  return {
    permanent,
    temporary: staminaSnapshot.temporary
  };
}

/**
 * GM handler: Apply damage to a target
 */
async function handleGMDamageApplication({ tokenId, amount, type, ignoredImmunities, sourceActorName, sourceActorId, sourceItemName, sourcePlayerName, sourceItemId, eventId }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  // Handler-level validation
  amount = Math.round(parseFloat(amount) || 0);
  if (isNaN(amount)) {
    console.error(`${MODULE_ID}: Invalid damage amount: ${amount}`);
    return { success: false, error: "Invalid damage amount" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    const originalStamina = getStaminaSnapshot(actor);

    await actor.system.takeDamage(amount, {
      type: type,
      ignoredImmunities: ignoredImmunities || [],
      sourceItemId: sourceItemId
    });

    let newStamina = getStaminaSnapshot(actor);
    newStamina = applyStaminaBounds(actor, newStamina);

    if (newStamina.permanent !== getStaminaSnapshot(actor).permanent) {
      await actor.update({'system.stamina.value': newStamina.permanent});
    }

    // Calculate actual damage taken (after immunities/weaknesses)
    const actualDamage = originalStamina.permanent - newStamina.permanent;

    await logDamageToChat({
      type: 'damage',
      amount: actualDamage,
      originalAmount: amount,
      damageType: type,
      targetName: actor.name,
      targetTokenId: token.id,
      targetActorId: actor.id,
      originalStamina: originalStamina,
      newStamina: newStamina,
      sourceActorId: sourceActorId || game.user.id,
      sourceActorName: sourceActorName,
      sourceItemName: sourceItemName,
      sourcePlayerName: sourcePlayerName,
      source: 'socket',
      sourceItemId: sourceItemId,
      eventId: eventId,
      timestamp: Date.now()
    });

    return {
      success: true,
      tokenName: token.name,
      damageApplied: actualDamage
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM damage error:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * GM handler: Apply healing to a target
 */
async function handleGMHealApplication({ tokenId, amount, type, sourceActorName, sourceActorId, sourceItemName, sourcePlayerName, sourceItemId, eventId }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  // Handler-level validation
  amount = Math.round(parseFloat(amount) || 0);
  if (isNaN(amount)) {
    console.error(`${MODULE_ID}: Invalid healing amount: ${amount}`);
    return { success: false, error: "Invalid healing amount" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    const originalStamina = getStaminaSnapshot(actor);

    const isTemp = type !== "value";
    const currentTemp = actor.system.stamina?.temporary || 0;

    if (isTemp) {
      const newTemp = Math.max(currentTemp, amount);
      await actor.update({
        'system.stamina.temporary': newTemp
      });
    } else {
      const newPerm = Math.round(parseFloat(actor.system.stamina?.value || 0) + amount);
      const max = actor.system?.stamina?.max || 0;
      const boundedPerm = Math.min(newPerm, max);

      await actor.update({
        'system.stamina.value': boundedPerm
      });
    }

    let newStamina = getStaminaSnapshot(actor);

    await logDamageToChat({
      type: "heal",
      amount: amount,
      damageType: type,
      targetName: actor.name,
      targetTokenId: token.id,
      targetActorId: actor.id,
      originalStamina: originalStamina,
      newStamina: newStamina,
      sourceActorId: sourceActorId || game.user.id,
      sourceActorName: sourceActorName,
      sourceItemName: sourceItemName,
      sourcePlayerName: sourcePlayerName,
      source: 'socket',
      sourceItemId: sourceItemId,
      eventId: eventId,
      timestamp: Date.now()
    });

    return {
      success: true,
      tokenName: token.name,
      healingApplied: amount
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM healing error:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Log damage/healing to chat (public or private based on setting)
 */
async function logDamageToChat(entry) {
  try {
    const icon = entry.type === 'damage' ? '⚔️' : '✨';
    const sourceLabel = entry.source === 'socket' ? `(via ${entry.sourcePlayerName})` : '(direct GM action)';

    let staminaDisplay = `${entry.originalStamina.permanent} → ${entry.newStamina.permanent}`;
    if (entry.originalStamina.temporary > 0 || entry.newStamina.temporary > 0) {
      staminaDisplay = `Perm: ${entry.originalStamina.permanent}→${entry.newStamina.permanent} | Temp: ${entry.originalStamina.temporary}→${entry.newStamina.temporary}`;
    }

    const isPublic = game.settings.get(MODULE_ID, 'publicDamageLog');

    const hookPayload = await prepareHookPayload(entry);

    // Build damage display showing immunity/weakness reduction
    let damageDisplay = `${entry.amount} ${entry.damageType}`;
    if (entry.originalAmount && entry.originalAmount !== entry.amount) {
      const reduction = entry.originalAmount - entry.amount;
      if (reduction > 0) {
        damageDisplay = `${entry.amount} ${entry.damageType} <span style="color: #2a9d8f; font-size: 0.9em;">(was ${entry.originalAmount}, reduced by ${reduction} immunity)</span>`;
      } else if (reduction < 0) {
        damageDisplay = `${entry.amount} ${entry.damageType} <span style="color: #e76f51; font-size: 0.9em;">(was ${entry.originalAmount}, increased by ${Math.abs(reduction)} weakness)</span>`;
      }
    }

    const publicContent = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'damage' ? '#e76f51' : '#2a9d8f'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'damage' ? 'DAMAGE' : 'HEALING'}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.targetName}</strong> hit by <strong>${entry.sourceActorName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          ${damageDisplay}
        </div>
      </div>
    `;

    const privateContent = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'damage' ? '#e76f51' : '#2a9d8f'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'damage' ? 'DAMAGE' : 'HEALING'}</strong>
          <span style="font-size: 0.8em; color: #aaa;">${sourceLabel}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.targetName}</strong> hit by <strong>${entry.sourceActorName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          ${damageDisplay}
          (Stamina: ${staminaDisplay})
        </div>
        <div style="margin-top: 8px;">
          <button
            class="damage-undo-btn"
            data-target-token="${entry.targetTokenId}"
            data-original-perm="${entry.originalStamina.permanent}"
            data-original-temp="${entry.originalStamina.temporary}"
            data-target-name="${entry.targetName}"
            data-event-id="${entry.eventId || ''}"
            style="
              background: #e76f51;
              color: white;
              border: none;
              padding: 4px 8px;
              border-radius: 3px;
              cursor: pointer;
              font-weight: bold;
              font-size: 0.9em;
            "
          >
            ↶ Undo
          </button>
        </div>
      </div>
    `;

    const damageSymbol = entry.type === 'damage' ? '−' : '+';
    const undoColor = entry.type === 'damage' ? '#e76f51' : '#2a9d8f';

    const compactUndoContent = `
      <div style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 11px;">
        <button
          class="damage-undo-btn"
          data-target-token="${entry.targetTokenId}"
          data-original-perm="${entry.originalStamina.permanent}"
          data-original-temp="${entry.originalStamina.temporary}"
          data-target-name="${entry.targetName}"
          data-event-id="${entry.eventId || ''}"
          style="
            background: ${undoColor};
            color: white;
            border: none;
            padding: 3px 6px;
            border-radius: 3px;
            cursor: pointer;
            font-weight: bold;
            font-size: 10px;
            white-space: nowrap;
            flex-shrink: 0;
          "
        >
          ↶ Undo
        </button>
        <span style="color: #333; font-weight: 600;">${entry.targetName}</span>
        <span style="color: #999;">${damageSymbol}${entry.amount} (Perm: ${entry.originalStamina.permanent}→${entry.newStamina.permanent})</span>
      </div>
    `;

    let message;
    if (isPublic) {
      const publicMessage = await ChatMessage.create({
        content: publicContent,
        whisper: []
      });

      const gmUsers = game.users.filter(u => u.isGM && u.active).map(u => u.id);

      message = await ChatMessage.create({
        content: compactUndoContent,
        whisper: gmUsers
      });
    } else {
      const gmUsers = game.users.filter(u => u.isGM && u.active).map(u => u.id);

      message = await ChatMessage.create({
        content: privateContent,
        whisper: gmUsers
      });
    }

    await message.setFlag(MODULE_ID, 'damageEntry', {
      ...entry,
      messageId: message.id
    });

    damageHistory.push({
      ...entry,
      messageId: message.id
    });

    if (hookPayload) {
      try {
        Hooks.callAll('ds-quick-strike:damageApplied', hookPayload);
      } catch (hookError) {
        console.error(`${MODULE_ID}: Error firing damageApplied hook:`, hookError);
      }
    }

  } catch (error) {
    console.error(`${MODULE_ID}: logDamageToChat ERROR:`, error);
  }
}

/**
 * Log status application to chat (public or private based on setting)
 */
async function logStatusToChat(entry) {
  try {
    const icon = entry.type === 'apply' ? '✓' : '✗';
    const sourceLabel = entry.source === 'socket' ? `via ${entry.sourcePlayerName}` : 'direct GM action';

    const privateContent = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'apply' ? '#4CAF50' : '#f44336'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'apply' ? 'STATUS APPLIED' : 'STATUS REMOVED'}</strong>
          <span style="font-size: 0.8em; color: #aaa;">${sourceLabel}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.statusName}</strong> applied to <strong>${entry.targetName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          Source: ${entry.sourceActorName} (${entry.sourceItemName})
        </div>
        ${entry.duration ? `
        <div style="margin-bottom: 4px; font-size: 0.9em; color: #666;">
          Duration: ${entry.duration.label || entry.duration.text || 'Unknown'}
        </div>
        ` : ''}
        ${entry.type === 'apply' ? `
          <div style="margin-top: 8px;">
            <button class="status-undo-btn"
              data-target-token="${entry.targetTokenId}"
              data-target-actor="${entry.targetActorId}"
              data-effect-id="${entry.effectId}"
              data-status-name="${entry.statusName}"
              data-status-id="${entry.statusId}"
              data-event-id="${entry.eventId}"
              style="background: #f44336; color: white; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 0.9em;">
              Undo
            </button>
          </div>
        ` : ''}
      </div>
    `;

    const isPublic = game.settings.get(MODULE_ID, 'publicStatusLog') ?? false;

    let message;
    if (isPublic) {
      const publicContent = `
        <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'apply' ? '#4CAF50' : '#f44336'};">
          <div style="margin-bottom: 8px;">
            <strong>${icon} ${entry.type === 'apply' ? 'STATUS APPLIED' : 'STATUS REMOVED'}</strong>
          </div>
          <div style="margin-bottom: 4px;">
            <strong>${entry.statusName}</strong> → <strong>${entry.targetName}</strong>
          </div>
        </div>
      `;

      message = await ChatMessage.create({
        content: publicContent,
        whisper: []
      });

      const gmUsers = game.users
        .filter(u => u.isGM && u.active)
        .map(u => u.id);

      await ChatMessage.create({
        content: privateContent,
        whisper: gmUsers
      });
    } else {
      const gmUsers = game.users
        .filter(u => u.isGM && u.active)
        .map(u => u.id);

      message = await ChatMessage.create({
        content: privateContent,
        whisper: gmUsers
      });
    }

    damageHistory.push({
      ...entry,
      messageId: message.id,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error(`${MODULE_ID}: logStatusToChat ERROR`, error);
  }
}

/**
 * Extract ability data from a chat message for status application
 */
async function extractAbilityDataFromMessage(message) {
  try {
    let sourceActorId = null;
    let sourceActor = null;

    if (message.author?.character) {
      sourceActor = message.author.character;
      sourceActorId = sourceActor.id;
    } else if (message.author?.isGM && game.user.character) {
      sourceActor = game.user.character;
      sourceActorId = sourceActor.id;
    }

    // Extract ability name and duration from chat message content
    let abilityName = 'Unknown Ability';
    let durationInfo = null;
    let sourcePlayerName = message.author?.name || 'Unknown';

    // Get the message content element using multiple methods
    let messageElement = ui.chat.collection.get(message.id)?.element;

    // Fallback methods if the first one doesn't work
    if (!messageElement) {
      messageElement = document.querySelector(`[data-message-id="${message.id}"]`);
    }

    if (!messageElement) {
      messageElement = message.element;
    }

    if (messageElement) {
      // Look for ability name in the message
      // 0.10.0: ability name is in <h5> inside <document-embed class="draw-steel ability">
      // 0.9.x: ability name is in <h5> inside .message-content
      const abilityHeading = messageElement.querySelector('document-embed.ability h5, .message-content h5, h5');
      if (abilityHeading) {
        abilityName = abilityHeading.textContent.trim();
      } else {
        const alternativeHeading = messageElement.querySelector('h3, h4, .ability-name, .item-name');
        if (alternativeHeading) {
          abilityName = alternativeHeading.textContent.trim();
        }
      }

      // Look for duration information in all definition elements
      const allDescriptions = messageElement.querySelectorAll('dd');

      for (const dd of allDescriptions) {
        const text = dd.textContent.trim();

        if (text.includes('save ends')) {
          // Use Draw Steel's structured duration format
          durationInfo = {
            type: 'draw-steel',
            duration: null,
            remaining: null,
            label: 'Save Ends', // Draw Steel abbreviation for save ends
            end: {
              type: 'save',
              roll: '1d10 + @combat.save.bonus'
            }
          };
          break;
        } else if (text.includes('end of turn') || text.includes('end of next turn')) {
          // Use Draw Steel's structured duration format
          durationInfo = {
            type: 'draw-steel',
            duration: null,
            remaining: null,
            label: 'EoT', // Draw Steel abbreviation for end of turn
            end: {
              type: 'turn',
              roll: null
            }
          };
          break;
        } else if (text.includes('end of encounter') || text.includes('encounter')) {
          // Use Draw Steel's structured duration format
          durationInfo = {
            type: 'draw-steel',
            duration: null,
            remaining: null,
            label: 'EoE', // Draw Steel abbreviation for end of encounter
            end: {
              type: 'encounter',
              roll: null
            }
          };
          break;
        } else if (text.includes('next respite') || text.includes('respite')) {
          // Use Draw Steel's structured duration format
          durationInfo = {
            type: 'draw-steel',
            duration: null,
            remaining: null,
            label: 'Respite', // Draw Steel abbreviation for next respite
            end: {
              type: 'respite',
              roll: null
            }
          };
          break;
        }
      }
    }

    const abilityData = {
      sourceActorId: sourceActorId,
      sourcePlayerName: sourcePlayerName,
      itemId: null,
      itemName: abilityName,
      ability: {
        name: abilityName,
        img: 'icons/svg/daze.svg',
        system: {
          effects: [],
          duration: durationInfo
        }
      },
      duration: durationInfo
    };

    return abilityData;
  } catch (error) {
    console.error(`${MODULE_ID}: Error extracting ability data from message:`, error);
    return null;
  }
}

/**
 * Prepare hook payload with all required data for animation modules
 */
async function prepareHookPayload(entry) {
  try {
    let sourceActor = null;
    let sourceItem = null;
    let keywords = [];

    if (entry.sourceItemId) {
      if (entry.sourceActorId) {
        sourceActor = game.actors.get(entry.sourceActorId);
      }

      if (sourceActor && entry.sourceItemId) {
        sourceItem = sourceActor.items.get(entry.sourceItemId);
        if (sourceItem?.system?.keywords) {
          keywords = sourceItem.system.keywords;
        }
      }
    } else {
      if (entry.sourceActorId) {
        sourceActor = game.actors.get(entry.sourceActorId);
      }
    }

    const sourceTokenData = sourceActor ? getSourceToken(sourceActor) : null;
    const targetActor = game.actors.get(entry.targetActorId);
    const targetTokenData = getTargetToken(entry.targetTokenId);

    const damageType = entry.damageType || 'damage';

    const payload = {
      type: entry.type,
      amount: entry.amount,
      damageType: damageType,

      sourceActorId: entry.sourceActorId || null,
      sourceActorUuid: sourceActor?.uuid || null,
      sourceTokenId: sourceTokenData?.id || null,
      sourceTokenUuid: sourceTokenData?.uuid || null,
      sourceItemName: entry.sourceItemName || 'Attack',
      sourceItemId: entry.sourceItemId || null,
      sourceItemUuid: sourceItem?.uuid || null,
      sourceItem: sourceItem ? {
        id: sourceItem.id,
        name: sourceItem.name,
        type: sourceItem.type,
        img: sourceItem.img
      } : null,

      targetActorId: entry.targetActorId,
      targetActorUuid: targetActor?.uuid || null,
      targetTokenId: targetTokenData?.id || null,
      targetTokenUuid: targetTokenData?.uuid || null,
      targetActor: targetActor ? {
        id: targetActor.id,
        name: targetActor.name,
        type: targetActor.type,
        img: targetActor.img
      } : null,

      keywords: keywords,

      eventId: entry.eventId || `damage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: entry.timestamp || Date.now(),
      isCritical: entry.isCritical || false,
      isHealing: entry.type === 'heal',
      isApplied: true
    };

    return payload;
  } catch (error) {
    console.error(`${MODULE_ID}: Error preparing hook payload:`, error);
    return null;
  }
}

/**
 * Get source token from actor with UUID support
 */
function getSourceToken(actor) {
  if (!actor) return null;

  const token = actor.getActiveTokens()?.[0] || null;
  if (!token) return null;

  return {
    id: token.id,
    uuid: token.document?.uuid || null,
    token: token
  };
}

/**
 * Get target token from canvas with UUID support
 */
function getTargetToken(tokenId) {
  if (!tokenId) return null;

  const token = canvas.tokens.get(tokenId) || null;
  if (!token) return null;

  return {
    id: token.id,
    uuid: token.document?.uuid || null,
    token: token
  };
}

/**
 * Handle undo button clicks in chat
 */
Hooks.on('renderChatMessageHTML', (message, html) => {
  if (!(html instanceof HTMLElement)) {
    return;
  }

  const undoBtn = html.querySelector('.damage-undo-btn');
  if (!undoBtn) return;

  undoBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    const targetTokenId = undoBtn.dataset.targetToken;
    const originalPerm = parseInt(undoBtn.dataset.originalPerm);
    const originalTemp = parseInt(undoBtn.dataset.originalTemp);
    const targetName = undoBtn.dataset.targetName;
    const eventId = undoBtn.dataset.eventId || null;

    if (!game.user.isGM) {
      ui.notifications.error("Only GM can undo damage");
      return;
    }

    const result = await handleGMUndoDamage({
      targetTokenId,
      originalPerm,
      originalTemp,
      targetName,
      messageId: message.id,
      eventId: eventId
    });

    if (result.success) {
      const entry = await message.getFlag(MODULE_ID, 'damageEntry');
      if (entry) {
        const undoTime = new Date().toLocaleTimeString();
        const updatedContent = `
          <div style="font-family: monospace; padding: 8px; border-left: 3px solid #2a9d8f; opacity: 0.6;">
            <div style="margin-bottom: 8px;">
              <strong>✅ UNDONE</strong>
              <span style="font-size: 0.8em; color: #666;">${undoTime}</span>
            </div>
            <div style="margin-bottom: 4px;">
              <strong>${targetName}:</strong> Stamina restored
            </div>
          </div>
        `;
        await message.update({ content: updatedContent });
      }
      ui.notifications.info(`Undo successful - ${targetName} stamina restored`);
    } else {
      ui.notifications.error(`Undo failed: ${result.error}`);
    }
  });
});

/**
 * Handle enricher apply-effect link clicks (e.g., [[/apply frightened]])
 * Routes through GM relay for unowned tokens
 */
async function handleEnricherApplyClick(link, tokens) {
  const statusId = link.dataset.status;
  const effectUuid = link.dataset.uuid;
  const end = link.dataset.end;
  const statusName = link.textContent.trim();
  
  if (!socket) {
    ui.notifications.error("Socket not available");
    return;
  }
  
  const gmUser = game.users.find(u => u.isGM && u.active);
  if (!gmUser) {
    ui.notifications.warn("No GM available to apply status");
    return;
  }
  
  for (const token of tokens) {
    const result = await socket.executeAsGM("applyStatusToTarget", {
      tokenId: token.id,
      statusName,
      statusId,
      statusUuid: effectUuid,
      sourceActorId: null,
      sourceItemId: null,
      sourceItemName: statusName,
      sourcePlayerName: game.user.name,
      ability: null,
      timestamp: Date.now(),
      duration: end ? { type: 'draw-steel', label: end, end: { type: end } } : null
    });
    
    if (result?.success) {
      ui.notifications.info(`Applied ${statusName} to ${token.name}`);
    } else {
      ui.notifications.error(`Failed: ${result?.error || "Unknown error"}`);
    }
  }
}

/**
 * Handle enricher apply-effect link clicks for owned tokens (direct application)
 */
async function handleEnricherApplyClickDirect(link, tokens) {
  const statusId = link.dataset.status;
  const effectUuid = link.dataset.uuid;
  const end = link.dataset.end;
  const statusName = link.textContent.trim();
  const eventId = `status-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const duration = end ? { type: 'draw-steel', label: end, end: { type: end } } : null;
  
  for (const token of tokens) {
    const result = await applyStatusWithLogging({
      token,
      statusId,
      statusName,
      effectUuid,
      sourceActorId: null,
      sourceItemId: null,
      sourceItemName: statusName,
      sourcePlayerName: game.user.name,
      ability: null,
      duration,
      eventId
    });
    
    if (result?.success) {
      ui.notifications.info(`Applied ${statusName} to ${token.name}`);
    } else {
      ui.notifications.error(`Failed to apply ${statusName}: ${result?.error || 'Unknown error'}`);
    }
  }
}

// =========================================================================
// STATUS BUTTON HANDLER (0.9.x FALLBACK + 0.10.0 ENRICHER)
// For 0.10.0+ chat buttons, the ACTION override in installApplyEffectOverride() handles this
// For 0.10.0+ enricher links ([[/apply]]), we need to intercept the anchor clicks
// =========================================================================

Hooks.once("ready", () => {
  const AbilityResultPart = globalThis.ds?.data?.pseudoDocuments?.messageParts?.AbilityResult;
  
  document.addEventListener("click", async (event) => {
    const statusBtn = event.target.closest('button[data-type="status"]');
    const statusLink = event.target.closest('a[data-type="status"], a[data-type="custom"]');
    
    if (!statusBtn && !statusLink) return;
    
    if (statusLink) {
      const targets = Array.from(game.user.targets);
      const controlledTokens = canvas?.tokens?.controlled ?? [];
      
      // Draw Steel's native enricher handler uses CONTROLLED tokens, not TARGETS
      // If user has targets, we must intercept because native handler ignores them
      
      if (targets.length > 0) {
        const unownedTargets = targets.filter(t => !t.actor?.isOwner);
        
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        
        if (game.user.isGM || unownedTargets.length === 0) {
          await handleEnricherApplyClickDirect(statusLink, targets);
        } else {
          await handleEnricherApplyClick(statusLink, unownedTargets);
        }
        return;
      }
      
      if (controlledTokens.length === 0) return;
      
      const unownedTokens = controlledTokens.filter(t => !t.actor?.isOwner);
      
      if (game.user.isGM || unownedTokens.length === 0) return;
      
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      
      await handleEnricherApplyClick(statusLink, unownedTokens);
      return;
    }
    
    // Original 0.9.x button handling continues...
    if (!statusBtn) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    try {
      const messageEl = statusBtn.closest("[data-message-id]");
      if (!messageEl) throw new Error("No message element");

      const messageId = messageEl.dataset.messageId;
      const message = game.messages.get(messageId);
      if (!message) throw new Error("Message not found: " + messageId);

      const statusId = statusBtn.dataset.status;
      const statusName = statusBtn.textContent.trim();
      const effectUuid = statusBtn.dataset.uuid;

      const targets = Array.from(game.user.targets);
      if (!targets.length) {
        ui.notifications.warn("Select a target to apply status");
        return;
      }

      const abilityData = await extractAbilityDataFromMessage(message);
      if (!socket) {
        ui.notifications.error("Socket not available");
        return;
      }

      for (const target of targets) {
        const result = await socket.executeAsGM("applyStatusToTarget", {
          tokenId: target.id,
          statusName,
          statusId,
          statusUuid: effectUuid,
          sourceActorId: abilityData?.sourceActorId,
          sourceItemId: abilityData?.itemId,
          sourceItemName: abilityData?.itemName,
          sourcePlayerName: game.user.name,
          ability: abilityData?.ability,
          timestamp: Date.now(),
          duration: abilityData?.duration
        });

        if (result?.success) {
          ui.notifications.info(`Applied ${statusName} to ${target.name}`);
        } else {
          ui.notifications.error(`Failed: ${result?.error || "Unknown error"}`);
        }
      }

    } catch (error) {
      console.error(`${MODULE_ID}: Status button handler error:`, error);
      ui.notifications.error(`Error: ${error.message}`);
    }

  }, { capture: true });

});

// Handle status undo button clicks in chat
Hooks.on('renderChatMessageHTML', (message, html) => {
  if (!(html instanceof HTMLElement)) {
    return;
  }

  const statusUndoBtn = html.querySelector('.status-undo-btn');
  if (!statusUndoBtn) return;

  statusUndoBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    const tokenId = statusUndoBtn.dataset.targetToken;
    const actorId = statusUndoBtn.dataset.targetActor;
    const effectId = statusUndoBtn.dataset.effectId;
    const statusName = statusUndoBtn.dataset.statusName;
    const statusId = statusUndoBtn.dataset.statusId;
    const eventId = statusUndoBtn.dataset.eventId ?? null;

    if (!game.user.isGM) {
      ui.notifications.error('Only GM can undo status');
      return;
    }

    const result = await handleGMUndoStatus(tokenId, actorId, effectId, statusName, statusId, eventId);

    if (result.success) {
      ui.notifications.info(`Undo successful - ${statusName} removed`);
    } else {
      ui.notifications.error(`Undo failed: ${result.error}`);
    }
  });
});

/**
 * GM handler: Undo damage/healing
 */
async function handleGMUndoDamage({ targetTokenId, originalPerm, originalTemp, targetName, messageId, eventId }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(targetTokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    const currentStamina = getStaminaSnapshot(actor);

    const boundedStamina = applyStaminaBounds(actor, { permanent: originalPerm, temporary: originalTemp });

    await actor.update({
      'system.stamina.value': boundedStamina.permanent,
      'system.stamina.temporary': boundedStamina.temporary
    });

    const undoTime = new Date().toLocaleTimeString();
    const undoMessage = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid #2a9d8f;">
        <div style="margin-bottom: 4px;">
          <strong>✅ Undo applied:</strong> ${targetName} stamina restored
          (was ${currentStamina.permanent}→${boundedStamina.permanent}) at ${undoTime}
        </div>
      </div>
    `;

    const gmUsers = game.users.filter(u => u.isGM && u.active).map(u => u.id);
    await ChatMessage.create({
      content: undoMessage,
      whisper: gmUsers
    });

    const historyEntry = damageHistory.find(h => h.messageId === messageId);
    if (historyEntry) {
      historyEntry.undoTime = undoTime;
    }

    if (eventId) {
      try {
        const targetTokenData = getTargetToken(targetTokenId);
        const undoPayload = {
          eventId: eventId,
          targetName: targetName,
          targetTokenId: targetTokenData?.id || null,
          targetTokenUuid: targetTokenData?.uuid || null,
          targetToken: targetTokenData?.token || null,
          amount: Math.abs(boundedStamina.permanent - currentStamina.permanent),
          damageType: historyEntry?.damageType || 'untyped',
          entry: historyEntry || null
        };

        Hooks.callAll('ds-quick-strike:damageUndone', undoPayload);
      } catch (hookError) {
        console.error(`${MODULE_ID}: Error firing damageUndone hook:`, hookError);
      }
    }

    return {
      success: true,
      tokenName: actor.name,
      restoredStamina: boundedStamina
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM undo error:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * GM handler – Apply a Draw Steel status condition to a target
 */
async function handleGMApplyStatus({
  tokenId,
  statusName,
  statusId,
  statusUuid,
  sourceActorId,
  sourceItemId,
  sourceItemName,
  sourcePlayerName,
  ability = null,
  timestamp,
  eventId = null,
  duration = null
}) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    return await applyStatusWithLogging({
      token,
      statusId,
      statusName,
      effectUuid: statusUuid,
      sourceActorId,
      sourceItemId,
      sourceItemName,
      sourcePlayerName,
      ability,
      duration,
      eventId,
      timestamp
    });
  } catch (error) {
    console.error(`${MODULE_ID}: GM apply status error`, error);
    return { success: false, error: error.message };
  }
}

async function applyStatusWithLogging({
  token,
  statusId,
  statusName,
  effectUuid,
  sourceActorId,
  sourceItemId,
  sourceItemName,
  sourcePlayerName,
  ability = null,
  duration = null,
  eventId = null,
  timestamp = null
}) {
  const actor = token.actor;
  if (!actor) {
    return { success: false, error: "Actor not found" };
  }

  if (effectUuid) {
    try {
      const effectDoc = await fromUuid(effectUuid);
      if (effectDoc && typeof effectDoc.applyEffect === 'function') {
        const tier = effectDoc.tier || effectDoc.parent?.tier || 3;
        const tierKey = `tier${tier}`;
        
        await effectDoc.applyEffect(tierKey, statusId, { targets: [actor] });
        
        const generatedEventId = eventId || `status-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        await logStatusToChat({
          type: "apply",
          statusName: statusName,
          statusId: statusId,
          statusUuid: effectUuid,
          targetName: actor.name,
          targetTokenId: token.id,
          targetActorId: actor.id,
          sourceActorId: sourceActorId,
          sourceActorName: sourcePlayerName ?? "Unknown",
          sourceItemId: sourceItemId,
          sourceItemName: sourceItemName,
          sourcePlayerName: sourcePlayerName,
          source: game.user.isGM ? "direct" : "socket",
          effectId: null,
          eventId: generatedEventId,
          timestamp: timestamp || Date.now(),
          duration: duration
        });
        
        Hooks.callAll("ds-quick-strikeStatusApplied", {
          actorId: actor.id,
          tokenId: token.id,
          statusName: statusName,
          statusId: statusId,
          statusUuid: effectUuid,
          effectId: null,
          sourceActorId: sourceActorId,
          sourceItemId: sourceItemId,
          sourceItemName: sourceItemName,
          sourcePlayerName: sourcePlayerName,
          ability: ability,
          eventId: generatedEventId,
          timestamp: timestamp || Date.now()
        });
        
        return { success: true, statusName: statusName };
      }
    } catch (nativeError) {
      console.warn(`${MODULE_ID}: Native applyEffect failed, falling back:`, nativeError.message);
    }
  }

  const existingStatus = CONFIG.statusEffects.find(e => e.id === statusId);

  if (!existingStatus) {
    console.error(`${MODULE_ID}: Status "${statusId}" not found in CONFIG.statusEffects`);
    return { success: false, error: `Status ${statusId} not found` };
  }

  const hasStatus = actor.effects.some(e => e.statuses?.has(statusId));

  if (!hasStatus) {
    const effectEnd = duration?.end?.type || "";
    await actor.toggleStatusEffect(statusId, { active: true, overlay: false, effectEnd: effectEnd });
  }

  let appliedEffect = actor.effects.find(e => e.statuses?.has(statusId));

  if (!appliedEffect) {
    appliedEffect = actor.effects.find(e => e && e.name === statusName);
  }

  if (!appliedEffect && statusId === 'slowed') {
    appliedEffect = actor.effects.find(e => e && e.id && e.id.includes('slowed'));
  }

  const resolvedEffectId = appliedEffect?.id;

  if (appliedEffect && sourceActorId) {
    await appliedEffect.update({
      'system.source': {
        actorId: sourceActorId,
        actorName: sourcePlayerName ?? "Unknown",
        itemId: sourceItemId,
        itemName: sourceItemName
      }
    });
  }

  const generatedEventId = eventId || `status-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  await logStatusToChat({
    type: "apply",
    statusName: statusName,
    statusId: statusId,
    statusUuid: effectUuid,
    targetName: actor.name,
    targetTokenId: token.id,
    targetActorId: actor.id,
    sourceActorId: sourceActorId,
    sourceActorName: sourcePlayerName ?? "Unknown",
    sourceItemId: sourceItemId,
    sourceItemName: sourceItemName,
    sourcePlayerName: sourcePlayerName,
    source: game.user.isGM ? "direct" : "socket",
    effectId: resolvedEffectId,
    eventId: generatedEventId,
    timestamp: timestamp || Date.now(),
    duration: duration
  });

  Hooks.callAll("ds-quick-strikeStatusApplied", {
    actorId: actor.id,
    tokenId: token.id,
    statusName: statusName,
    statusId: statusId,
    statusUuid: effectUuid,
    effectId: null,
    sourceActorId: sourceActorId,
    sourceItemId: sourceItemId,
    sourceItemName: sourceItemName,
    sourcePlayerName: sourcePlayerName,
    ability: ability,
    eventId: generatedEventId,
    timestamp: timestamp || Date.now()
  });

  return { success: true, statusName: statusName };
}

/**
 * GM handler – Undo a Draw Steel status condition
 */
async function handleGMUndoStatus(
  tokenId, actorId, effectId, statusName, statusId, eventId = null
) {
  if (!game.user.isGM) return { success: false, error: "Unauthorized" };

  try {
    const token = tokenId ? canvas.tokens.get(tokenId) : null;
    const actor = token?.actor || (actorId ? game.actors.get(actorId) : null);

    if (!actor) {
      console.error(`${MODULE_ID}: Actor lookup failed - tokenId=${tokenId}, actorId=${actorId}`);
      return { success: false, error: "Actor not found" };
    }

    // Find by name matching
    const statusEffect = actor.effects.find(e =>
      e.name.toLowerCase() === statusName.toLowerCase()
    );

    if (!statusEffect) {
      console.warn(`${MODULE_ID}: Effect not found: "${statusName}"`);
      return { success: false, error: `Status not found on ${actor.name}` };
    }

    await statusEffect.delete();

    const undoTime = new Date().toLocaleTimeString();
    const undoMessage = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid #2196F3; opacity: 0.7;">
        <div style="margin-bottom: 4px;">
          <strong>↶ UNDO</strong> <span style="font-size: 0.8em; color: #666;">${undoTime}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${statusName}</strong> removed from <strong>${actor.name}</strong>
        </div>
      </div>
    `;

    const gmUsers = game.users
      .filter(u => u.isGM && u.active)
      .map(u => u.id);

    await ChatMessage.create({
      content: undoMessage,
      whisper: gmUsers
    });

    try {
      Hooks.callAll("ds-quick-strikeStatusUndone", {
        actorId: actor.id,
        tokenId: token?.id ?? null,
        statusName: statusName,
        effectId: null,
        eventId: eventId,
        timestamp: Date.now()
      });
    } catch (hookError) {
      console.error(`${MODULE_ID}: Error firing ds-quick-strikeStatusUndone hook`, hookError);
    }

    return { success: true };

  } catch (error) {
    console.error(`${MODULE_ID}: GM undo status error`, error);
    return { success: false, error: error.message };
  }
}