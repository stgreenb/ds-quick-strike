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

    // ✅ Wrapped handlers with type coercion (Layer 1: Socket Handler Wrapper)
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
  };

  waitForDependencies();
});

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
    // ✅ Layer 3: Actor method guard (BELT & SUSPENDERS)
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
      const li = event.currentTarget.closest("[data-message-id]");
      if (!li) return;

      const message = game.messages.get(li.dataset.messageId);
      if (!message) return;

      const rollIndex = event.currentTarget.dataset.index;
      const roll = message.rolls[rollIndex];
      if (!roll) return;

      let amount = roll.total;
      if (event.shiftKey) {
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
          } else if (message.system?.uuid) {
            try {
              const sourceItem = await fromUuid(message.system.uuid);
              if (sourceItem) {
                sourceItemName = sourceItem.name;
              }
            } catch (e) {
              console.warn(`${MODULE_ID}: Could not load item from UUID: ${message.system.uuid}`, e);
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

  // ✅ Layer 2: Handler-level validation (DEFENSIVE)
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

    await logDamageToChat({
      type: 'damage',
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
      damageApplied: amount
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

  // ✅ Layer 2: Handler-level validation (DEFENSIVE)
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

    if (isTemp && amount > currentTemp) {
      console.warn(`${MODULE_ID}: Temporary stamina capped for ${actor.name}`);
    }

    // Direct update to avoid modifyTokenAttribute string conversion issues
    if (isTemp) {
      // Temporary stamina healing
      const newTemp = Math.round(parseFloat(actor.system.stamina?.temporary || 0) + amount);
      await actor.update({
        'system.stamina.temporary': newTemp
      });
    } else {
      // Permanent stamina healing
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

    const publicContent = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'damage' ? '#e76f51' : '#2a9d8f'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'damage' ? 'DAMAGE' : 'HEALING'}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.targetName}</strong> hit by <strong>${entry.sourceActorName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          ${entry.amount} ${entry.damageType}
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
          ${entry.amount} ${entry.damageType}
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
      const abilityHeading = messageElement.querySelector('.message-content h5');
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

// =========================================================================
// EVENT DELEGATION: Status Button Handler (PERMANENT DOCUMENT LISTENER)
// =========================================================================

Hooks.once("ready", () => {
  
  document.addEventListener("click", async (event) => {
    const statusBtn = event.target.closest('button[data-type="status"]');
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

      const statusId = statusBtn.dataset.effectId;
      const statusName = statusBtn.textContent.trim();
      const effectUuid = statusBtn.dataset.uuid;

      const targets = Array.from(game.user.targets);
      if (!targets.length) {
        ui.notifications.warn("Select a target to apply status");
        return;
      }

      const abilityData = await extractAbilityDataFromMessage(message);
      if (!abilityData) {
        console.warn(`${MODULE_ID}: No ability data extracted`);
        ui.notifications.warn("Could not extract ability");
        return;
      }

      if (!socket) {
        console.error(`${MODULE_ID}: Socket not available`);
        ui.notifications.error("Socket not available");
        return;
      }

      for (const target of targets) {

        
        const result = await socket.executeAsGM("applyStatusToTarget", {
          tokenId: target.id,
          statusName,
          statusId,
          statusUuid: effectUuid,
          sourceActorId: abilityData.sourceActorId,
          sourceItemId: abilityData.itemId,
          sourceItemName: abilityData.itemName,
          sourcePlayerName: abilityData.sourcePlayerName || game.user.name,
          ability: abilityData.ability,
          timestamp: Date.now(),
          duration: abilityData.duration
        });

        if (!result) {
          console.error(`${MODULE_ID}: Socket returned no result`);
          ui.notifications.error("Socket error - no response");
          continue;
        }

        if (result.success) {
          ui.notifications.info(`Applied ${statusName} to ${target.name}`);
        } else {
          console.error(`${MODULE_ID}: Failed to apply ${statusName}:`, result.error);
          ui.notifications.error(`Failed: ${result.error}`);
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

// =========================================================================
// EVENT DELEGATION: Enricher Button Handler
// Intercepts damage, healing, apply effect, and gain resource buttons
// =========================================================================

Hooks.once("ready", () => {
  document.addEventListener("click", async (event) => {
    const clickedEl = event.target;

    // Check for enricher-generated buttons AND links
    // Priority order: damage, heal, apply, gain

    // Damage buttons (can be button or a tags)
    const damageBtn = clickedEl.closest('[data-type="damage"], [data-action="damage"], [data-enricher*="damage"], .damage-link');

    // Healing buttons
    const healBtn = clickedEl.closest('[data-type="heal"], [data-action="heal"], [data-enricher*="heal"], .heal-link');

    // Apply effect - Draw Steel uses <a> tags with data-type="status" or "custom"
    const applyBtn = clickedEl.closest('a[data-type="status"], a[data-type="custom"]');

    // Gain buttons
    const gainBtn = clickedEl.closest('[data-type="gain"], [data-action="gain"], [data-enricher*="gain"], .gain-link');

    // Combine all enricher elements
    const enricherBtn = damageBtn || healBtn || applyBtn || gainBtn;

    // Debug: log clicks on roll-links (enricher class name)
    if (!enricherBtn && clickedEl.closest('.roll-link')) {
      console.log(`${MODULE_ID}: [DEBUG] Clicked roll-link:`, {
        tag: clickedEl.tagName,
        className: clickedEl.className,
        text: clickedEl.textContent?.trim()?.substring(0, 50),
        dataset: clickedEl.dataset
      });
    }

    if (!enricherBtn) return;

    // Determine the action type
    let actionType = 'damage';
    if (healBtn) actionType = 'heal';
    else if (applyBtn) actionType = 'apply';
    else if (gainBtn) actionType = 'gain';

    console.log(`${MODULE_ID}: [ENRICHER] ${actionType.toUpperCase()} intercepted`);
    console.log(`${MODULE_ID}: [ENRICHER] Tag: ${enricherBtn.tagName}, class: ${enricherBtn.className}, text: "${enricherBtn.textContent?.trim()}"`);
    console.log(`${MODULE_ID}: [ENRICHER] Dataset:`, enricherBtn.dataset);

    // Stop propagation to prevent Draw Steel's default handler
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    try {
      // Get the chat message element
      const messageEl = enricherBtn.closest("[data-message-id]");
      if (!messageEl) {
        console.warn(`${MODULE_ID}: [ENRICHER] No message element found`);
        return;
      }

      const messageId = messageEl.dataset.messageId;
      const message = game.messages.get(messageId);
      if (!message) {
        console.warn(`${MODULE_ID}: [ENRICHER] Message not found: ${messageId}`);
        return;
      }

      console.log(`${MODULE_ID}: [ENRICHER] Message ID: ${messageId}, Speaker: ${message.speaker?.actor || 'none'}`);

      // Determine targets: use targets first, fall back to selection
      const targetedTokens = Array.from(game.user.targets);
      const selectedTokens = Array.from(canvas.tokens.controlled || []);

      console.log(`${MODULE_ID}: [ENRICHER] Targeted: ${targetedTokens.length}, Selected: ${selectedTokens.length}`);

      let targets = targetedTokens;
      if (targets.length === 0) {
        targets = selectedTokens;
        console.log(`${MODULE_ID}: [ENRICHER] No targets, falling back to selected tokens`);
      }

      if (targets.length === 0) {
        console.warn(`${MODULE_ID}: [ENRICHER] No tokens targeted or selected`);
        ui.notifications.warn("Select or target a token to apply this action");
        return;
      }

      // Check if any target is not owned by the user (needs GM relay)
      const ownedTargets = targets.filter(t => t.isOwner);
      const nonOwnedTargets = targets.filter(t => !t.isOwner);

      console.log(`${MODULE_ID}: [ENRICHER] Owned targets: ${ownedTargets.length}, Non-owned: ${nonOwnedTargets.length}`);

      if (nonOwnedTargets.length > 0) {
        console.log(`${MODULE_ID}: [ENRICHER] Non-owned targets: ${nonOwnedTargets.map(t => t.name).join(', ')}`);
      }

      // Extract action data from button and message
      const actionData = await extractEnricherActionData(enricherBtn, message, actionType);
      if (!actionData) {
        console.warn(`${MODULE_ID}: [ENRICHER] Could not extract action data`);
        return;
      }

      console.log(`${MODULE_ID}: [ENRICHER] Action data: type=${actionData.type}, amount=${actionData.amount}, damageType=${actionData.damageType || 'none'}`);

      if (!socket) {
        console.error(`${MODULE_ID}: [ENRICHER] Socket not available`);
        ui.notifications.error("Socket not available");
        return;
      }

      // Process each target
      let skippedTargets = [];

      for (const target of targets) {
        const isOwned = target.isOwner;
        console.log(`${MODULE_ID}: [ENRICHER] Processing target: ${target.name} (owned: ${isOwned})`);

        // Skip non-hero targets for gain actions
        if (actionType === 'gain' && !isHero(target.actor)) {
          console.log(`${MODULE_ID}: [ENRICHER] Skipping non-hero target: ${target.name}`);
          skippedTargets.push(target.name);
          continue;
        }

        if (isOwned) {
          // Apply directly (user owns the target)
          console.log(`${MODULE_ID}: [ENRICHER] Applying ${actionType} directly to ${target.name}`);
          await applyActionDirectly(target, actionType, actionData, message);
        } else {
          // Route through GM relay (user doesn't own the target)
          console.log(`${MODULE_ID}: [ENRICHER] Routing ${actionType} via GM relay for ${target.name}`);
          await applyActionViaGMRelay(target, actionType, actionData, message);
        }
      }

      // Notify about skipped targets
      if (skippedTargets.length > 0) {
        if (actionType === 'gain') {
          ui.notifications.warn(`Skipped ${skippedTargets.length} non-hero target(s): ${skippedTargets.join(', ')}`);
        }
      }

      // Notify if no actions were actually applied
      const processedCount = targets.length - skippedTargets.length;
      if (processedCount === 0 && skippedTargets.length > 0) {
        if (actionType === 'gain') {
          ui.notifications.warn(`Gain resources requires hero targets - untarget non-heroes or target yourself`);
        }
      }

      console.log(`${MODULE_ID}: [ENRICHER] ${actionType.toUpperCase()} action complete for ${targets.length} target(s)`);

    } catch (error) {
      console.error(`${MODULE_ID}: [ENRICHER] Error:`, error);
      ui.notifications.error(`Error: ${error.message}`);
    }
  }, { capture: true });
});

/**
 * Extract action data from an enricher button and its message
 */
async function extractEnricherActionData(button, message, actionType) {
  try {
    const data = {
      type: actionType,
      amount: null,
      damageType: null,
      effectUuid: null,
      effectName: null,
      resourceType: null,
      resourceAmount: null,
      sourceActorId: null,
      sourceItemId: null,
      sourceItemName: null
    };

    // Extract amount from button dataset or message
    if (button.dataset.amount) {
      data.amount = parseFloat(button.dataset.amount);
      console.log(`${MODULE_ID}: [ENRICHER] Amount from button.dataset: ${data.amount}`);
    } else if (message.rolls?.[0]?.total) {
      data.amount = message.rolls[0].total;
      console.log(`${MODULE_ID}: [ENRICHER] Amount from message roll: ${data.amount}`);
    } else {
      console.log(`${MODULE_ID}: [ENRICHER] No amount found in button or message`);
    }

    // Extract damage/healing type
    if (button.dataset.type) {
      data.damageType = button.dataset.type;
      console.log(`${MODULE_ID}: [ENRICHER] Damage type from dataset: ${data.damageType}`);
    }

    // Extract effect data for apply actions
    if (actionType === 'apply') {
      // For status effects, data-status contains the status ID
      // For custom effects, data-uuid contains the effect UUID
      data.effectUuid = button.dataset.uuid || button.dataset.status || button.dataset.effectId;
      data.effectName = button.textContent?.trim() || button.dataset.tooltip?.split('\n')[0] || 'Unknown Effect';
      console.log(`${MODULE_ID}: [ENRICHER] Effect type: ${button.dataset.type}, UUID/Status: ${data.effectUuid}, Name: ${data.effectName}`);
    }

    // Extract resource data for gain actions
    if (actionType === 'gain') {
      data.resourceType = button.dataset.resourceType || button.dataset.gainType || 'heroic';
      data.resourceAmount = parseFloat(button.dataset.amount) || parseFloat(button.dataset.formula) || 1;
      console.log(`${MODULE_ID}: [ENRICHER] Resource type: ${data.resourceType}, Amount: ${data.resourceAmount}`);
    }

    // Try to extract source info from message
    if (message.speaker?.actor) {
      data.sourceActorId = message.speaker.actor;
      console.log(`${MODULE_ID}: [ENRICHER] Source actor ID: ${data.sourceActorId}`);
      if (message.speaker?.item) {
        data.sourceItemId = message.speaker.item;
        const sourceActor = game.actors.get(message.speaker.actor);
        if (sourceActor) {
          const sourceItem = sourceActor.items.get(message.speaker.item);
          if (sourceItem) {
            data.sourceItemName = sourceItem.name;
            console.log(`${MODULE_ID}: [ENRICHER] Source item: ${data.sourceItemName}`);
          }
        }
      }
    }

    console.log(`${MODULE_ID}: [ENRICHER] Extracted data:`, data);
    return data;
  } catch (error) {
    console.error(`${MODULE_ID}: [ENRICHER] Error extracting action data:`, error);
    return null;
  }
}

/**
 * Apply an enricher action directly (user owns the target)
 */
async function applyActionDirectly(token, actionType, actionData, message) {
  const actor = token.actor;
  if (!actor) {
    console.warn(`${MODULE_ID}: [ENRICHER] No actor found for token ${token.name}`);
    return;
  }

  console.log(`${MODULE_ID}: [ENRICHER] Direct apply to ${token.name} (${actor.id}), type=${actionType}, amount=${actionData.amount}`);

  try {
    switch (actionType) {
      case 'damage':
        if (actionData.amount > 0) {
          console.log(`${MODULE_ID}: [ENRICHER] Taking damage: ${actionData.amount} ${actionData.damageType || 'untyped'}`);
          await actor.system.takeDamage(actionData.amount, {
            type: actionData.damageType || 'untyped'
          });
          console.log(`${MODULE_ID}: [ENRICHER] Damage applied successfully to ${token.name}`);
          ui.notifications.info(`Applied ${actionData.amount} damage to ${token.name}`);
        } else {
          console.warn(`${MODULE_ID}: [ENRICHER] No damage amount to apply`);
        }
        break;

      case 'heal':
        if (actionData.amount > 0) {
          const currentValue = actor.system.stamina?.value || 0;
          const maxValue = actor.system.stamina?.max || 0;
          const healAmount = Math.min(actionData.amount, maxValue - currentValue);
          console.log(`${MODULE_ID}: [ENRICHER] Healing: ${actionData.amount}, current=${currentValue}, max=${maxValue}, actual=${healAmount}`);
          if (healAmount > 0) {
            await actor.update({
              'system.stamina.value': currentValue + healAmount
            });
            console.log(`${MODULE_ID}: [ENRICHER] Healing applied successfully to ${token.name}`);
            ui.notifications.info(`Healed ${token.name} for ${healAmount}`);
          } else {
            console.log(`${MODULE_ID}: [ENRICHER] No healing needed for ${token.name} (at max stamina)`);
          }
        }
        break;

      case 'apply':
        if (!actionData.effectUuid) {
          console.warn(`${MODULE_ID}: [ENRICHER] No effect UUID or status provided`);
          break;
        }

        console.log(`${MODULE_ID}: [ENRICHER] Applying effect: ${actionData.effectUuid} (${actionData.effectName})`);

        try {
          // Check if it's a status effect (from CONFIG.statusEffects) or a custom effect (UUID)
          const statusEffect = CONFIG.statusEffects?.find(s => s.id === actionData.effectUuid);

          if (statusEffect) {
            // It's a canonical status effect
            console.log(`${MODULE_ID}: [ENRICHER] Applying status effect: ${statusEffect.name}`);
            await actor.toggleStatusEffect(actionData.effectUuid, { active: true, overlay: false });
            console.log(`${MODULE_ID}: [ENRICHER] Status effect applied successfully`);
            ui.notifications.info(`Applied ${actionData.effectName} to ${token.name}`);
          } else {
            // Try to load as a custom effect UUID
            const effect = await fromUuid(actionData.effectUuid);
            if (effect) {
              console.log(`${MODULE_ID}: [ENRICHER] Custom effect loaded: ${effect.name}`);
              // Remove disabled existing effects with same ID
              const existing = actor.effects.get(effect.id);
              if (existing?.disabled) {
                console.log(`${MODULE_ID}: [ENRICHER] Removing disabled existing effect`);
                await existing.delete();
              }
              const result = await actor.createEmbeddedDocuments("ActiveEffect", [effect.toObject()]);
              console.log(`${MODULE_ID}: [ENRICHER] Effect created: ${result[0]?.id}`);
              ui.notifications.info(`Applied ${actionData.effectName} to ${token.name}`);
            } else {
              console.warn(`${MODULE_ID}: [ENRICHER] Effect not found: ${actionData.effectUuid}`);
            }
          }
        } catch (e) {
          console.error(`${MODULE_ID}: [ENRICHER] Failed to apply effect:`, e);
        }
        break;

      case 'gain':
        // Handle resource gain - depends on Draw Steel's resource system
        const resourceField = getResourceField(actor, actionData.resourceType);
        if (resourceField) {
          const currentValue = getProperty(actor.system, resourceField.path) || 0;
          console.log(`${MODULE_ID}: [ENRICHER] Resource gain: ${actionData.resourceType}, adding ${actionData.resourceAmount} (current=${currentValue})`);
          await actor.update({
            [resourceField.path]: currentValue + actionData.resourceAmount
          });
          console.log(`${MODULE_ID}: [ENRICHER] Resource gained successfully for ${token.name}`);
          ui.notifications.info(`Gained ${actionData.resourceAmount} ${actionData.resourceType} for ${token.name}`);
        } else {
          console.warn(`${MODULE_ID}: [ENRICHER] Unknown resource type: ${actionData.resourceType}`);
        }
        break;
    }
  } catch (error) {
    console.error(`${MODULE_ID}: [ENRICHER] Error applying action directly to ${token.name}:`, error);
  }
}

/**
 * Apply an enricher action via GM relay (user doesn't own the target)
 */
async function applyActionViaGMRelay(token, actionType, actionData, message) {
  if (!socket) {
    console.warn(`${MODULE_ID}: [ENRICHER] No socket available for GM relay`);
    return;
  }

  const eventId = `enricher-${actionType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`${MODULE_ID}: [ENRICHER] GM relay request: ${actionType} to ${token.name}, eventId=${eventId}`);

  try {
    switch (actionType) {
      case 'damage':
      case 'heal':
        console.log(`${MODULE_ID}: [ENRICHER] Sending ${actionType} request via GM relay: amount=${actionData.amount}, type=${actionData.damageType || 'untyped'}`);
        const result = await socket.executeAsGM('applyDamageToTarget', {
          tokenId: token.id,
          amount: actionData.amount,
          type: actionData.damageType || 'untyped',
          sourceActorId: actionData.sourceActorId,
          sourceItemName: actionData.sourceItemName,
          sourcePlayerName: game.user.name,
          sourceItemId: actionData.sourceItemId,
          eventId: eventId
        });
        console.log(`${MODULE_ID}: [ENRICHER] GM relay result for ${token.name}:`, result);
        if (result.success) {
          ui.notifications.info(`${actionType === 'heal' ? 'Healed' : 'Damaged'} ${token.name} for ${actionData.amount}`);
        } else {
          console.warn(`${MODULE_ID}: [ENRICHER] GM relay failed: ${result.error}`);
        }
        break;

      case 'apply':
        console.log(`${MODULE_ID}: [ENRICHER] Sending apply effect request via GM relay: ${actionData.effectName}`);
        const applyResult = await socket.executeAsGM('applyStatusToTarget', {
          tokenId: token.id,
          statusName: actionData.effectName,
          statusId: actionData.effectUuid,
          statusUuid: actionData.effectUuid,
          sourceActorId: actionData.sourceActorId,
          sourceItemId: actionData.sourceItemId,
          sourceItemName: actionData.sourceItemName,
          sourcePlayerName: game.user.name,
          ability: { name: actionData.effectName },
          timestamp: Date.now(),
          duration: null
        });
        console.log(`${MODULE_ID}: [ENRICHER] GM relay apply result for ${token.name}:`, applyResult);
        if (applyResult.success) {
          ui.notifications.info(`Applied ${actionData.effectName} to ${token.name}`);
        } else {
          console.warn(`${MODULE_ID}: [ENRICHER] GM relay apply failed: ${applyResult.error}`);
        }
        break;

      case 'gain':
        console.log(`${MODULE_ID}: [ENRICHER] Sending resource gain via GM relay: ${actionData.resourceType} x${actionData.resourceAmount}`);
        const gainResult = await socket.executeAsGM('applyResourceGain', {
          tokenId: token.id,
          resourceType: actionData.resourceType,
          amount: actionData.resourceAmount,
          sourcePlayerName: game.user.name,
          eventId: eventId
        });
        console.log(`${MODULE_ID}: [ENRICHER] GM relay gain result for ${token.name}:`, gainResult);
        if (gainResult.success) {
          ui.notifications.info(`Gained ${actionData.resourceAmount} ${actionData.resourceType} for ${token.name}`);
        } else {
          console.warn(`${MODULE_ID}: [ENRICHER] GM relay gain failed: ${gainResult.error}`);
        }
        break;
    }
  } catch (error) {
    console.error(`${MODULE_ID}: [ENRICHER] Error in GM relay for ${token.name}:`, error);
    ui.notifications.error(`Failed to apply ${actionType}: ${error.message}`);
  }
}

/**
 * Get the actor system path for a resource type
 */
function getResourceField(actor, resourceType) {
  const resourceMap = {
    'heroic': { path: 'resources.heroic.value' },
    'epic': { path: 'resources.epic.value' },
    'surge': { path: 'resources.surge.value' },
    'progression': { path: 'resources.progression.value' },
    'renown': { path: 'resources.renown.value' },
    'wealth': { path: 'resources.wealth.value' },
    'victory': { path: 'resources.victory.value' }
  };

  return resourceMap[resourceType.toLowerCase()] || null;
}

/**
 * GM handler: Apply resource gain to a target
 */
async function handleGMResourceGain({ tokenId, resourceType, amount, sourcePlayerName, eventId }) {
  console.log(`${MODULE_ID}: [GM] Received applyResourceGain request: tokenId=${tokenId}, type=${resourceType}, amount=${amount}, from=${sourcePlayerName}`);

  if (!game.user.isGM) {
    console.warn(`${MODULE_ID}: [GM] Unauthorized resource gain attempt`);
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      console.warn(`${MODULE_ID}: [GM] Token not found: ${tokenId}`);
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      console.warn(`${MODULE_ID}: [GM] Actor not found for token: ${tokenId}`);
      return { success: false, error: "Actor not found" };
    }

    console.log(`${MODULE_ID}: [GM] Processing resource gain for ${actor.name}`);

    const field = getResourceField(actor, resourceType);
    if (!field) {
      console.warn(`${MODULE_ID}: [GM] Unknown resource type: ${resourceType}`);
      return { success: false, error: `Unknown resource type: ${resourceType}` };
    }

    const currentValue = getProperty(actor.system, field.path) || 0;
    console.log(`${MODULE_ID}: [GM] Current ${resourceType}: ${currentValue}, adding ${amount}`);

    await actor.update({
      [field.path]: currentValue + amount
    });

    const newValue = getProperty(actor.system, field.path);
    console.log(`${MODULE_ID}: [GM] Success: ${actor.name} now has ${newValue} ${resourceType} (was ${currentValue})`);

    return { success: true, resourceType, amount, tokenName: token.name, newValue };
  } catch (error) {
    console.error(`${MODULE_ID}: [GM] Resource gain error:`, error);
    return { success: false, error: error.message };
  }
}

// Register the new GM handler
Hooks.once('socketlib.ready', () => {
  if (socket) {
    socket.register('applyResourceGain', handleGMResourceGain);
  }
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

    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    // Find in CONFIG
    const existingStatus = CONFIG.statusEffects.find(e => e.id === statusId);

    if (!existingStatus) {
      console.error(`${MODULE_ID}: Status "${statusId}" not found in CONFIG.statusEffects`);
      return { success: false, error: `Status ${statusId} not found` };
    }

    // Check if the status is already active
    const hasStatus = actor.effects.some(e => e.getFlag('core', 'statusId') === statusId);

    if (!hasStatus) {
      // Pass the effect end type if duration is available
      const effectEnd = duration?.end?.type || "";
      await actor.toggleStatusEffect(statusId, { active: true, overlay: false, effectEnd: effectEnd });
    }

    // Find the created effect for tracking
    let appliedEffect = actor.effects.find(e => e && e.getFlag && e.getFlag('core', 'statusId') === statusId);

    // Fallback: find by name if flag lookup fails
    if (!appliedEffect) {
      appliedEffect = actor.effects.find(e => e && e.name === statusName);
    }

    // Second fallback: find by ID pattern
    if (!appliedEffect && statusId === 'slowed') {
      appliedEffect = actor.effects.find(e => e && e.id && e.id.includes('slowed'));
    }

    const effectId = appliedEffect?.id;

    // Set the source information on the created effect if it exists
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
      statusUuid: statusUuid,
      targetName: actor.name,
      targetTokenId: token.id,
      targetActorId: actor.id,
      sourceActorId: sourceActorId,
      sourceActorName: sourcePlayerName ?? "Unknown", // Use the player name as source
      sourceItemId: sourceItemId,
      sourceItemName: sourceItemName,
      sourcePlayerName: sourcePlayerName,
      source: "socket",
      effectId: effectId,
      eventId: generatedEventId,
      timestamp: timestamp,
      duration: duration
    });

    const hookPayload = {
      actorId: actor.id,
      tokenId: token.id,
      statusName: statusName,
      statusId: statusId,
      statusUuid: statusUuid,
      effectId: null,
      sourceActorId: sourceActorId,
      sourceItemId: sourceItemId,
      sourceItemName: sourceItemName,
      sourcePlayerName: sourcePlayerName,
      ability: ability,
      eventId: generatedEventId,
      timestamp: timestamp
    };

    try {
      Hooks.callAll("ds-quick-strikeStatusApplied", hookPayload);
    } catch (hookError) {
      console.error(`${MODULE_ID}: Error firing ds-quick-strikeStatusApplied hook`, hookError);
    }

    return { success: true, statusName: statusName };

  } catch (error) {
    console.error(`${MODULE_ID}: GM apply status error`, error);
    return { success: false, error: error.message };
  }
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